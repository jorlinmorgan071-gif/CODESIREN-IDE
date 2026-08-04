// server/src/orchestration/engines/groq.ts
// Phase A Section 6: Groq engine — OpenAI-compatible API.
//
// Groq uses the standard OpenAI chat completions format (same request body,
// same SSE streaming, same delta JSON path). Only the base URL + auth header
// differ from OpenRouter/OpenAI.
//
// Groq's value: LPU hardware = fastest inference available. For real-time
// coding assistance, Groq's speed is genuinely valuable.

import type { EngineId, ModelRouterRequest, ModelRouterChunk } from '../../types.js';
import type { InferenceEngine } from '../model-router.js';
import { config } from '../../config.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

// Groq model names — Groq hosts specific models (Llama, Mixtral, etc.)
function pickGroqModel(domain: string): string {
  switch (domain) {
    case 'ARCHITECT':
    case 'SECURITY':
    case 'REVIEW':
      return 'llama-3.3-70b-versatile';
    case 'FRONTEND':
    case 'BACKEND':
    case 'QA':
      return 'llama-3.3-70b-versatile';
    default:
      return 'llama-3.3-70b-versatile';
  }
}

export class GroqEngine implements InferenceEngine {
  id: EngineId = 'groq';

  async *stream(req: ModelRouterRequest): AsyncGenerator<ModelRouterChunk> {
    const model = pickGroqModel(req.domain);
    const body = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 1024,
      stream: true,
    };

    console.log(`[groq] streaming model=${model} agent=${req.agentId} mode=${req.executionMode} messages=${req.messages.length}`);

    let res: Response;
    try {
      res = await fetch(GROQ_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.GROQ_API_KEY!}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      yield { delta: `[groq] connection failed: ${err.message}`, done: false };
      yield { delta: '', done: true };
      return;
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '(no response body)');
      yield { delta: `[groq] error ${res.status}: ${errText.slice(0, 200)}`, done: false };
      yield { delta: '', done: true };
      return;
    }

    // Standard OpenAI-compatible SSE parsing
    // (same as OpenRouterEngine: data: {json}\n\n, json.choices[0].delta.content)
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
