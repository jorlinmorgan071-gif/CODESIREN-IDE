// server/src/orchestration/engines/anthropic.ts
// Phase A Section 6: Anthropic Messages API engine.
//
// Anthropic's API is NOT OpenAI-compatible — it has its own format:
//   - System prompt is a SEPARATE top-level parameter (not in messages[])
//   - Auth via x-api-key header + anthropic-version header
//   - SSE is event-type-based (event: content_block_delta\ndata: {...})
//   - Delta text is at content_block_delta.delta.text (not choices[0].delta.content)
//   - Stream ends with event: message_stop (not data: [DONE])
//
// This engine converts RouterMessage[] → Anthropic's format, streams the
// response, + yields { delta, done } chunks matching the InferenceEngine contract.

import type { EngineId, ModelRouterRequest, ModelRouterChunk, RouterMessage } from '../../types.js';
import type { InferenceEngine } from '../model-router.js';
import { config } from '../../config.js';
import { withRetry } from './_retry.js';
import { extractText, toAnthropicContent } from '../content-blocks.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Default model per domain — Anthropic model names are different from OpenRouter's
function pickAnthropicModel(domain: string): string {
  switch (domain) {
    case 'ARCHITECT':
    case 'SECURITY':
    case 'REVIEW':
      return 'claude-sonnet-4-20250514';
    case 'FRONTEND':
    case 'BACKEND':
    case 'QA':
      return 'claude-sonnet-4-20250514';
    default:
      return 'claude-sonnet-4-20250514';
  }
}

export class AnthropicEngine implements InferenceEngine {
  id: EngineId = 'anthropic';

  async *stream(req: ModelRouterRequest): AsyncGenerator<ModelRouterChunk> {
    const model = pickAnthropicModel(req.domain);

    // Extract system prompt from messages[0] if it's a system-role message
    // Anthropic requires system as a separate top-level parameter, NOT in messages[]
    let systemPrompt = '';
    let messages: RouterMessage[] = req.messages;

    if (req.messages[0]?.role === 'system') {
      systemPrompt = extractText(req.messages[0].content);
      messages = req.messages.slice(1);
    }

    // Anthropic messages only support 'user' and 'assistant' roles
    // (no 'tool' role in basic mode — filter if present)
    // Convert content blocks to Anthropic's format (image_url → image source)
    const anthropicMessages = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));

    const body = {
      model,
      system: systemPrompt,
      messages: anthropicMessages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 1024,
      stream: true,
    };

    console.log(`[anthropic] streaming model=${model} agent=${req.agentId} mode=${req.executionMode} messages=${anthropicMessages.length}`);

    // UPR Phase 1 Step 2a — retry transient failures (429/5xx/network errors)
    // via the shared withRetry helper. The signal is currently undefined —
    // Step 2b will plumb the caller's AbortSignal through ModelRouterRequest.
    let lastErrText = '(no response body)';
    const retryResult = await withRetry(
      async () => {
        const r = await fetch(ANTHROPIC_BASE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.ANTHROPIC_API_KEY!,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          // Capture the error text for the final failure report
          lastErrText = await r.text().catch(() => '(no response body)');
          return { ok: false as const, status: r.status };
        }
        return { ok: true as const, value: r };
      },
      { engineLabel: 'anthropic', signal: req.signal },
    );

    if (!retryResult.ok) {
      if (retryResult.networkError) {
        yield { delta: `[anthropic] connection failed: ${retryResult.networkError}`, done: false };
      } else {
        yield { delta: `[anthropic] error ${retryResult.status}: ${lastErrText.slice(0, 200)}`, done: false };
      }
      yield { delta: '', done: true };
      return;
    }

    const res = retryResult.value;
    if (!res.body) {
      yield { delta: '[anthropic] error: no response body', done: false };
      yield { delta: '', done: true };
      return;
    }

    // Parse Anthropic's SSE format: event-type-based
    // Each event is:
    //   event: <event_type>\n
    //   data: <json>\n\n
    //
    // Key event types:
    //   - message_start: initial message metadata
    //   - content_block_start: start of a content block
    //   - content_block_delta: the actual text delta (delta.text)
    //   - content_block_stop: end of a content block
    //   - message_delta: message-level delta (stop_reason, usage)
    //   - message_stop: stream is done
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        // Track the event type
        if (trimmed.startsWith('event:')) {
          currentEventType = trimmed.slice(6).trim();
          continue;
        }

        // Parse data lines
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;

        try {
          const json = JSON.parse(data);

          // Extract text delta from content_block_delta events
          if (currentEventType === 'content_block_delta') {
            const delta = json.delta?.text ?? '';
            if (delta) yield { delta, done: false };
          }

          // Stream is done
          if (currentEventType === 'message_stop') {
            yield { delta: '', done: true };
            return;
          }
        } catch {
          // skip malformed SSE line
        }
      }
    }

    yield { delta: '', done: true };
  }
}
