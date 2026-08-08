// server/tests/unit/refactor-endpoint.test.ts
// Phase B: Editor Actions — Edit-family (refactor/document/optimize/convert) endpoint tests.
//
// Tests the POST /api/orchestrator/refactor endpoint for all 4 modes.
// Same test server pattern as explain-endpoint.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
const BASE = 'http://localhost:3096';

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(cors());
    app.use('/api/auth', authRouter);
    app.use('/api/orchestrator', orchestratorRouter);
    server = http.createServer(app);
    attachWsServer(server);
    server.listen(3096, () => resolve());
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

describe('Phase B: Editor Actions — Refactor endpoint (edit-family)', () => {
  let token: string;
  const email = `refactor-test-${Date.now()}@code-siren.test`;

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
      body: JSON.stringify({ email, password: 'test-password-123', name: 'Refactor Test' }),
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
  });

  afterAll(async () => {
    ghostMode.stop();
    await stopTestServer();
    await closeDb();
  });

  it('refactor mode: returns 200 + { result } with real stub-engine output', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/refactor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: 'const x = 1; if (x == 1) { console.log("yes"); }', mode: 'refactor' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { result: string };
    expect(typeof data.result).toBe('string');
    expect(data.result.length).toBeGreaterThan(0);
    // Verify it's real stub output (not hardcoded mock)
    expect(data.result).not.toContain('I would extract the mobile menu');
    console.log(`  [refactor] result: "${data.result.slice(0, 80)}..."`);
  });

  it('document mode: returns 200 + { result }', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/refactor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: 'function add(a, b) { return a + b; }', mode: 'document' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { result: string };
    expect(typeof data.result).toBe('string');
    expect(data.result.length).toBeGreaterThan(0);
    console.log(`  [document] result: "${data.result.slice(0, 80)}..."`);
  });

  it('optimize mode: returns 200 + { result }', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/refactor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: 'for (let i = 0; i < arr.length; i++) { total += arr[i]; }', mode: 'optimize' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { result: string };
    expect(typeof data.result).toBe('string');
    expect(data.result.length).toBeGreaterThan(0);
    console.log(`  [optimize] result: "${data.result.slice(0, 80)}..."`);
  });

  it('convert mode: returns 200 + { result } with targetLanguage', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/refactor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: 'const add = (a, b) => a + b;', mode: 'convert', targetLanguage: 'python' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { result: string };
    expect(typeof data.result).toBe('string');
    expect(data.result.length).toBeGreaterThan(0);
    console.log(`  [convert] result: "${data.result.slice(0, 80)}..."`);
  });

  it('returns 400 for invalid mode', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/refactor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: 'const x = 1;', mode: 'invalid-mode' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing code', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/refactor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: 'refactor' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/refactor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'const x = 1;', mode: 'refactor' }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts optional instruction field', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/refactor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: 'const x = 1;', mode: 'refactor', instruction: 'use const instead of let' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { result: string };
    expect(typeof data.result).toBe('string');
  });

  it('each mode returns real (non-hardcoded) content — not the old InlineAI mock', async () => {
    // The old InlineAI stub returned: "I would extract the mobile menu into a
    // separate component..." — verify the real endpoint doesn't return that.
    for (const mode of ['refactor', 'document', 'optimize', 'convert'] as const) {
      const res = await fetch(`${BASE}/api/orchestrator/refactor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: 'const x = 1;', mode }),
      });
      const data = await res.json() as { result: string };
      expect(data.result).not.toContain('I would extract the mobile menu');
      expect(data.result).not.toContain('Adding JSDoc comments');
      expect(data.result).not.toContain('Consider memoizing');
    }
  });
});
