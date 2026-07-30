// server/src/context/types.ts
// Context Manager — type definitions (Phase B, directive Section 1).
//
// The ContextBundle is the assembled, token-budget-aware context that every
// agent receives before its task is dispatched. It is attached to the
// AgentTask as an additive optional field (task.contextBundle) — no existing
// agent is REQUIRED to read it.
//
// Per directive Section 2, the sources are gathered in this priority order
// (highest first):
//   1. Active selection (always included in full — never truncated)
//   2. Currently open file(s) (always included in full — never truncated)
//   3. Recent conversation history (last N turns)
//   4. Relevant memory (top-K from MemoryEngine.search)
//   5. Project graph (one-hop imports of open files)
//
// Per directive Section 3, if the assembled bundle exceeds the token budget,
// sources are truncated in REVERSE priority order (project graph first, then
// lowest-scoring memory, then oldest conversation turns) — see budget.ts.

/**
 * A currently-open file with its full content loaded from disk.
 * `language` is inferred from the file extension (e.g. '.ts' → 'typescript').
 */
export interface OpenFile {
  path: string;
  content: string;
  language: string;
}

/**
 * The active text selection in the editor. Always included in full —
 * the budget truncation logic MUST NOT drop this.
 */
export interface ActiveSelection {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * One entry in the project graph: a file path + its direct imports (one hop).
 * `imports` are file paths (resolved relative to project root when possible)
 * or bare module names (e.g. 'react', 'express') for non-relative imports.
 */
export interface ProjectGraphNode {
  file: string;
  imports: string[];
}

/**
 * One turn in the conversation history. `role` is one of 'user' | 'assistant'
 * | 'system' | 'tool' (matching RouterMessage.role).
 */
export interface ConversationTurn {
  role: string;
  content: string;
}

/**
 * A memory result returned by MemoryEngine.search(). `source` is the
 * sourceType of the memory entry ('agent' | 'user' | 'file' | 'doc').
 */
export interface RelevantMemory {
  content: string;
  score: number;
  source: string;
}

/**
 * Token budget accounting for the assembled bundle.
 * - `max` is the budget for the bundle (NOT the model's full context window —
 *   it's already had the 25% response+system reserve subtracted off).
 * - `used` is the estimated token count of the bundle.
 * - `truncated` lists the source labels that were dropped or shortened to
 *   fit the budget (e.g. ['projectGraph', 'memory:3', 'memory:4', 'history:9']).
 */
export interface TokenBudget {
  max: number;
  used: number;
  truncated: string[];
}

/**
 * The fully-assembled context bundle. Constructed by ContextManager.assemble().
 */
export interface ContextBundle {
  openFiles: OpenFile[];
  selection: ActiveSelection | null;
  projectGraph: ProjectGraphNode[];
  conversationHistory: ConversationTurn[];
  relevantMemory: RelevantMemory[];
  tokenBudget: TokenBudget;
}

/**
 * Parameters for ContextManager.assemble().
 *
 * `userId` is sourced from `task.context.userId` by the caller
 * (AgentManager.send / executeAndWait) — never read from inside assemble()
 * itself, to keep the dependency direction clean.
 *
 * `agentId` is sourced from `task.agentId`.
 *
 * `task` is the full AgentTask — Context Manager reads task.description (for
 * the memory search query), task.context.activeFiles (paths), task.context.
 * rootPath (file-read base), task.context.recentMessages (basic history),
 * task.projectId (memory project-scoped filter).
 *
 * `modelId` is currently always passed as '' (empty string) by the caller
 * — the Model Router doesn't track per-model context window sizes yet
 * (directive Section 0 Finding 5). When empty/unknown, the budget module
 * uses a conservative 32K-token default and logs a warning.
 */
export interface AssembleParams {
  userId: string;
  agentId: string;
  task: import('../types.js').AgentTask;
  modelId: string;
}

/**
 * The ContextManager interface. Implemented by a singleton class in
 * manager.ts. Exposed as `contextManager` for AgentManager to call.
 */
export interface ContextManager {
  assemble(params: AssembleParams): Promise<ContextBundle>;
}
