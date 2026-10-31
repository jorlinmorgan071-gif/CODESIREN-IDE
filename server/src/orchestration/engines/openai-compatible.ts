// server/src/orchestration/engines/openai-compatible.ts
// Generic OpenAI-compatible inference engine.
//
// Most LLM providers (DeepSeek, Moonshot, Qwen, Mistral, etc.) expose
// an OpenAI-compatible API: POST /v1/chat/completions with streaming SSE.
// This single engine class handles ALL of them — no need for 15 separate
// engine classes.

import type { EngineId, ModelRouterRequest, ModelRouterChunk, RouterMessage } from '../../types.js';
import type { InferenceEngine } from '../model-router.js';
import { isRetryableStatus, sleep } from './_retry.js';
import { getProvider } from '../../provider-registry/registry.js';

interface OpenAICompatibleConfig {
  id: string;
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
}

const MAX_RETRIES = 3;
const BACKOFF_DELAYS_MS = [2_000, 4_000, 8_000];

export class OpenAICompatibleEngine implements InferenceEngine {
  id: EngineId;
  private apiUrl: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(config: { id: EngineId; apiUrl: string; apiKey: string; defaultModel: string }) {
    this.id = config.id;
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
  }

  async *stream(req: ModelRouterRequest): AsyncGenerator<ModelRouterChunk> {
    // Resolve the model — use the request's model if specified, else the
    // provider's default. For providers that have been "Test & loaded",
    // the first model in the list is the default.
    const provider = getProvider(this.id);
    let model = this.defaultModel;

    const requestedModel = (req as any).modelId;
    if (requestedModel && typeof requestedModel === 'string') {
      model = requestedModel;
    } else if (provider?.models && provider.models.length > 0) {
      model = provider.models[0].id;
    }

    const url = `${this.apiUrl}/chat/completions`;
    const body = {
      model,
      messages: req.messages.map((m: RouterMessage) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content :
          Array.isArray(m.content) ? m.content.map((c: any) =>
            c.type === 'text' ? { type: 'text', text: c.text } : c
          ) : String(m.content),
      })),
      temperature: 0.7,
      max_tokens: 8192,
      stream: true,
    };

    console.log(`[engine:${this.id}] streaming via ${url} (model=${model})`);

    let lastError = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          lastError = `HTTP ${res.status}: ${errText.slice(0, 200)}`;

          if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
            console.warn(`[engine:${this.id}] retryable error (${res.status}), retrying in ${BACKOFF_DELAYS_MS[attempt]}ms...`);
            await sleep(BACKOFF_DELAYS_MS[attempt]);
            continue;
          }

          // Non-retryable error or out of retries
          yield { delta: lastError, done: false } as ModelRouterChunk;
          return;
        }

        if (!res.body) {
          yield { delta: '', done: true } as ModelRouterChunk;
          return;
        }

        // Stream the SSE response
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
            if (data === '[DONE]') return;

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                yield { delta, done: false } as ModelRouterChunk;
              }
            } catch {
              // Skip malformed JSON chunks
            }
          }
        }
        return; // Success — don't retry
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        if (attempt < MAX_RETRIES) {
          console.warn(`[engine:${this.id}] network error, retrying in ${BACKOFF_DELAYS_MS[attempt]}ms...`);
          await sleep(BACKOFF_DELAYS_MS[attempt]);
          continue;
        }

        console.error(`[engine:${this.id}] stream failed after ${MAX_RETRIES} retries: ${lastError}`);
        yield { delta: lastError, done: false } as ModelRouterChunk;
        return;
      }
    }
  }
}
