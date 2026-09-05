// server/tests/unit/upr-phase1-step2b-abortsignal-cap.test.ts
// UPR Phase 1 Step 2b — AbortSignal / timeout-cap proof.
//
// This is the SEPARATE test the directive requires — NOT merged into Step 2a.
//
// The concern: withRetry's BACKOFF_DELAYS_MS schedule is 2s + 4s + 8s = 14s
// total. If a caller has a 3s timeout (the /complete endpoint), a transient
// 503 would cause retry to silently run for 14s — blowing past the 3s budget
// by 11s. The user sees a hung UI for 14s instead of a clean failure at 3s.
//
// Step 2b fix: plumb the caller's AbortSignal through ModelRouterRequest.signal
// → engine → withRetry. The retry helper checks the signal before each backoff
// sleep AND before each attempt. If the signal aborts (because the caller's
// timeout fired), retry stops immediately.
//
// This test forces a retry scenario (all 503s) against each of the 3
// lightweight HTTP endpoints (/complete 3s, /explain 10s, /refactor 15s)
// and reports the EXACT ELAPSED TIME observed for each — not just pass/fail.
// The assertion is that elapsed < budget + 500ms (500ms tolerance for overhead).
//
// WITHOUT the Step 2b fix, the elapsed time would be ~14s for all three
// (the full BACKOFF_DELAYS_MS schedule). With the fix, it's capped at the
// caller's budget.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

// Set API keys so the Anthropic engine registers.
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-step2b';
process.env.OPENROUTER_API_KEY = '';  // force Anthropic as preferred

// Mock fetch to ALWAYS return 503 — forces retry on every attempt.
// This is the "transient failure" scenario from the directive.
vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
  const url = typeof input === 'string' ? input : (input as Request).url;
  // Ollama probe — return connection refused so preferredEngine falls to Anthropic
  if (url.includes('127.0.0.1:11434') || url.includes('ollama')) {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  }
  // All LLM calls — return 503 to trigger retry
  return new Response('{"error":"server error"}', { status: 503 });
});

// Import after mocks are in place.
const { modelRouter } = await import('../../src/orchestration/model-router.js');
const { authRouter } = await import('../../src/auth/routes.js');
import { requireAuth } from '../../src/auth/middleware.js';
import { ghostModeRouter } from '../../src/routes/ghost-mode.js';

// We need to build a minimal Express app that mounts the 3 endpoints.
// Rather than import the full routes/orchestrator.ts (which has many deps),
// we build a minimal test app that calls modelRouter.stream() with the
// AbortSignal — mirroring what the real endpoints do.

