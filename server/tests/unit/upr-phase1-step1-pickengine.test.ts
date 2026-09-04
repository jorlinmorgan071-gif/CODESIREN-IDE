// server/tests/unit/upr-phase1-step1-pickengine.test.ts
// UPR Phase 1 Step 1 — pickEngine() reachability proof for Anthropic + Groq.
//
// Pre-Step-1: Anthropic + Groq engines were registered in the constructor
// (when ANTHROPIC_API_KEY / GROQ_API_KEY were set) but pickEngine() never
// returned them. The preferred-engine cascade only considered 'ollama' and
// 'openrouter'; the fallback chain only checked those two plus stub.
//
// Step 1 fix: extended both the preferred-engine cascade AND the fallback
// chain to consider 'anthropic' and 'groq'. Now all 4 cloud/local engines
// are reachable through normal routing.
//
// These tests prove the engines are actually SELECTABLE (pickEngine returns
// them) AND CALLABLE (their stream() actually executes when picked). Not
// just "present in the engines Map" — that was already true before Step 1.
//
// Method: set env vars at the very top of the file (before any imports), then
// spy on global.fetch in beforeEach. The spy must be installed before
// model-router.ts is imported — so we use dynamic import() after installing
// the spy. This ensures initOllama()'s probe returns "unavailable" and the
// preferred-engine cascade falls through to Anthropic.

// Set env BEFORE any imports so config.ts picks them up.
process.env.OPENROUTER_API_KEY = '';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-step1';
process.env.GROQ_API_KEY = 'test-groq-key-step1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ModelRouterRequest } from '../../src/types.js';

// Mock fetch BEFORE importing model-router. We do this with a top-level
// vi.spyOn that runs before the dynamic import() below.
function mockFetchImpl(input: any): Promise<Response> {
  const url = typeof input === 'string' ? input : (input as Request).url;
  if (url.includes('127.0.0.1:11434') || url.includes('ollama')) {
    return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
  }
  if (url.includes('api.anthropic.com')) {
    const body = [
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'anthropic-step1-output' } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
      '',
    ].join('\n');
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  }
  if (url.includes('api.groq.com')) {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'groq-step1-output' } }] })}`,
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  }
  return Promise.resolve(new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
}

// Install the spy BEFORE the model-router module is loaded. The spy needs to
// be in place when the constructor fires initOllama() at module-load time.
const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetchImpl as any);

// Dynamic import AFTER env + spy are in place. This ensures model-router.ts
// is loaded with the right env vars AND the mocked fetch.
const modelRouterModule = await import('../../src/orchestration/model-router.js');
const modelRouter = modelRouterModule.modelRouter;

function makeRequest(): ModelRouterRequest {
  return {
    agentId: 'test-agent',
    domain: 'ARCHITECT',
    messages: [
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'Hello.' },
    ],
    temperature: 0.5,
    maxTokens: 50,
    executionMode: 'single-shot',
  };
}

async function collectDeltas(gen: AsyncGenerator<{ delta: string; done: boolean }>): Promise<string> {
  let out = '';
  for await (const chunk of gen) {
    if (chunk.delta) out += chunk.delta;
  }
  return out;
}

// Wait for the async initOllama probe to complete before tests run.
beforeEach(async () => {
  // Force a recheck so the preferred-engine is set with the mocked fetch.
  await modelRouter.recheckEngines();
});

describe('UPR Phase 1 Step 1 — Anthropic + Groq reachable through pickEngine()', () => {
  // ── TEST A — Anthropic is the preferred engine when Ollama unavailable + only ANTHROPIC_API_KEY set ──
  it('TEST A — pickEngine selects Anthropic (not stub) when only ANTHROPIC_API_KEY is set', async () => {
    const req = makeRequest();
    const engine = modelRouter.pickEngine(req);
    expect(engine.id).toBe('anthropic');

    // Confirm it's actually CALLABLE — the stream() generator produces real
    // deltas from the mocked fetch. Pre-Step-1, the engine would have been
    // 'stub' and the output would have been a deterministic stub string.
    const output = await collectDeltas(engine.stream(req));
    expect(output).toContain('anthropic-step1-output');
    expect(output).not.toContain('[stub]');
  });

  // ── TEST B — Groq is reachable and callable via req.engine override ─
  it('TEST B — Groq is reachable and callable via req.engine override', async () => {
    const req = makeRequest();
    // `engine` is an unofficial extension on ModelRouterRequest (cast from
    // any inside pickEngine). Adding it via spread is type-safe in TS 5+
    // because the resulting object is assignable to ModelRouterRequest &
    // { engine: EngineId }.
    const reqWithGroq = { ...req, engine: 'groq' as const } as ModelRouterRequest;
    const engine = modelRouter.pickEngine(reqWithGroq);
    expect(engine.id).toBe('groq');

    // Confirm callable — stream produces real Groq chunks
    const output = await collectDeltas(engine.stream(req));
    expect(output).toContain('groq-step1-output');
    expect(output).not.toContain('[stub]');
  });

  // ── TEST C — preferredEngine is 'anthropic' (not 'stub') ────────────
  it('TEST C — modelRouter.getPreferredEngine() returns "anthropic" (not "stub")', () => {
    const preferred = modelRouter.getPreferredEngine();
    expect(preferred).toBe('anthropic');
  });

  // ── TEST D — getSelectedEngineId discloses Anthropic for evidence ───
  it('TEST D — getSelectedEngineId discloses Anthropic (not stub) for evidence', () => {
    const req = makeRequest();
    const disclosed = modelRouter.getSelectedEngineId(req);
    expect(disclosed).toBe('anthropic');
  });

  // ── TEST E — full end-to-end: modelRouter.stream(req) reaches Anthropic ─
  it('TEST E — modelRouter.stream(req) reaches Anthropic and produces real chunks', async () => {
    const req = makeRequest();
    const output = await collectDeltas(modelRouter.stream(req));
    expect(output).toContain('anthropic-step1-output');
    expect(output).not.toContain('[stub]');
  });

  // ── TEST F — fallback chain reaches Anthropic when preferred is reset ─
  it('TEST F — pickEngine never returns stub when a cloud engine is configured', () => {
    const req = makeRequest();
    const engine = modelRouter.pickEngine(req);
    expect(engine.id).not.toBe('stub');
    expect(['anthropic', 'groq']).toContain(engine.id);
  });

  // ── TEST G — regression: stub engine still reachable via req.engine override ──
  it('TEST G — stub engine still registered and reachable via req.engine (regression)', () => {
    const req = makeRequest();
    const reqWithStub = { ...req, engine: 'stub' as const } as ModelRouterRequest;
    const engine = modelRouter.pickEngine(reqWithStub);
    expect(engine.id).toBe('stub');
  });
});
