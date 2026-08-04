// tests/unit/api-hub-engines.test.ts
// Phase A Section 6: AnthropicEngine + GroqEngine tests.
//
// Uses mocked global.fetch (vi.spyOn) — verifies the outgoing request
// body/headers match the real API format + SSE parsing produces correct
// { delta, done } chunks from a mocked stream response.
//
// No real API keys needed — the mocked fetch proves the request format +
// response parsing are correct. A real integration test is optional.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnthropicEngine } from '../../src/orchestration/engines/anthropic.js';
import { GroqEngine } from '../../src/orchestration/engines/groq.js';
import { modelRouter } from '../../src/orchestration/model-router.js';
import type { ModelRouterRequest } from '../../src/types.js';

// Set API keys for test mode (engines read from config which reads from env)
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.GROQ_API_KEY = 'test-groq-key';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeRequest(): ModelRouterRequest {
  return {
    agentId: 'test-agent',
    domain: 'ARCHITECT',
    messages: [
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'Hello, say hi back.' },
    ],
    temperature: 0.5,
    maxTokens: 100,
    executionMode: 'single-shot',
  };
}

/** Create a mock Response with a ReadableStream body from an array of chunks. */
function mockResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Collect all chunks from an async generator into an array. */
async function collectChunks(gen: AsyncGenerator<{ delta: string; done: boolean }>): Promise<{ deltas: string[]; doneCount: number }> {
  const deltas: string[] = [];
  let doneCount = 0;
  for await (const chunk of gen) {
    if (chunk.delta) deltas.push(chunk.delta);
    if (chunk.done) doneCount++;
  }
  return { deltas, doneCount };
}

// ════════════════════════════════════════════════════════════════════
// GROUP 1: AnthropicEngine
// ════════════════════════════════════════════════════════════════════
describe('AnthropicEngine', () => {
  let engine: AnthropicEngine;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    engine = new AnthropicEngine();
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends correct request format: separate system param, x-api-key header, anthropic-version', async () => {
    fetchSpy.mockResolvedValue(mockResponse([
      'event: message_stop\ndata: {}\n\n',
    ]));

    await collectChunks(engine.stream(makeRequest()));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];

    // Correct endpoint
    expect(url).toBe('https://api.anthropic.com/v1/messages');

    // Correct headers — x-api-key may be undefined in test (config loaded at
    // module time with no env var), but the header KEY must be present in the
    // headers object. The anthropic-version header confirms the format is correct.
    const headers = (opts as any).headers;
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Content-Type']).toBe('application/json');
    // x-api-key is set from config.ANTHROPIC_API_KEY — in test mode this may be
    // undefined. What matters is the header key EXISTS in the request.
    expect('x-api-key' in headers).toBe(true);

    // Correct body: system is SEPARATE from messages
    const body = JSON.parse((opts as any).body);
    expect(body.system).toBe('You are a test agent.');
    expect(body.messages).toHaveLength(1); // only the user message (system extracted)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'Hello, say hi back.' });
    expect(body.model).toBeDefined();
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
    expect(body.stream).toBe(true);
  });

  it('does NOT include system-role messages in the messages array', async () => {
    fetchSpy.mockResolvedValue(mockResponse(['event: message_stop\ndata: {}\n\n']));

    const req: ModelRouterRequest = {
      ...makeRequest(),
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'User message' },
        { role: 'assistant', content: 'Assistant reply' },
        { role: 'user', content: 'Follow up' },
      ],
    };

    await collectChunks(engine.stream(req));

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
    expect(body.system).toBe('System prompt');
    expect(body.messages).toHaveLength(3); // user, assistant, user (system removed)
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[2].role).toBe('user');
  });

  it('parses SSE content_block_delta events correctly', async () => {
    // Simulate Anthropic's SSE format
    const sseChunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    fetchSpy.mockResolvedValue(mockResponse(sseChunks));

    const { deltas, doneCount } = await collectChunks(engine.stream(makeRequest()));

    expect(deltas).toEqual(['Hello', ' world']);
    expect(doneCount).toBeGreaterThanOrEqual(1);
  });

  it('handles connection errors gracefully', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));

    const { deltas, doneCount } = await collectChunks(engine.stream(makeRequest()));

    expect(deltas.length).toBe(1);
    expect(deltas[0]).toContain('[anthropic] connection failed');
    expect(doneCount).toBeGreaterThanOrEqual(1);
  });

  it('handles HTTP error responses', async () => {
    fetchSpy.mockResolvedValue(new Response('{"error":"Unauthorized"}', { status: 401 }));

    const { deltas } = await collectChunks(engine.stream(makeRequest()));

    expect(deltas.length).toBe(1);
    expect(deltas[0]).toContain('[anthropic] error 401');
  });
});