function buildTestApp(): express.Express {
  const app = express();
  app.use(express.json());

  // Mock auth — bypass requireAuth for testing
  app.use((req: any, _res: any, next: any) => {
    req.user = { id: 'test-user-step2b', email: 'test@step2b', name: 'Test' };
    next();
  });

  // Minimal /complete endpoint — mirrors routes/orchestrator.ts:489-559
  app.post('/api/orchestrator/complete', async (req, res) => {
    const COMPLETION_TIMEOUT_MS = 3000;
    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), COMPLETION_TIMEOUT_MS);
    const routerRequest = {
      domain: 'ARCHITECT',
      executionMode: 'single-shot' as const,
      agentId: 'completion',
      messages: [
        { role: 'system', content: 'You are a code completion engine.' },
        { role: 'user', content: `prefix: ${req.body.prefix}\nsuffix: ${req.body.suffix}` },
      ],
      signal: abort.signal,
    } as any;
    try {
      const chunks: string[] = [];
      for await (const chunk of modelRouter.stream(routerRequest)) {
        if (abort.signal.aborted) break;
        if (chunk.delta) chunks.push(chunk.delta);
      }
      clearTimeout(timeoutId);
      const text = chunks.join('').trim();
      res.json({ text, aborted: abort.signal.aborted });
    } catch (err: any) {
      clearTimeout(timeoutId);
      res.json({ text: '', aborted: abort.signal.aborted, error: err.message });
    }
  });

  // Minimal /explain endpoint — mirrors routes/orchestrator.ts:588-650
  app.post('/api/orchestrator/explain', async (req, res) => {
    const EXPLAIN_TIMEOUT_MS = 10_000;
    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), EXPLAIN_TIMEOUT_MS);
    const routerRequest = {
      domain: 'ARCHITECT',
      executionMode: 'single-shot' as const,
      agentId: 'explain',
      messages: [
        { role: 'system', content: 'You explain code.' },
        { role: 'user', content: `Explain: ${req.body.code}` },
      ],
      signal: abort.signal,
    } as any;
    try {
      const chunks: string[] = [];
      for await (const chunk of modelRouter.stream(routerRequest)) {
        if (abort.signal.aborted) break;
        if (chunk.delta) chunks.push(chunk.delta);
      }
      clearTimeout(timeoutId);
      res.json({ explanation: chunks.join('').trim(), aborted: abort.signal.aborted });
    } catch (err: any) {
      clearTimeout(timeoutId);
      res.json({ explanation: '', aborted: abort.signal.aborted, error: err.message });
    }
  });

  // Minimal /refactor endpoint — mirrors routes/orchestrator.ts:665-780
  app.post('/api/orchestrator/refactor', async (req, res) => {
    const REFACTOR_TIMEOUT_MS = 15_000;
    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), REFACTOR_TIMEOUT_MS);
    const routerRequest = {
      domain: 'ARCHITECT',
      executionMode: 'single-shot' as const,
      agentId: 'refactor',
      messages: [
        { role: 'system', content: 'You refactor code.' },
        { role: 'user', content: `Refactor: ${req.body.code}` },
      ],
      signal: abort.signal,
    } as any;
    try {
      const chunks: string[] = [];
      for await (const chunk of modelRouter.stream(routerRequest)) {
        if (abort.signal.aborted) break;
        if (chunk.delta) chunks.push(chunk.delta);
      }
      clearTimeout(timeoutId);
      res.json({ result: chunks.join('').trim(), aborted: abort.signal.aborted });
    } catch (err: any) {
      clearTimeout(timeoutId);
      res.json({ result: '', aborted: abort.signal.aborted, error: err.message });
    }
  });

  return app;
}

function httpRequest(app: express.Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const data = body ? JSON.stringify(body) : undefined;
      const start = Date.now();
      const req = http.request(
        { host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => {
            const elapsedMs = Date.now() - start;
            server.close();
            resolve({ status: res.statusCode ?? 0, body, elapsedMs });
          });
        },
      );
      req.on('error', (err) => {
        const elapsedMs = Date.now() - start;
        server.close();
        // For timeout testing, we want to capture the elapsed time even on error
        reject({ error: err.message, elapsedMs });
      });
      if (data) req.write(data);
      req.end();
    });
  });
}

beforeEach(async () => {
  // Force modelRouter to re-check engines with mocked fetch in place
  await modelRouter.recheckEngines();
});

