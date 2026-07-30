// server/src/orchestrator/engine.ts
// OrchestratorEngine — directive Section 1.1.
//
// Two implementations share one interface:
//   - GeminiFlashOrchestrator — Google AI Studio (gemini-2.5-flash)
//   - NvidiaOrchestrator      — OpenRouter (nvidia/llama-3.1-nemotron-ultra-253b-v1:free)
//
// Both implement exponential backoff on 429s. Both never speak directly to
// the user — they return strings that the relay loop parses as JSON decisions
// or that the plan endpoint surfaces in the Plan Review panel.
//
// Per directive Section 6: this is a NEW module. It does NOT touch IAgent,
// does NOT touch Ghost Mode's FSM, does NOT touch the existing ModelRouter.
// The orchestrator is a background system that reviews files and writes
// structured JSON decisions.

import { config } from '../config.js';

// ── Types ────────────────────────────────────────────────────────────────

export type OrchestratorEngineId = 'gemini-flash' | 'nvidia-nemotron';

export interface OrchestratorMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OrchestratorEngine {
  id: OrchestratorEngineId;
  /** Synchronous chat — returns the full response string. */
  chat(messages: OrchestratorMessage[]): Promise<string>;
  /** Streaming chat — yields deltas. The final aggregated string is the same shape as chat(). */
  stream(messages: OrchestratorMessage[]): AsyncGenerator<string>;
}

// ── Backoff helper ───────────────────────────────────────────────────────
// Exponential delay: 2s, 4s, 8s. Per directive Section 6: "if a 429 is
// received, back off with exponential delay (2s, 4s, 8s) before retrying.
// Log the backoff clearly so the user knows why there's a pause."

const BACKOFF_DELAYS_MS = [2_000, 4_000, 8_000];
const MAX_RETRIES = BACKOFF_DELAYS_MS.length;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(status: number): boolean {
  // 429 = rate limit. 500/502/503/504 = transient server errors worth one retry.
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// ── GeminiFlashOrchestrator ──────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export class GeminiFlashOrchestrator implements OrchestratorEngine {
  id: OrchestratorEngineId = 'gemini-flash';

  constructor(private apiKey: string) {
    if (!apiKey) throw new Error('GeminiFlashOrchestrator: GEMINI_API_KEY is required');
  }

  async chat(messages: OrchestratorMessage[]): Promise<string> {
    // Gemini's API expects `contents` with role `user`/`model`. System
    // messages get hoisted into a `systemInstruction` field.
    const systemInstruction = messages.find((m) => m.role === 'system')?.content;
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',  // ask Gemini to return valid JSON
      },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${GEMINI_ENDPOINT}?key=${this.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (res.status === 429 && attempt < MAX_RETRIES) {
          const delay = BACKOFF_DELAYS_MS[attempt];
          console.log(`[orchestrator:gemini] 429 rate limit — backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }
        if (!res.ok) {
          const text = await res.text();
          if (isRetryable(res.status) && attempt < MAX_RETRIES) {
            const delay = BACKOFF_DELAYS_MS[attempt];
            console.log(`[orchestrator:gemini] ${res.status} — backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
            await sleep(delay);
            continue;
          }
          throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
        }

        const data = await res.json() as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          error?: { message?: string };
        };
        if (data.error?.message) throw new Error(`Gemini error: ${data.error.message}`);
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Gemini returned empty response');
        return text;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        // Network errors are retryable
        if (attempt < MAX_RETRIES) {
          const delay = BACKOFF_DELAYS_MS[attempt];
          console.log(`[orchestrator:gemini] ${lastErr.message} — backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }
      }
    }
    throw lastErr ?? new Error('Gemini: exhausted retries');
  }

  async *stream(messages: OrchestratorMessage[]): AsyncGenerator<string> {
    // Gemini non-streaming returns the full response at once; we yield it as
    // a single chunk. True streaming (streamGenerateContent) would split
    // this into token-sized deltas, but for the orchestrator's use case
    // (single JSON response) the user only sees the parsed result anyway.
    const full = await this.chat(messages);
    yield full;
  }
}

// ── NvidiaOrchestrator ───────────────────────────────────────────────────
// Uses OpenRouter's chat completions API with a free NVIDIA Nemotron model.
// Per directive Section 1.1: "confirm this is the current model string —
// search OpenRouter's free models list before hardcoding it."
//
// Last verified 2026-07-25 via:
//   curl 'https://openrouter.ai/api/v1/models' | \
//   jq '.data[] | select(.id | test("nvidia"; "i")) | select(.pricing.prompt == "0") | .id'
//
// The old model "nvidia/llama-3.1-nemotron-ultra-253b-v1:free" has been
// retired. The current top-tier free NVIDIA model is Nemotron 3 Ultra
// (550B params total, 55B active, 1M context) — the successor to the
// Ultra 253B. If this ID is retired in the future, re-run the curl
// command above and pick the largest available Nemotron Ultra/Super.

const NVIDIA_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

export class NvidiaOrchestrator implements OrchestratorEngine {
  id: OrchestratorEngineId = 'nvidia-nemotron';

  constructor(private apiKey: string) {
    if (!apiKey) throw new Error('NvidiaOrchestrator: OPENROUTER_API_KEY is required');
  }

  async chat(messages: OrchestratorMessage[]): Promise<string> {
    const body = {
      model: NVIDIA_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 4096,
      stream: false,
    };

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'HTTP-Referer': 'https://code-siren.local',
            'X-Title': 'Code Siren Orchestrator',
          },
          body: JSON.stringify(body),
        });

        if (res.status === 429 && attempt < MAX_RETRIES) {
          const delay = BACKOFF_DELAYS_MS[attempt];
          console.log(`[orchestrator:nvidia] 429 rate limit — backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }
        if (!res.ok) {
          const text = await res.text();
          if (isRetryable(res.status) && attempt < MAX_RETRIES) {
            const delay = BACKOFF_DELAYS_MS[attempt];
            console.log(`[orchestrator:nvidia] ${res.status} — backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
            await sleep(delay);
            continue;
          }
          throw new Error(`NVIDIA/OpenRouter ${res.status}: ${text.slice(0, 200)}`);
        }

        const data = await res.json() as {
          choices?: Array<{ message?: { content?: string } }>;
          error?: { message?: string };
        };
        if (data.error?.message) throw new Error(`OpenRouter error: ${data.error.message}`);
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('NVIDIA Nemotron returned empty response');
        return text;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          const delay = BACKOFF_DELAYS_MS[attempt];
          console.log(`[orchestrator:nvidia] ${lastErr.message} — backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }
      }
    }
    throw lastErr ?? new Error('NVIDIA: exhausted retries');
  }

  async *stream(messages: OrchestratorMessage[]): AsyncGenerator<string> {
    // Same pattern as Gemini — non-streaming yield. The orchestrator's
    // output is always parsed as JSON, so token-by-token streaming adds
    // no value to the user experience.
    const full = await this.chat(messages);
    yield full;
  }
}

