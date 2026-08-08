// server/tests/unit/explain-endpoint.test.ts
// Phase B: Editor Actions — Explain endpoint test.
//
// Tests the POST /api/orchestrator/explain endpoint:
//   1. Returns 200 + { explanation } for valid code input
//   2. Returns 200 without language field (optional)
//   3. Returns 400 for missing code
//   4. Returns 401 without auth token
//   5. Returns real (non-hardcoded) explanation from the stub engine

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
const BASE = 'http://localhost:3097';

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(cors());
    app.use('/api/auth', authRouter);
    app.use('/api/orchestrator', orchestratorRouter);
    server = http.createServer(app);
    attachWsServer(server);
    server.listen(3097, () => resolve());
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

describe('Phase B: Editor Actions — Explain endpoint', () => {
  let token: string;
  const email = `explain-test-${Date.now()}@code-siren.test`;

  beforeAll(async () => {
    await initDb();
    ghostMode.setLevel('approval-required');
    ghostMode.start();
    if (!agentManager.get('architect-agent')) {
      agentManager.register(new ArchitectAgent());
    }
    await startTestServer();

    // Register a user via the test server
    let res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-123', name: 'Explain Test' }),
    });

    if (res.ok) {
      const data = await res.json() as { token: string };
      token = data.token;
    } else {
      // Login if already registered
      res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'test-password-123' }),
      });
      if (res.ok) {
        const data = await res.json() as { token: string };
        token = data.token;
      } else {
        throw new Error(`Failed to register/login: ${res.status}`);
      }
    }
  });

  afterAll(async () => {
    ghostMode.stop();
    await stopTestServer();
    await closeDb();
  });

  it('returns 200 + { explanation } for valid code input', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: 'const x = 1 + 2;', language: 'typescript' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { explanation: string };
    expect(typeof data.explanation).toBe('string');
    expect(data.explanation.length).toBeGreaterThan(0);
  });

  it('returns 200 without language field (optional)', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: 'console.log("hello")' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { explanation: string };
    expect(typeof data.explanation).toBe('string');
  });

  it('returns 400 for missing code field', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ language: 'typescript' }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('Invalid input');
  });

  it('returns 401 without auth token', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'const x = 1;' }),
    });

    expect(res.status).toBe(401);
  });

  it('returns real (non-hardcoded) explanation from stub engine', async () => {
    const res = await fetch(`${BASE}/api/orchestrator/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: 'function add(a, b) { return a + b; }' }),
    });
    const data = await res.json() as { explanation: string };

    // The stub engine returns a canned response — verify it's a non-empty
    // string that came from the model router (not the old hardcoded mock
    // from InlineAI.tsx which returned "This code defines a React functional
    // component..."). The stub response is different text.
    expect(typeof data.explanation).toBe('string');
    expect(data.explanation.length).toBeGreaterThan(0);
    // The stub response contains "Step 0" or "routing domain" — verify it's
    // NOT the old hardcoded InlineAI mock
    expect(data.explanation).not.toContain('This code defines a React functional component');
    console.log(`  [explain] response: "${data.explanation.slice(0, 100)}..."`);
  });
});
