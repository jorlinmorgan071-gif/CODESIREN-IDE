// server/src/orchestration/model-router.ts
// SINGLE Model Router. Picks the best available engine:
//   1. Ollama (local, offline-capable) — preferred when available
//   2. OpenRouter (cloud) — fallback when Ollama is down and API key is set
//   3. Stub — last resort (synthetic output, no LLM needed)
//
// Per directive Section 1: the donor project's local-runtime techniques become HOW
// the `offline → Ollama` branch is *built* — not a second router living next to it.

import { config } from '../config.js';
import type { EngineId, ModelRouterRequest, ModelRouterChunk, RouterMessage } from '../types.js';
import { OllamaEngine, checkOllamaAvailable } from './engines/ollama.js';
import { AnthropicEngine } from './engines/anthropic.js';
import { GroqEngine } from './engines/groq.js';

export interface InferenceEngine {
  id: EngineId;
  stream(req: ModelRouterRequest): AsyncGenerator<ModelRouterChunk>;
}

// ── Stub engine ──────────────────────────────────────────────────────────
// Streams a deterministic synthetic response so we can prove the end-to-end
// plumbing (AgentManager.send() → agent.execute() → model-router.stream() →
// agent:chunk WS event → UI) without any external API key.
//
// In Step 2 the stub also emits mode-shaped output so the react/codeact
// strategy loops actually exercise tool dispatch, LoopGuard, and the trace
// recorder. For 'react' it emits one Thought/Action/Action Input cycle then
// a Final Answer. For 'codeact' it emits a ```python block then a final
// answer. For 'single-shot' it emits a plain response.
class StubEngine implements InferenceEngine {
  id: EngineId = 'stub';

  async *stream(req: ModelRouterRequest): AsyncGenerator<ModelRouterChunk> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const userText = lastUser?.content ?? '(no user input)';
    const agentLine = `[${req.agentId}] routing domain=${req.domain} mode=${req.executionMode} engine=stub`;

    let body: string;
    // Detect whether this is the first turn (no Observation yet) or a follow-up
    // (the strategy fed back an Observation/Output/Result message).
    // The donor's react/codeact loops feed observations back as user messages.
    const isFollowUp = req.messages.length > 2 &&
      /(?:^Observation:|^Output:|^Result:)/m.test(req.messages[req.messages.length - 1]?.content ?? '');

    // Step 4: CAD-specific stub output. When the system prompt mentions build123d,
    // emit a valid build123d script that produces a 10mm cube with fillets.
    const systemPrompt = req.messages[0]?.content ?? '';
    const isBuild123dRequest = systemPrompt.includes('build123d') && systemPrompt.includes('export_stl');

    if (isBuild123dRequest) {
      // Emit a real build123d script that the sidecar can execute.
      // This proves the full CAD pipeline: LLM → script → sidecar → STL.
      // Simple box — the point is proving the pipeline, not CAD sophistication.
      body = [
        `Here's a build123d script for: ${userText.slice(0, 100)}\n`,
        '\n',
        '```python\n',
        'from build123d import *\n',
        '\n',
        'with BuildPart() as p:\n',
        '    Box(10, 10, 10)\n',
        '\n',
        'result_part = p.part\n',
        "export_stl(result_part, 'output.stl')\n",
        '```\n',
      ].join('');
    } else if (req.executionMode === 'react') {
      if (isFollowUp) {
        // Second turn — emit the Final Answer now that we have the calculator result.
        body = [
          agentLine + '\n',
          '\n',
          'Thought: I now know the answer. The calculator returned 84, so the test\n',
          'assertion should expect 84 from the redirect-count function.\n',
          'Final Answer: Use a unit test asserting `expect(redirect_count).toBe(84)`\n',
          'after running 12 batches of 7 redirects each. Cover the edge case where\n',
          `the original prompt was: "${userText.slice(0, 80)}".`,
        ].join('');
      } else {
        // First turn — emit the Action.
        body = [
          agentLine + '\n',
          '\n',
          'Thought: I should compute the arithmetic first to ground my test assertion.\n',
          'Action: calculator\n',
          'Action Input: {"expression":"12 * 7"}\n',
        ].join('');
      }
    } else if (req.executionMode === 'codeact') {
      if (isFollowUp) {
        // Second turn — code already ran, emit the Final Answer.
        body = [
          agentLine + '\n',
          '\n',
          'Thought: The output is 55. To verify this in a test, write a unit test\n',
          'that calls the function and asserts the result equals 55.\n',
          '\n',
          'Final Answer: The sum of squares from 1 to 5 is 55. Write a test like\n',
          '`expect(sum_of_squares(5)).toBe(55)` covering inputs 1, 5, and 0 (edge).\n',
          `Original prompt: "${userText.slice(0, 80)}".`,
        ].join('');
      } else {
        // First turn — emit the ```python block.
        body = [
          agentLine + '\n',
          '\n',
          'Let me compute the sum of squares 1..5 with a quick Python one-liner:\n',
          '\n',
          '```python\n',
          'print(sum(x*x for x in range(1, 6)))\n',
          '```\n',
        ].join('');
      }
    } else {
      // single-shot — plain response
      body = [
        agentLine + '\n',
        '\n',
        `I am the agent for domain ${req.domain}. I received your request:\n`,
        `"\n${userText}\n"\n`,
        '\n',
        'Step 0/2 end-to-end proof: this response was streamed token-by-token through\n',
        'AgentManager.send() → agent.execute() → dispatcher → ModelRouter.stream() →\n',
        'the single WebSocket server → the Chat Panel. No LLM API key was required.\n',
        '\n',
        'When OPENROUTER_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) is set,\n',
        'the router will pick a real engine instead. The offline→Ollama branch\n',
        '(directive Section 1) is wired up in a later step.\n',
      ].join('');
    }

