// server/src/context/manager.ts
// ContextManager singleton — Phase B, directive Section 1.
//
// This module is a PLAIN CLASS, not a new IAgent, not a new row in the agent
// registry. It is called inside AgentManager.send() / executeAndWait(),
// BEFORE the task reaches the target agent.
//
// Per directive Section 4, the call site in AgentManager is:
//   - additive (existing callers keep working unchanged)
//   - 2-second timeout
//   - FAIL-OPEN on error (deliberate exception — see call-site comment in
//     agent-manager.ts for the rationale)
//
// Per directive Section 2, the 5 sources are gathered in priority order:
//   1. Active selection (always included in full — never truncated)
//   2. Currently open file(s) (always included in full — never truncated)
//   3. Recent conversation history (last N turns, default N=10)
//   4. Relevant memory (top-K from MemoryEngine.search, default K=5)
//   5. Project graph (one-hop imports of open files)
//
// Per directive Section 3, token budget is enforced by budget.ts:
//   - Look up modelId's context window (default 32K + warning if unknown)
//   - Reserve 25% for response + system prompt
//   - Truncate in reverse priority order if over budget
//
// This module does NOT modify MemoryEngine's internal recall()/memorize()
// logic — it CALLS memoryEngine.search(), per directive Section 0 Finding 3.

import { readFileSync, existsSync } from 'node:fs';
import { memoryEngine } from '../memory/engine.js';
import { resolveContainedWorkspacePath } from '../workspace/service.js';
import { scanProjectGraph, inferLanguage } from './project-graph.js';
import {
  computeBundleBudget,
  applyBudget,
} from './budget.js';
import type {
  ContextBundle,
  ContextManager as IContextManager,
  AssembleParams,
  OpenFile,
  ActiveSelection,
  ConversationTurn,
  RelevantMemory,
  ProjectGraphNode,
} from './types.js';

// ── Configurable defaults (directive Section 2) ──────────────────────────

/** Last N turns of conversation history (directive Section 2 #3, default N=10). */
export const DEFAULT_HISTORY_TURNS = 10;

/** Top-K memory results (directive Section 2 #4, default K=5). */
export const DEFAULT_MEMORY_LIMIT = 5;