// ════════════════════════════════════════════════════════════════════
// GROUP 2: GroqEngine
// ════════════════════════════════════════════════════════════════════
describe('GroqEngine', () => {
  let engine: GroqEngine;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    engine = new GroqEngine();
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends correct request format: OpenAI-compatible, Groq base URL, Bearer auth', async () => {
    fetchSpy.mockResolvedValue(mockResponse(['data: [DONE]\n\n']));

    await collectChunks(engine.stream(makeRequest()));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];

    // Correct endpoint (Groq's OpenAI-compatible URL)
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');

    // Correct headers (Bearer auth, same as OpenAI)
    const headers = (opts as any).headers;
    expect(headers['Authorization']).toMatch(/^Bearer /);
    expect(headers['Content-Type']).toBe('application/json');

    // Correct body (OpenAI-compatible: messages array with system role included)
    const body = JSON.parse((opts as any).body);
    expect(body.messages).toHaveLength(2); // system + user (OpenAI format keeps system in messages)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a test agent.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello, say hi back.' });
    expect(body.model).toBeDefined();
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
    expect(body.stream).toBe(true);
  });

  it('parses OpenAI-compatible SSE: data: {json} with choices[0].delta.content', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" from Groq"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchSpy.mockResolvedValue(mockResponse(sseChunks));

    const { deltas, doneCount } = await collectChunks(engine.stream(makeRequest()));

    expect(deltas).toEqual(['Hello', ' from Groq']);
    expect(doneCount).toBeGreaterThanOrEqual(1);
  });

  it('handles connection errors gracefully', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));

    const { deltas, doneCount } = await collectChunks(engine.stream(makeRequest()));

    expect(deltas.length).toBe(1);
    expect(deltas[0]).toContain('[groq] connection failed');
    expect(doneCount).toBeGreaterThanOrEqual(1);
  });

  it('handles HTTP error responses', async () => {
    fetchSpy.mockResolvedValue(new Response('{"error":"rate limited"}', { status: 429 }));

    const { deltas } = await collectChunks(engine.stream(makeRequest()));

    expect(deltas.length).toBe(1);
    expect(deltas[0]).toContain('[groq] error 429');
  });
});

// ════════════════════════════════════════════════════════════════════
// GROUP 3: registerEngine() public API
// ════════════════════════════════════════════════════════════════════
describe('registerEngine() public API', () => {
  it('registerEngine adds an engine to the map + hasEngine confirms it', () => {
    const testEngine = {
      id: 'anthropic' as const,
      stream: async function* () {
        yield { delta: 'test', done: true };
      },
    };

    // Register it
    modelRouter.registerEngine(testEngine);

    // hasEngine confirms it's registered
    expect(modelRouter.hasEngine('anthropic')).toBe(true);
  });

  it('registered engine can be selected via req.engine', async () => {
    const testEngine = {
      id: 'groq' as const,
      stream: async function* () {
        yield { delta: 'groq test output', done: false };
        yield { delta: '', done: true };
      },
    };

    modelRouter.registerEngine(testEngine);

    // Select it via req.engine
    const req: ModelRouterRequest = {
      ...makeRequest(),
      // @ts-expect-error — engine is not in the official ModelRouterRequest type
      engine: 'groq',
    };

    const { deltas } = await collectChunks(modelRouter.stream(req));
    expect(deltas).toContain('groq test output');
  });
});
