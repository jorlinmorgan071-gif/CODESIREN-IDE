// server/src/context/budget.ts
// Token budgeting for the Context Manager (Phase B, directive Section 3).
//
// Policy (verbatim from directive Section 3):
//   - Look up modelId's context window from Model Router. If unavailable,
//     default to 32K tokens and log a warning — fail closed to a
//     conservative number, never assume unlimited.
//   - Reserve 25% of the context window for response + system prompt
//     overhead. Remaining 75% is the budget for the ContextBundle.
//   - If assembled context exceeds budget, truncate in REVERSE priority
//     order from Section 2 (drop project graph first, then oldest
//     conversation turns, then lowest-scoring memory results — NEVER
//     truncate the active selection or the currently open file).
//   - Record what was truncated in tokenBudget.truncated.
//   - Use a simple token estimator (chars/4 heuristic) unless a tokenizer
//     dependency already exists for another purpose.

import type {
  ContextBundle,
  ConversationTurn,
  OpenFile,
  ProjectGraphNode,
  RelevantMemory,
  TokenBudget,
} from './types.js';

// ── DEFAULT_MODEL_CONTEXT_WINDOWS ────────────────────────────────────────
//
// ⚠️  STOPGAP — NOT VERIFIED FACT. ⚠️
//
// This is a HARDCODED CONVENIENCE MAP, NOT data sourced from Model Router
// itself. The Model Router (server/src/orchestration/model-router.ts) does
// not currently track per-model context window sizes — it only knows how
// to ROUTE to an engine (stub/ollama/openrouter) by domain.
//
// The values below are the published context window sizes for the three
// models that pickModelForDomain() in model-router.ts can return. They were
// correct as of 2024-Q4 vendor documentation, but vendors change these
// numbers (sometimes silently). Treat this as a stopgap:
//
//   - When a future phase adds a proper model registry (or queries the
//     OpenRouter /models API at boot time), this map should be replaced
//     with the registry's values, NOT kept as a duplicate.
//   - If `modelId` passed to computeBudget() is falsy OR not in this map,
//     we fall back to DEFAULT_FALLBACK_CONTEXT_WINDOW (32K) and log a
//     warning. This is the fail-closed behavior mandated by the directive.
//   - We deliberately never assume unlimited context — silently allowing
//     an arbitrarily large bundle would cause real-world LLM 400 errors
//     later in the pipeline, which is much worse than a suboptimal
//     truncation here.
const DEFAULT_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'anthropic/claude-3.5-sonnet': 200_000,
  'deepseek/deepseek-coder': 128_000,
  'openai/gpt-4o': 128_000,
};

/** Conservative fallback when modelId is unknown/unavailable. */
export const DEFAULT_FALLBACK_CONTEXT_WINDOW = 32_000;

/** Fraction of the context window reserved for the LLM response + system prompt. */
export const RESPONSE_RESERVE_FRACTION = 0.25;

/**
 * Look up the model's context window size (in tokens). Returns the
 * fallback (32K) and logs a warning if the modelId is unknown.
 */
export function lookupContextWindow(modelId: string): number {
  if (modelId && DEFAULT_MODEL_CONTEXT_WINDOWS[modelId]) {
    return DEFAULT_MODEL_CONTEXT_WINDOWS[modelId];
  }
  if (modelId) {
    console.warn(
      `[context:budget] unknown modelId "${modelId}" — using fallback of ${DEFAULT_FALLBACK_CONTEXT_WINDOW} tokens (fail-closed)`,
    );
  } else {
    // Empty modelId is the EXPECTED case in Phase B (AgentTask doesn't carry
    // a modelId yet — see directive Section 0 Finding 5). We still log a
    // warning so the trace is honest, but at info-level, not warn.
    console.log(
      `[context:budget] no modelId provided — using fallback of ${DEFAULT_FALLBACK_CONTEXT_WINDOW} tokens (fail-closed, expected in Phase B)`,
    );
  }
  return DEFAULT_FALLBACK_CONTEXT_WINDOW;
}

/**
 * Compute the token budget for the ContextBundle given the model's full
 * context window. Per directive Section 3: reserve 25% for response +
 * system prompt, the remaining 75% is the bundle budget.
 */
export function computeBundleBudget(modelId: string): number {
  const fullWindow = lookupContextWindow(modelId);
  const bundleBudget = Math.floor(fullWindow * (1 - RESPONSE_RESERVE_FRACTION));
  return bundleBudget;
}

// ── Token estimator (chars/4 heuristic) ──────────────────────────────────
//
// Per directive Section 3: "Use a simple token estimator (chars/4 heuristic)
// unless a tokenizer dependency already exists for another purpose."
//
// No tokenizer dependency exists in the codebase (verified via package.json
// inspection during Section 0). The chars/4 heuristic is a well-known
// approximation that works well for English-language code and prose, with
// a slight over-estimate bias (which is conservative — better to truncate
// a bit too much than to overflow the model's window).

/**
 * Estimate the token count of a string using the chars/4 heuristic.
 * Returns at least 1 for any non-empty string (avoids div-by-zero weirdness
 * in budget calculations).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Estimate the token count of an OpenFile (path + content + language header).
 */
export function estimateOpenFileTokens(file: OpenFile): number {
  // The header overhead is small but real when this gets serialized into a
  // prompt later — account for it.
  return estimateTokens(file.path) + estimateTokens(file.language) + estimateTokens(file.content) + 8;
}

/**
 * Estimate the token count of an ActiveSelection.
 */
export function estimateSelectionTokens(sel: { path: string; text: string }): number {
  return estimateTokens(sel.path) + estimateTokens(sel.text) + 12;
}

/**
 * Estimate the token count of a ConversationTurn.
 */