// ── Engine registry (singleton) ──────────────────────────────────────────

let activeEngineId: OrchestratorEngineId = 'nvidia-nemotron';
const engineCache = new Map<OrchestratorEngineId, OrchestratorEngine>();

function buildEngine(id: OrchestratorEngineId): OrchestratorEngine {
  switch (id) {
    case 'gemini-flash':
      if (!config.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY not set — cannot use Gemini Flash orchestrator');
      }
      return new GeminiFlashOrchestrator(config.GEMINI_API_KEY);
    case 'nvidia-nemotron':
      if (!config.OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY not set — cannot use NVIDIA Nemotron orchestrator');
      }
      return new NvidiaOrchestrator(config.OPENROUTER_API_KEY);
  }
}

export function getOrchestratorEngine(): OrchestratorEngine {
  // Try the active engine first
  const cached = engineCache.get(activeEngineId);
  if (cached) return cached;

  try {
    const eng = buildEngine(activeEngineId);
    engineCache.set(activeEngineId, eng);
    return eng;
  } catch (err) {
    // If the active engine's keys aren't available, fall back to whichever
    // engine IS configured. This prevents the orchestrator from being
    // completely unusable in dev environments where only one key is set.
    console.warn(`[orchestrator] active engine ${activeEngineId} unavailable: ${err instanceof Error ? err.message : err}`);
    const fallbackId: OrchestratorEngineId = activeEngineId === 'gemini-flash' ? 'nvidia-nemotron' : 'gemini-flash';
    const fallbackCached = engineCache.get(fallbackId);
    if (fallbackCached) return fallbackCached;
    const eng = buildEngine(fallbackId);
    engineCache.set(fallbackId, eng);
    activeEngineId = fallbackId;
    return eng;
  }
}

export function setActiveOrchestratorEngine(id: OrchestratorEngineId): void {
  activeEngineId = id;
}

export function getActiveOrchestratorEngineId(): OrchestratorEngineId {
  return activeEngineId;
}

export function listAvailableEngines(): Array<{ id: OrchestratorEngineId; available: boolean; reason?: string }> {
  return [
    {
      id: 'gemini-flash',
      available: !!config.GEMINI_API_KEY,
      reason: config.GEMINI_API_KEY ? undefined : 'GEMINI_API_KEY not set',
    },
    {
      id: 'nvidia-nemotron',
      available: !!config.OPENROUTER_API_KEY,
      reason: config.OPENROUTER_API_KEY ? undefined : 'OPENROUTER_API_KEY not set',
    },
  ];
}