    const segments = body.match(/[\s\S]{1,12}/g) ?? [body];
    for (const seg of segments) {
      await sleep(8);
      yield { delta: seg, done: false };
    }
    yield { delta: '', done: true };
  }
}

// ── OpenRouter engine (real LLM via gateway) ─────────────────────────────
// Activated only if OPENROUTER_API_KEY is set. Uses fetch + ReadableStream per
// PDF Section 20 streaming guidance.
class OpenRouterEngine implements InferenceEngine {
  id: EngineId = 'openrouter';

  async *stream(req: ModelRouterRequest): AsyncGenerator<ModelRouterChunk> {
    const model = pickModelForDomain(req.domain);
    const body = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 1024,
      stream: true,
    };
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://code-siren.local',
        'X-Title': 'Code Siren',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      yield { delta: `[router] OpenRouter error ${res.status}: ${await res.text()}`, done: false };
      yield { delta: '', done: true };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
          yield { delta: '', done: true };
          return;
        }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (delta) yield { delta, done: false };
        } catch {
          // skip malformed SSE line
        }
      }
    }
    yield { delta: '', done: true };
  }
}

function pickModelForDomain(domain: string): string {
  // PDF Section 02 routing intent: coding→DeepSeek, architecture→Claude,
  // docs→GPT, vision→GPT-4o Vision, offline→Ollama.
  switch (domain) {
    case 'ARCHITECT':
    case 'SECURITY':
    case 'REVIEW':
    case 'PERFORMANCE':
      return 'anthropic/claude-3.5-sonnet';
    case 'FRONTEND':
    case 'BACKEND':
    case 'QA':
      return 'deepseek/deepseek-coder';
    case 'DOCUMENTATION':
    case 'DEPLOYMENT':
      return 'openai/gpt-4o';
    default:
      return 'anthropic/claude-3.5-sonnet';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Router ───────────────────────────────────────────────────────────────

class ModelRouter {
  private engines = new Map<EngineId, InferenceEngine>();
  private preferredEngine: EngineId = 'stub';
  private ollamaChecked = false;

  constructor() {
    this.engines.set('stub', new StubEngine());
    this.engines.set('ollama', new OllamaEngine());

    if (config.OPENROUTER_API_KEY) {
      this.engines.set('openrouter', new OpenRouterEngine());
      console.log('[router] OpenRouter engine available (OPENROUTER_API_KEY set)');
    }
    // Phase A Section 6: register Anthropic + Groq engines when API keys are present.
    // These replace the old log-only detection — the engines are now real + usable.
    if (config.ANTHROPIC_API_KEY) {
      this.registerEngine(new AnthropicEngine());
    }
    if (config.GROQ_API_KEY) {
      this.registerEngine(new GroqEngine());
    }
    // OpenAI direct is detected but not implemented (low marginal value — OpenRouter covers it)
    if (config.OPENAI_API_KEY) console.log('[router] OPENAI_API_KEY detected (not implemented — use OpenRouter for OpenAI models)');

    // Check Ollama availability asynchronously — don't block startup
    this.initOllama();
  }

  private async initOllama(): Promise<void> {
    try {
      const check = await checkOllamaAvailable();
      this.ollamaChecked = true;
      if (check.available) {
        this.preferredEngine = 'ollama';
        console.log(`[router] Ollama available — ${check.models.length} model(s), preferred engine set to ollama`);
        if (check.models.length > 0) {
          console.log(`[router] Ollama models: ${check.models.map(m => m.name).join(', ')}`);
        }
      } else if (config.OPENROUTER_API_KEY) {
        this.preferredEngine = 'openrouter';
        console.log(`[router] Ollama not available (${check.error}), using OpenRouter as preferred engine`);
      } else {
        this.preferredEngine = 'stub';
        console.log(`[router] Ollama not available (${check.error}), no OpenRouter key — using stub engine`);
      }
    } catch (err: any) {
      console.log(`[router] Ollama check failed: ${err.message}`);
      this.preferredEngine = config.OPENROUTER_API_KEY ? 'openrouter' : 'stub';
    }
  }

  pickEngine(req: ModelRouterRequest): InferenceEngine {
    // Policy: Ollama → OpenRouter → stub
    // If Ollama hasn't been checked yet (cold start), try it first.
    // If it fails mid-stream, the OllamaEngine itself handles auto-start + error.

    // Check if the request has a specific engine preference (e.g. from the model picker)
    const requestedEngine = (req as any).engine as EngineId | undefined;
    if (requestedEngine && this.engines.has(requestedEngine)) {
      return this.engines.get(requestedEngine)!;
    }

    // Use the preferred engine determined at startup
    if (this.preferredEngine === 'ollama' && this.engines.has('ollama')) {
      return this.engines.get('ollama')!;
    }
    if (this.preferredEngine === 'openrouter' && this.engines.has('openrouter')) {
      return this.engines.get('openrouter')!;
    }

    // Fallback: try Ollama first (it might have come online since startup)
    if (!this.ollamaChecked && this.engines.has('ollama')) {
      return this.engines.get('ollama')!;
    }

    // Then OpenRouter
    if (this.engines.has('openrouter')) {
      return this.engines.get('openrouter')!;
    }

    // Last resort: stub
    return this.engines.get('stub')!;
  }

  /** Force a re-check of Ollama availability (e.g. after the user starts ollama serve). */
  async recheckEngines(): Promise<{ ollama: boolean; preferred: EngineId }> {
    await this.initOllama();
    return {
      ollama: this.preferredEngine === 'ollama',
      preferred: this.preferredEngine,
    };
  }

  getPreferredEngine(): EngineId {
    return this.preferredEngine;
  }

  /**
   * Phase A Section 6: register a custom engine at runtime.
   *
   * Minimal API — no validation, no health check, no priority change.
   * The engine is added to the map + can be selected via req.engine
   * (explicit selection). The existing priority chain (Ollama → OpenRouter
   * → stub) is unchanged.
   *
   * This is the public extension point for adding new providers without
   * modifying the ModelRouter class itself.
   */
  registerEngine(engine: InferenceEngine): void {
    this.engines.set(engine.id, engine);
    console.log(`[router] engine registered: ${engine.id}`);
  }

  /**
   * Check whether an engine is registered (used by tests + the engines API).
   */
  hasEngine(id: EngineId): boolean {
    return this.engines.has(id);
  }

  stream(req: ModelRouterRequest): AsyncGenerator<ModelRouterChunk> {
    const engine = this.pickEngine(req);
    console.log(`[router] engine=${engine.id} domain=${req.domain} mode=${req.executionMode} agent=${req.agentId}`);
    return engine.stream(req);
  }

  /**
   * Embed text using the same engine-preference pattern as stream().
   * Uses Ollama /api/embeddings when ollama is active, OpenAI text-embedding-3-small
   * when openrouter/openai key is set. Falls back to a hash-based pseudo-embedding
   * for the stub engine (deterministic, 768 dims — same as pgvector column).
   *
   * This is NOT a third routing system — it reuses the same engine selection
   * as stream(), just calling the embedding endpoint instead of chat.
   */
  async embed(text: string): Promise<number[]> {
    const text_ = text.slice(0, 8000); // truncate to avoid token limits

    // Try Ollama embeddings first (if ollama is the preferred engine)
    if (this.preferredEngine === 'ollama') {
      try {
        const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
        const model = process.env.OLLAMA_EMBED_MODEL ?? process.env.OLLAMA_DEFAULT_MODEL ?? 'llama3.2';
        const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: text_ }),
        });
        if (res.ok) {
          const data = await res.json() as { embedding?: number[] };
          if (data.embedding && data.embedding.length > 0) {
            // Pad or truncate to 768 dims to match the pgvector column
            return padTo768(data.embedding);
          }
        }
      } catch { /* fall through to OpenAI */ }
    }

    // Try OpenAI embeddings (if key is set)
    if (config.OPENAI_API_KEY || config.OPENROUTER_API_KEY) {
      try {
        const key = config.OPENAI_API_KEY ?? config.OPENROUTER_API_KEY!;
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
          },
          body: JSON.stringify({ model: 'text-embedding-3-small', input: text_ }),
        });
        if (res.ok) {
          const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
          if (data.data?.[0]?.embedding) {
            return padTo768(data.data[0].embedding);
          }
        }
      } catch { /* fall through to stub */ }
    }

    // Stub: hash-based pseudo-embedding (deterministic, 768 dims)
    return pseudoEmbed(text_);
  }
}

/**
 * Pad or truncate an embedding vector to 768 dimensions (matching the pgvector column).
 */
function padTo768(vec: number[]): number[] {
  if (vec.length === 768) return vec;
  if (vec.length > 768) return vec.slice(0, 768);
  return [...vec, ...new Array(768 - vec.length).fill(0)];
}

/**
 * Pseudo-embedding for the stub engine — deterministic hash-based vector.
 * Not semantically meaningful, but allows the Memory Engine to work end-to-end
 * without a real LLM. When Ollama/OpenAI is available, real embeddings are used.
 */
function pseudoEmbed(text: string): number[] {
  const vec = new Array(768).fill(0);
  // Simple hash-based pseudo-embedding: distribute hash values across dimensions
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    vec[i % 768] += (charCode / 128) - 0.5;
  }
  // Normalize to unit length
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

export const modelRouter = new ModelRouter();