export function estimateConversationTurnTokens(turn: ConversationTurn): number {
  return estimateTokens(turn.role) + estimateTokens(turn.content) + 8;
}

/**
 * Estimate the token count of a RelevantMemory entry.
 */
export function estimateMemoryTokens(mem: RelevantMemory): number {
  return estimateTokens(mem.content) + estimateTokens(mem.source) + 12;
}

/**
 * Estimate the token count of a ProjectGraphNode.
 */
export function estimateProjectGraphNodeTokens(node: ProjectGraphNode): number {
  let sum = estimateTokens(node.file) + 8;
  for (const imp of node.imports) {
    sum += estimateTokens(imp) + 4;
  }
  return sum;
}

// ── Truncation logic ─────────────────────────────────────────────────────
//
// Per directive Section 3, when the assembled bundle exceeds the budget,
// truncate in REVERSE priority order:
//   1. Drop projectGraph first (lowest priority)
//   2. Then drop OLDEST conversation turns (history is mid-priority — keep
//      the most recent N turns)
//   3. Then drop LOWEST-SCORING memory results (memory is mid-priority —
//      keep the highest-scoring entries)
//   4. NEVER truncate active selection or currently-open files — these
//      are the highest-priority sources and are always included in full
//
// The selection and openFiles fields are guaranteed to be preserved; if
// even those alone exceed the budget, the bundle is returned with used > max
// and a `truncated` entry noting that the hard floor was hit. This is the
// honest behavior — better to dispatch an over-budget bundle (the LLM may
// still handle it gracefully) than to silently drop the user's selection.

/**
 * The result of applying truncation to a bundle. `bundle` is the (possibly
 * truncated) bundle, and `tokenBudget.truncated` lists what was dropped.
 */
export interface TruncationResult {
  bundle: ContextBundle;
  tokenBudget: TokenBudget;
}

/**
 * Apply the budget truncation policy to a fully-assembled ContextBundle.
 *
 * Mutates nothing — returns a new bundle with the truncation applied.
 *
 * The input bundle's `tokenBudget` field is IGNORED (it's recomputed from
 * scratch here). The `truncated` list is built fresh from this run.
 */
export function applyBudget(
  bundle: ContextBundle,
  maxBudget: number,
): TruncationResult {
  const truncated: string[] = [];

  // Start with the immutable floor: selection + openFiles.
  const selection = bundle.selection;
  const openFiles = [...bundle.openFiles];

  // Mutable working copies of the truncate-able sources.
  let projectGraph = [...bundle.projectGraph];
  let conversationHistory = [...bundle.conversationHistory];
  let relevantMemory = [...bundle.relevantMemory];

  /**
   * Compute the current total token count of the working bundle.
   */
  const computeUsed = (): number => {
    let sum = 0;
    if (selection) sum += estimateSelectionTokens(selection);
    for (const f of openFiles) sum += estimateOpenFileTokens(f);
    for (const turn of conversationHistory) sum += estimateConversationTurnTokens(turn);
    for (const mem of relevantMemory) sum += estimateMemoryTokens(mem);
    for (const node of projectGraph) sum += estimateProjectGraphNodeTokens(node);
    return sum;
  };

  let used = computeUsed();

  // If already under budget, return as-is (with a clean tokenBudget).
  if (used <= maxBudget) {
    return {
      bundle: {
        selection,
        openFiles,
        projectGraph,
        conversationHistory,
        relevantMemory,
        tokenBudget: { max: maxBudget, used, truncated },
      },
      tokenBudget: { max: maxBudget, used, truncated },
    };
  }

  // ── Stage 1: drop project graph entirely (lowest priority) ──────────
  if (used > maxBudget && projectGraph.length > 0) {
    const droppedCount = projectGraph.length;
    projectGraph = [];
    truncated.push(`projectGraph (${droppedCount} nodes)`);
    used = computeUsed();
  }

  // ── Stage 2: drop oldest conversation turns one-by-one ──────────────
  // conversationHistory is ordered oldest-first (per manager.ts). Drop from
  // the FRONT of the array to keep the most recent turns.
  while (used > maxBudget && conversationHistory.length > 0) {
    const dropped = conversationHistory.shift();
    if (dropped) {
      const preview = dropped.content.slice(0, 30).replace(/\s+/g, ' ');
      truncated.push(`history: "${preview}..."`);
    }
    used = computeUsed();
  }

  // ── Stage 3: drop lowest-scoring memory results one-by-one ─────────
  // relevantMemory is ordered highest-score-first (per manager.ts, which
  // returns MemoryEngine.search results in that order). Drop from the END
  // of the array to keep the highest-scoring entries.
  while (used > maxBudget && relevantMemory.length > 0) {
    const dropped = relevantMemory.pop();
    if (dropped) {
      truncated.push(`memory: score=${dropped.score.toFixed(3)} "${dropped.content.slice(0, 30).replace(/\s+/g, ' ')}..."`);
    }
    used = computeUsed();
  }

  // ── Stage 4: hard floor reached — selection and openFiles are preserved ─
  // If we reach here, used is still > maxBudget. We do NOT truncate the
  // selection or openFiles — they are the user's explicit context. Log
  // this honestly in `truncated`.
  if (used > maxBudget) {
    truncated.push(`HARD FLOOR — selection + openFiles alone exceed budget (used=${used}, max=${maxBudget}); dispatched over-budget rather than dropping user context`);
  }

  return {
    bundle: {
      selection,
      openFiles,
      projectGraph,
      conversationHistory,
      relevantMemory,
      tokenBudget: { max: maxBudget, used, truncated },
    },
    tokenBudget: { max: maxBudget, used, truncated },
  };
}