describe('UPR Phase 1 Step 2b — AbortSignal caps retry at caller timeout budget', () => {
  // ── /complete — 3s budget ─────────────────────────────────────────────
  it('/complete (3s budget): all-503s fail within ~3s, NOT 14s', async () => {
    const app = buildTestApp();
    const result = await httpRequest(app, 'POST', '/api/orchestrator/complete', {
      prefix: 'const x = ',
      suffix: '\nconsole.log(x);',
    });

    console.log(`  [/complete] elapsed: ${result.elapsedMs}ms (budget: 3000ms)`);
    console.log(`  [/complete] response: ${result.body.slice(0, 100)}`);

    // The key assertion: elapsed must be within budget + 500ms tolerance.
    // WITHOUT the Step 2b fix, elapsed would be ~14000ms (full backoff schedule).
    // WITH the fix, it's capped at ~3000ms (the AbortController fires at 3s).
    expect(result.elapsedMs).toBeLessThan(3000 + 500);  // 3500ms max
    expect(result.elapsedMs).toBeGreaterThanOrEqual(2000);  // at least one backoff delay
    // The response should indicate the signal was aborted
    const parsed = JSON.parse(result.body);
    expect(parsed.aborted).toBe(true);
  }, 10_000);

  // ── /explain — 10s budget ────────────────────────────────────────────
  it('/explain (10s budget): all-503s fail within ~10s, NOT 14s', async () => {
    const app = buildTestApp();
    const result = await httpRequest(app, 'POST', '/api/orchestrator/explain', {
      code: 'function hello() { return "world"; }',
    });

    console.log(`  [/explain] elapsed: ${result.elapsedMs}ms (budget: 10000ms)`);
    console.log(`  [/explain] response: ${result.body.slice(0, 100)}`);

    // The key assertion: elapsed must be within budget + 500ms tolerance.
    // WITHOUT the Step 2b fix, elapsed would be ~14000ms.
    // WITH the fix, it's capped at ~10000ms.
    expect(result.elapsedMs).toBeLessThan(10_000 + 500);  // 10500ms max
    expect(result.elapsedMs).toBeGreaterThanOrEqual(2000);  // at least one backoff delay
    const parsed = JSON.parse(result.body);
    expect(parsed.aborted).toBe(true);
  }, 15_000);

  // ── /refactor — 15s budget ────────────────────────────────────────────
  it('/refactor (15s budget): all-503s — retry runs full schedule (14s < 15s)', async () => {
    // NOTE: /refactor has a 15s budget. The full backoff schedule is 2+4+8=14s.
    // So retry WILL complete the full schedule (14s < 15s) and return the error
    // at ~14s — BEFORE the 15s timeout fires. This proves the cap SCALES
    // correctly: it doesn't artificially truncate at 3s or 10s just because
    // those are the other endpoints' budgets. The cap is per-caller.
    const app = buildTestApp();
    const result = await httpRequest(app, 'POST', '/api/orchestrator/refactor', {
      code: 'const old = () => {};',
      mode: 'refactor',
    });

    console.log(`  [/refactor] elapsed: ${result.elapsedMs}ms (budget: 15000ms)`);
    console.log(`  [/refactor] response: ${result.body.slice(0, 100)}`);

    // The key assertion: elapsed should be ~14s (the full backoff schedule
    // completes because 14s < 15s budget). The signal does NOT abort because
    // retry finishes before the 15s timeout fires.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(13_000);  // ~14s (full schedule)
    expect(result.elapsedMs).toBeLessThan(15_000 + 500);  // under budget + tolerance
    const parsed = JSON.parse(result.body);
    // aborted should be FALSE — retry completed (exhausted) before the 15s timeout
    expect(parsed.aborted).toBe(false);
  }, 20_000);
});

// ── Direct _retry.ts AbortSignal unit tests ─────────────────────────────
describe('UPR Phase 1 Step 2b — withRetry respects AbortSignal directly', () => {
  it('withRetry stops retry immediately when signal is already aborted', async () => {
    const { withRetry } = await import('../../src/orchestration/engines/_retry.js');
    const controller = new AbortController();
    controller.abort();
    const op = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const result = await withRetry(op, { engineLabel: 'test', signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(0);  // never attempted because signal was already aborted
    expect(op).not.toHaveBeenCalled();
  });

  it('withRetry stops retry during backoff sleep when signal aborts', async () => {
    const { withRetry, BACKOFF_DELAYS_MS } = await import('../../src/orchestration/engines/_retry.js');
    const controller = new AbortController();
    const op = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    // Abort after 1s (during the first 2s backoff sleep)
    setTimeout(() => controller.abort(), 1000);
    const start = Date.now();
    const result = await withRetry(op, { engineLabel: 'test', signal: controller.signal });
    const elapsed = Date.now() - start;
    console.log(`  [direct] elapsed: ${elapsed}ms (aborted during 2s backoff)`);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);  // first attempt ran, then aborted during sleep
    expect(elapsed).toBeLessThan(BACKOFF_DELAYS_MS[0] + 500);  // < 2500ms (didn't complete full 2s sleep)
    expect(elapsed).toBeGreaterThanOrEqual(900);  // at least ~1s before abort
  }, 5_000);
});
