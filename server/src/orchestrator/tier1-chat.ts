// server/src/orchestrator/tier1-chat.ts
// Authoritative chat task lifecycle — Phase 1.
//
// Chat requests now route through AgentManager.executeAndWait(), creating
// a real AgentTask that enters the authoritative agent lifecycle:
//   Chat → AgentManager → Agent → Strategy → Model → Result → Chat
//
// The previous direct OpenRouter bypass (streamTier1Chat) is preserved as
// a deprecated fallback but is no longer called from the /chat route.
//
// Session history (conversation context) is preserved via the existing
// in-memory sessionHistories Map. History is passed to the agent via
// task.context.recentMessages and embedded in the task description so
// the single-shot strategy can include it in the model call.

import { config } from '../config.js';
import { makeEvent, broadcast } from '../ws/events.js';
import { getOrchestratorSettings } from './settings.js';
import type { OrchestratorMessage } from './engine.js';
import { agentManager } from '../orchestration/agent-manager.js';
import type { AgentTask, ExecutionMode, TaskPriority, TaskType } from '../types.js';
import type { TenantScope } from '../tenancy/scope.js';

// Session-scoped history for Tier 1 chat. We keep this in-memory because
// the directive says Tier 1 is "99% of the time" — storing every casual
// message in Postgres would be wasteful. The existing messages table
// still holds the messages if needed for plan generation; this is just
// a conversation-context cache for the LLM call.
interface SessionHistory {
  messages: OrchestratorMessage[];
}
const sessionHistories = new Map<string, SessionHistory>();

export function getSessionHistory(sessionId: string): OrchestratorMessage[] {
  return sessionHistories.get(sessionId)?.messages ?? [];
}

export function appendSessionMessage(sessionId: string, msg: OrchestratorMessage): void {
  let hist = sessionHistories.get(sessionId);
  if (!hist) {
    hist = { messages: [] };
    sessionHistories.set(sessionId, hist);
  }
  hist.messages.push(msg);
  // Cap history at 50 turns to avoid unbounded growth
  if (hist.messages.length > 50) {
    hist.messages = hist.messages.slice(-50);
  }
}

export function clearSessionHistory(sessionId: string): void {
  sessionHistories.delete(sessionId);
}

// ── Stream a Tier 1 chat completion ──────────────────────────────────────

const TIER1_SYSTEM_PROMPT = `You are the Code Siren assistant — a helpful, concise programming companion.
You handle casual questions, code explanations, exploration, and brainstorming.
You are NOT an agent. You do not write files. You do not run commands.
If the user wants something built, suggest they press "Start Project" to invoke the orchestrator.
Keep responses focused and clear. Use markdown formatting when it helps readability.`;

export async function streamTier1Chat(
  sessionId: string,
  userMessage: string,
  taskId: string,
  scope: TenantScope,
): Promise<void> {
  const settings = getOrchestratorSettings();
  const model = settings.tier1Model;

  if (!config.OPENROUTER_API_KEY) {
    // No OpenRouter key — emit a helpful stub response so the user sees
    // something rather than a silent failure.
    const stubText = `[Tier 1] I'd love to chat, but OPENROUTER_API_KEY is not set on the server.\n\nTo enable Tier 1 chat, set OPENROUTER_API_KEY in server/.env. Until then, you can still use the Agent Relay system by pressing "Start Project".`;
    broadcast(makeEvent('orchestrator:chunk' as any, {
      taskId, sessionId, type: 'text', content: stubText,
    }, scope));
    broadcast(makeEvent('orchestrator:complete' as any, { taskId, sessionId }, scope));
    return;
  }

  // Append user message to history
  appendSessionMessage(sessionId, { role: 'user', content: userMessage });

  const history = getSessionHistory(sessionId);
  const messages: OrchestratorMessage[] = [
    { role: 'system', content: TIER1_SYSTEM_PROMPT },
    ...history,
  ];

  const body = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: 8192,
    stream: true,
  };

  console.log(`[orchestrator:tier1] streaming chat via ${model} (session ${sessionId})`);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://code-siren.local',
        'X-Title': 'Code Siren Tier 1',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text();
      broadcast(makeEvent('orchestrator:error' as any, {
        taskId, sessionId,
        error: `Tier 1 chat failed: ${res.status} ${errText.slice(0, 200)}`,
      }, scope));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          // Append the assistant response to history for future turns
          appendSessionMessage(sessionId, { role: 'assistant', content: fullResponse });
          broadcast(makeEvent('orchestrator:complete' as any, { taskId, sessionId }, scope));
          return;
        }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            fullResponse += delta;
            broadcast(makeEvent('orchestrator:chunk' as any, {
              taskId, sessionId, type: 'text', content: delta,
            }, scope));
          }
        } catch {
          // skip malformed SSE line
        }
      }
    }

    // Stream ended without [DONE] — emit complete anyway
    if (fullResponse) {
      appendSessionMessage(sessionId, { role: 'assistant', content: fullResponse });
    }
    broadcast(makeEvent('orchestrator:complete' as any, { taskId, sessionId }, scope));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast(makeEvent('orchestrator:error' as any, { taskId, sessionId, error: msg }, scope));
  }
}

