// server/src/orchestrator/tier1-chat.ts
// Tier 1 free-chat routing — directive Section 1.2.
//
// When a session's tier === 'chat' (default), messages go through this
// module. It uses the existing OpenRouter engine with the user-selected
// Tier 1 model (from settings.tier1Model). NEVER calls AgentManager.send().
//
// Per directive Section 6: "Tier 1 chat NEVER calls AgentManager.send().
// Agents are exclusively activated by the relay execution loop."
//
// Returns a streaming response the same shape as existing agent:chunk
// WS events — the frontend needs no new rendering code. We emit
// orchestrator:chunk events (also added to types.ts) which the frontend
// wsClient.on() can listen for in the same pattern as agent:chunk.

import { config } from '../config.js';
import { makeEvent, broadcast } from '../ws/events.js';
import { getOrchestratorSettings } from './settings.js';
import type { OrchestratorMessage } from './engine.js';

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
): Promise<void> {
  const settings = getOrchestratorSettings();
  const model = settings.tier1Model;

  if (!config.OPENROUTER_API_KEY) {
    // No OpenRouter key — emit a helpful stub response so the user sees
    // something rather than a silent failure.
    const stubText = `[Tier 1] I'd love to chat, but OPENROUTER_API_KEY is not set on the server.\n\nTo enable Tier 1 chat, set OPENROUTER_API_KEY in server/.env. Until then, you can still use the Agent Relay system by pressing "Start Project".`;
    broadcast(makeEvent('orchestrator:chunk' as any, {
      taskId, sessionId, type: 'text', content: stubText,
    }));
    broadcast(makeEvent('orchestrator:complete' as any, { taskId, sessionId }));
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
    max_tokens: 2048,
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
      }));
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
          broadcast(makeEvent('orchestrator:complete' as any, { taskId, sessionId }));
          return;
        }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            fullResponse += delta;
            broadcast(makeEvent('orchestrator:chunk' as any, {
              taskId, sessionId, type: 'text', content: delta,
            }));
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
    broadcast(makeEvent('orchestrator:complete' as any, { taskId, sessionId }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast(makeEvent('orchestrator:error' as any, { taskId, sessionId, error: msg }));
  }
}