class ContextManagerImpl implements IContextManager {
  /**
   * Assemble a ContextBundle for the given task. Per directive Section 4,
   * this is called inside AgentManager.send() / executeAndWait() with a
   * 2-second outer timeout (enforced by the caller, not here — the caller
   * uses Promise.race to enforce the deadline).
   *
   * On internal failure, this method throws — the caller catches and
   * dispatches an empty/minimal bundle (fail-open).
   */
  async assemble(params: AssembleParams): Promise<ContextBundle> {
    const { userId, agentId, task, modelId } = params;
    void agentId;

    const projectRoot = task.context.rootPath;
    const activeFilePaths = task.context.activeFiles ?? [];
    const recentMessages = task.context.recentMessages ?? [];

    // ── Source 1: Active selection ─────────────────────────────────────
    // Phase 4: Read selection from task.context.selection (set by
    // runChatViaAgentManager from the frontend's live Monaco selection).
    // If not provided, selection is null (no selection — truthful).
    const taskSelection = task.context.selection;
    const activeFilePath = task.context.activeFilePath;
    let selection: ActiveSelection | null = null;
    if (taskSelection && activeFilePath) {
      selection = {
        path: activeFilePath,
        startLine: taskSelection.startLine,
        startColumn: taskSelection.startColumn,
        endLine: taskSelection.endLine,
        endColumn: taskSelection.endColumn,
        text: taskSelection.text,
      };
    }

    // ── Source 2: Open file(s) — read content from disk ───────────────
    // Phase 3: Live editor content takes precedence over disk content.
    // When task.context.liveEditorContent exists for task.context.activeFilePath,
    // use it instead of reading from disk. This prevents the model from
    // receiving conflicting live and stale-disk versions of the same file.
    // Precedence: 1) liveEditorContent (authoritative), 2) disk content (fallback), 3) skip
    const liveContent = task.context.liveEditorContent;
    const liveFilePath = task.context.activeFilePath;
    const openFiles: OpenFile[] = [];
    for (const filePath of activeFilePaths) {
      // Phase 3: If this file has live editor content, use it (not disk)
      if (liveContent && liveFilePath && filePath === liveFilePath) {
        openFiles.push({
          path: filePath,
          content: liveContent,
          language: inferLanguage(filePath),
        });
        continue;  // Skip disk read — live content is authoritative
      }
      // Fallback: read from disk
      let fullPath: string;
      try {
        fullPath = resolveContainedWorkspacePath(projectRoot, filePath, { mustExist: true });
      } catch {
        console.warn(`[context:manager] rejected workspace path: ${filePath}`);
        continue;
      }
      if (!existsSync(fullPath)) {
        console.warn(`[context:manager] open file not found on disk: ${filePath} (skipping)`);
        continue;
      }
      try {
        const content = readFileSync(fullPath, 'utf8');
        openFiles.push({
          path: filePath,
          content,
          language: inferLanguage(filePath),
        });
      } catch (err: any) {
        console.warn(`[context:manager] failed to read open file ${filePath}: ${err.message} (skipping)`);
      }
    }

    // ── Source 3: Conversation history — last N turns ─────────────────
    // ProjectContext.recentMessages is `string[]` (no role info). We treat
    // each as a 'user' turn — the orchestrator-level chat (which has
    // structured roles) lives in a different code path. This is a known
    // limitation, documented here for future revisitors.
    const historyLimit = DEFAULT_HISTORY_TURNS;
    const conversationHistory: ConversationTurn[] = recentMessages
      .slice(-historyLimit) // last N (most recent)
      .map(msg => ({ role: 'user', content: msg }));

    // ── Source 4: Relevant memory — call MemoryEngine.search() ────────
    // Per directive Section 0 Finding 3: the method is `search()`, not
    // `recall()`. We pass task.description as the query (it's the user's
    // request text — best semantic hook we have), top-K results, scoped
    // to task.projectId.
    let relevantMemory: RelevantMemory[] = [];
    try {
      const memLimit = DEFAULT_MEMORY_LIMIT;
      const memoryResults = await memoryEngine.search(
        task.description,
        memLimit,
        userId && userId !== 'unknown' ? { userId, projectId: task.projectId, sessionId: task.sessionId } : undefined,
      );
      relevantMemory = memoryResults.map(chunk => ({
        content: chunk.content,
        score: chunk.score,
        source: String(chunk.metadata?.sourceType ?? 'unknown'),
        quality: chunk.quality,
        provenance: chunk.provenance,
      }));
    } catch (err: any) {
      // Memory search failed — log and continue with empty memory.
      // This is NOT a fatal error for context assembly; the bundle can
      // still be useful without memory. (The directive's fail-open
      // behavior at the AgentManager call site is the outer guard; this
      // inner try/catch is a finer-grained degradation.)
      console.warn(`[context:manager] memory search failed: ${err.message} (continuing without memory)`);
    }

    // ── Source 5: Project graph — one-hop imports of open files ───────
    // Per directive Section 2 #5: "If no project-graph builder exists yet,
    // implement a minimal one via regex/require parsing" — implemented
    // in project-graph.ts. Only the open files' direct imports are
    // included (one hop, not the whole repo graph).
    let projectGraph: ProjectGraphNode[];
    try {
      projectGraph = scanProjectGraph(activeFilePaths, projectRoot);
    } catch (err: any) {
      // Project graph scan failed — log and continue with empty graph.
      console.warn(`[context:manager] project graph scan failed: ${err.message} (continuing without graph)`);
      projectGraph = [];
    }

    // ── Assemble the bundle and apply token budget ────────────────────
    const maxBudget = computeBundleBudget(modelId);

    // Pre-budget bundle (tokenBudget field will be recomputed by applyBudget)
    const preBudgetBundle: ContextBundle = {
      openFiles,
      selection,
      projectGraph,
      conversationHistory,
      relevantMemory,
      tokenBudget: { max: maxBudget, used: 0, truncated: [] },
    };

    const { bundle } = applyBudget(preBudgetBundle, maxBudget);
    return bundle;
  }
}

/**
 * Singleton instance. Exported for AgentManager to import.
 */
export const contextManager: IContextManager = new ContextManagerImpl();

// Re-export the type for callers that need it
export type { ContextBundle, AssembleParams } from './types.js';