// ── Authoritative chat task lifecycle (Phase 1) ──────────────────────────
//
// This function replaces streamTier1Chat as the /chat route handler.
// It creates a real AgentTask and dispatches it through AgentManager's
// executeAndWait() — the authoritative agent task lifecycle.
//
// The agent (architect-agent by default) executes via the existing
// strategy dispatcher → model router → engine (stub/ollama/openrouter/etc).
// The response streams back to the frontend via the existing agent:chunk,
// agent:start, and agent:complete WS events — which ChatPanel already
// subscribes to (ChatPanel.tsx:75, 98, 119).
//
// Session history (conversation context) is preserved via the existing
// appendSessionMessage / getSessionHistory functions. History is passed
// to the agent via task.context.recentMessages and embedded in the task
// description so the single-shot strategy includes it in the model call.

const CHAT_AGENT_ID = 'architect-agent';

// Phase 2: workspace context received from the frontend.
// If not provided, rootPath falls back to a placeholder and activeFiles is empty.
// This is honest — the agent will know it has no workspace context rather than
// being given fabricated project information.
interface WorkspaceContext {
  workspaceRoot?: string;
  activeFile?: string;
  openFiles?: string[];
  activeFileContent?: string;  // Phase 2: live editor buffer (includes unsaved edits)
  selection?: {                 // Phase 4: live Monaco selection
    text: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

export async function runChatViaAgentManager(
  sessionId: string,
  userMessage: string,
  taskId: string,
  scopeOrLegacyUser?: TenantScope | string,
  workspaceContext?: WorkspaceContext,
): Promise<void> {
  // Only legacy in-process tests use the string form. HTTP routes always pass a
  // server-resolved scope. The derived project ID is neither persisted nor an
  // owned project, so a WebSocket client cannot subscribe to it.
  const scope: TenantScope = typeof scopeOrLegacyUser === 'string'
    ? {
      userId: scopeOrLegacyUser,
      projectId: `legacy-internal-${scopeOrLegacyUser}`,
    }
    : scopeOrLegacyUser ?? {
      userId: 'legacy-internal',
      projectId: 'legacy-internal-anonymous',
    };
  // 1. Append user message to session history (preserving conversation context)
  appendSessionMessage(sessionId, { role: 'user', content: userMessage });
  const history = getSessionHistory(sessionId);
  const recentHistory = history.slice(-10); // last 10 turns

  // 2. Resolve workspace identity — truthful, not fabricated
  //    If the frontend sent workspaceRoot, use it. Otherwise, use a
  //    placeholder and log the absence honestly.
  const rootPath = workspaceContext?.workspaceRoot ?? '/tmp/code-siren-chat';
  const activeFiles: string[] = [];
  if (workspaceContext?.activeFile) {
    activeFiles.push(workspaceContext.activeFile);
  }
  if (workspaceContext?.openFiles) {
    for (const f of workspaceContext.openFiles) {
      if (!activeFiles.includes(f)) activeFiles.push(f);
    }
  }

  if (!workspaceContext?.workspaceRoot) {
    console.warn(`[orchestrator:chat] no workspaceRoot in context — using placeholder ${rootPath} (task ${taskId})`);
  }

  // 3. Build task description — include conversation history for context.
  //    Phase 3: Live editor content is NO LONGER injected into the task
  //    description. Instead, it goes through task.context.liveEditorContent
  //    → ContextManager.assemble() → ContextBundle.openFiles →
  //    formatContextBundle() → system prompt. This gives ONE authoritative
  //    representation of the file, in the system prompt, preventing the
  //    model from receiving conflicting live and disk versions.
  const conversationContext = recentHistory.length > 1
    ? recentHistory.slice(0, -1)
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n')
      + '\n\nCurrent request:\n' + userMessage
    : userMessage;

  // 4. Create an authoritative AgentTask with real workspace identity.
  //    Phase 3: live editor content goes through task.context (not task.description)
  //    so ContextManager can use it as the authoritative source for the active file.
  const task: AgentTask = {
    id: taskId,
    projectId: scope.projectId,
    sessionId,
    agentId: CHAT_AGENT_ID,
    type: 'chat' as TaskType,
    description: conversationContext,
    context: {
      projectId: scope.projectId,
      rootPath,               // real workspace root (or honest placeholder)
      techStack: {},
      activeFiles,            // real open files from the editor
      recentMessages: recentHistory.map(m => m.content),
      userId: scope.userId,
      // Phase 3: live editor content — ContextManager uses this instead of
      // reading from disk for the active file. Precedence: live > disk > none.
      activeFilePath: workspaceContext?.activeFile,
      liveEditorContent: workspaceContext?.activeFileContent,
      // Phase 4: live editor selection — ContextManager includes this in
      // the ContextBundle as the active selection.
      selection: workspaceContext?.selection,
    },
    files: [],
    priority: 'normal' as TaskPriority,
    executionMode: 'single-shot' as ExecutionMode,
    origin: 'chat',
    createdAt: Date.now(),
  };

  console.log(`[orchestrator:chat] dispatching task ${taskId} via AgentManager (session ${sessionId}, agent=${CHAT_AGENT_ID}, rootPath=${rootPath}, activeFiles=${activeFiles.length}, hasLiveContent=${!!workspaceContext?.activeFileContent})`);

  // 4. Execute through the authoritative AgentManager lifecycle.
  //    executeAndWait() broadcasts:
  //      - agent:start (ChatPanel.tsx:75 — sets isGenerating=true)
  //      - agent:chunk (ChatPanel.tsx:98 — appends text to streaming bubble)
  //      - agent:complete (ChatPanel.tsx:119 — marks done)
  //      - agent:error (ChatPanel.tsx:128 — shows error notification)
  //    It also creates a trace (startTrace/completeTrace).
  //    It also broadcasts relay:milestone-start for non-voice tasks —
  //    we broadcast relay:milestone-complete afterward to reset relay state.
  const result = await agentManager.executeAndWait(task);

  // 5. Reset relay state — executeAndWait broadcasts relay:milestone-start
  //    for non-voice tasks. Broadcast relay:milestone-complete so
  //    RelayContext doesn't stay stuck in 'running' state.
  broadcast(makeEvent('relay:milestone-complete' as any, {
    planId: 'chat',
    milestoneId: task.id,
    summary: result.error
      ? `Chat task failed: ${result.error}`
      : 'Chat task completed',
  }, scope));

  // 6. Append assistant response to session history
  if (result.text) {
    appendSessionMessage(sessionId, { role: 'assistant', content: result.text });
  }

  // 7. Log result
  if (result.error) {
    console.error(`[orchestrator:chat] task ${taskId} failed: ${result.error}`);
  } else {
    console.log(`[orchestrator:chat] task ${taskId} completed via AgentManager (${result.text.length} chars)`);
  }
}
