// server/tests/unit/vision-endpoint.test.ts
// Phase B: Screen Intelligence — Vision endpoint test.
//
// Tests the POST /api/orchestrator/vision endpoint:
//   1. Returns 200 + { analysis } for valid image + prompt
//   2. Returns 400 for missing image
//   3. Returns 400 for missing prompt
//   4. Returns 401 without auth token
//   5. PRIVACY: no image data appears in server logs
//
// Uses a tiny 1x1 PNG (base64) as the test image. The z-ai SDK will be
// called but may fail (no .z-ai-config in CI) — the test verifies the
// endpoint handles both success and error gracefully, and that image
// data is never logged.

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { orchestratorRouter } from '../../src/routes/orchestrator.js';
import { authRouter } from '../../src/auth/routes.js';
import { initDb, closeDb } from '../../src/db/client.js';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import { ArchitectAgent } from '../../src/agents/architect/index.js';
import { attachWsServer } from '../../src/ws/server.js';

let server: http.Server;
const BASE = 'http://localhost:3095';

// 1x1 transparent PNG (base64 without data URI prefix)
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG_DATA_URI = `data:image/png;base64,${TINY_PNG_BASE64}`;

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(cors());
    app.use('/api/auth', authRouter);
    app.use('/api/orchestrator', orchestratorRouter);
    server = http.createServer(app);
    attachWsServer(server);
    server.listen(3095, () => resolve());
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

describe('Phase B: Screen Intelligence — Vision endpoint', () => {
  let token: string;
  const email = `vision-test-${Date.now()}@code-siren.test`;
  const sessionId = crypto.randomUUID();

  // Capture console.log to verify no image data is logged
  let consoleLogs: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeAll(async () => {
    await initDb();
    ghostMode.setLevel('approval-required');
    ghostMode.start();
    if (!agentManager.get('architect-agent')) {
      agentManager.register(new ArchitectAgent());
    }
    await startTestServer();

    let res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-123', name: 'Vision Test' }),
    });
    if (res.ok) {
      token = (await res.json() as { token: string }).token;
    } else {
      res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'test-password-123' }),
      });
      token = (await res.json() as { token: string }).token;
    }

    // Capture console output
    consoleLogs = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: any[]) => {
      consoleLogs.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' '));
    };
    console.error = (...args: any[]) => {
      consoleLogs.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' '));
    };
  });

  afterEach(() => {
    consoleLogs = [];
  });

  afterAll(async () => {
    console.log = originalLog;
    console.error = originalError;
    ghostMode.stop();
    await stopTestServer();
    await closeDb();
  });

  it('returns 200 + { analysis } for valid image + prompt (or graceful error)', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: TINY_PNG_DATA_URI, prompt: 'What is in this image?', sessionId }),
    });

    // The endpoint may return:
    //   200 — success (vision-capable model configured)
    //   500 — vision call failed (model error, network, etc.)
    //   503 — no vision-capable provider configured (Phase 3+ — registry routing)
    // All three are valid — the endpoint doesn't crash and returns structured JSON.
    expect([200, 500, 503].includes(res.status)).toBe(true);

    const data = await res.json();
    if (res.status === 200) {
      expect(typeof (data as any).analysis).toBe('string');
    } else {
      expect(typeof (data as any).error).toBe('string');
    }
    // Provider may be 'z-ai-vision' (old), 'none-configured' (Phase 3+ — no
    // vision provider configured), or a real provider id (openrouter/anthropic).
    expect((data as any).evidence).toMatchObject({
      taskId: expect.any(String), action: 'vision',
      provider: expect.any(String),  // Phase 3+: provider is dynamic (registry-routed)
      inputs: { fields: ['image', 'prompt'], imageRetained: false },
      apply: { status: 'not-applicable' }, verification: { status: 'unverified' },
    });
  });

  it('returns 400 for missing image', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'What is this?', sessionId }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing prompt', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: TINY_PNG_DATA_URI, sessionId }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: TINY_PNG_DATA_URI, prompt: 'What is this?', sessionId }),
    });
    expect(res.status).toBe(401);
  });

  it('PRIVACY: no image base64 data appears in console logs', async () => {
    // Make a request (will succeed or fail — doesn't matter)
    const res = await fetch(`${BASE}/api/orchestrator/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: TINY_PNG_DATA_URI, prompt: 'What is this?', sessionId }),
    });

    // Check ALL console logs — none should contain the base64 image data
    const allLogs = consoleLogs.join('\n');

    // The raw base64 string (without data URI prefix) should NOT appear in logs
    expect(allLogs).not.toContain(TINY_PNG_BASE64);

    // The full data URI should NOT appear in logs
    expect(allLogs).not.toContain(TINY_PNG_DATA_URI);

    // If there's an error, it should have been sanitized (no base64 blobs)
    // Check for long base64-like strings (50+ chars of base64)
    const base64Pattern = /[A-Za-z0-9+/=]{50,}/;
    expect(!base64Pattern.test(allLogs), 'base64 data found in logs — privacy violation').toBe(true);

    // The log SHOULD mention either the image analysis (success path) OR
    // the vision error (failure path) — but either way, no image data.
    // Phase 3+: when no vision provider is configured, the route returns 503
    // before logging (no analysis log, no error log — just the 503 response).
    // This is valid — the 503 response itself is the visible feedback.
    const hasAnalysisLog = /analyzing image.*KB/.test(allLogs);
    const hasErrorLog = /\[orchestrator:vision\] error/.test(allLogs);
    const hasNoProviderLog = /No vision-capable model is configured/.test(allLogs);
    // (503 path doesn't log to console — it returns the error directly)
    expect(hasAnalysisLog || hasErrorLog || hasNoProviderLog || res.status === 503,
      'expected either analysis log, error log, no-provider log, or 503 status').toBe(true);
  });
});
