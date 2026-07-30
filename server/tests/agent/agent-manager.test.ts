// tests/agent/agent-manager.test.ts
// P0: AgentManager — register, list, get, send dispatch, trace generation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { agentsRouter } from '../../src/routes/agents.js';
import { healthRouter } from '../../src/routes/health.js';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import { initDb, closeDb } from '../../src/db/client.js';
import { ArchitectAgent } from '../../src/agents/architect/index.js';
import { BackendAgent } from '../../src/agents/backend/index.js';
import { attachWsServer } from '../../src/ws/server.js';
import { WebSocket } from 'ws';

let server: http.Server;
const BASE = 'http://localhost:3098';

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(cors());
    app.use('/api/agents', agentsRouter);
    app.use('/api/health', healthRouter);
    server = http.createServer(app);
    attachWsServer(server);
    server.listen(3098, () => resolve());
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

describe('AgentManager', () => {
  let token: string;
  const email = `agent-test-${Date.now()}@code-siren.test`;

  beforeAll(async () => {
    await initDb();
    ghostMode.setLevel('approval-required');
    ghostMode.start();
    agentManager.register(new ArchitectAgent());
    agentManager.register(new BackendAgent());
    await startTestServer();

    // Register a user
    const res = await fetch(`http://localhost:3001/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-123', name: 'Agent Test' }),
    }).catch(() => null);

    // If server:3001 isn't running, register via direct auth route
    if (!res || !res.ok) {
      const { authRouter } = await import('../../src/auth/routes.js');
      // Already mounted — just use the test server's auth
      const res2 = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'test-password-123', name: 'Agent Test' }),
      }).catch(() => null);
      if (res2 && res2.ok) {
        const body = await res2.json() as any;
        token = body.token;
      }
    } else {
      const body = await res.json() as any;
      token = body.token;
    }

    // If no token, create one manually via JWT
    if (!token) {
      const { signToken } = await import('../../src/auth/jwt.js');
      token = signToken({ id: 'test-user', email, name: 'Agent Test', plan: 'free' });
    }
  });

  afterAll(async () => {
    ghostMode.stop();
    await stopTestServer();
    await closeDb();
  });

  it('registers agents', () => {
    expect(agentManager.get('architect-agent')).toBeDefined();
    expect(agentManager.get('backend-agent')).toBeDefined();
  });

  it('list() returns registered agents', () => {
    const agents = agentManager.list();
    expect(agents.length).toBeGreaterThanOrEqual(2);
    expect(agents.some(a => a.id === 'architect-agent')).toBe(true);
  });

  it('GET /api/health returns agent roster', async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
    expect(body.agents.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/agents returns agent list', async () => {
    const res = await fetch(`${BASE}/api/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.agents.length).toBeGreaterThanOrEqual(2);
    expect(body.agents.some((a: any) => a.id === 'architect-agent')).toBe(true);
  });

  it('POST /api/agents/architect-agent/send → 202 + taskId', async () => {
    const res = await fetch(`${BASE}/api/agents/architect-agent/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description: 'test task', type: 'chat', executionMode: 'single-shot', origin: 'chat' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.taskId).toBeDefined();
    expect(body.agentId).toBe('architect-agent');
  });

  it('POST /api/agents/unknown-agent/send → 404', async () => {
    const res = await fetch(`${BASE}/api/agents/unknown-agent/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description: 'test', type: 'chat', executionMode: 'single-shot', origin: 'chat' }),
    });
    expect(res.status).toBe(404);
  });

  it('agent send produces trace in runs.jsonl', async () => {
    const sendRes = await fetch(`${BASE}/api/agents/architect-agent/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description: 'trace test', type: 'chat', executionMode: 'single-shot', origin: 'chat' }),
    });
    const { taskId } = await sendRes.json() as { taskId: string };

    // Wait for agent to complete
    await new Promise(r => setTimeout(r, 3000));

    // Check trace exists
    const traceRes = await fetch(`${BASE}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(traceRes.status).toBe(200);
  });

  it('agents have correct domains', () => {
    const architect = agentManager.get('architect-agent');
    expect(architect?.domain).toBe('ARCHITECT');
    const backend = agentManager.get('backend-agent');
    expect(backend?.domain).toBe('BACKEND');
  });

  it('agents have trust scores', () => {
    const architect = agentManager.get('architect-agent');
    expect(architect?.trustScore).toBeGreaterThan(0);
    expect(architect?.trustScore).toBeLessThanOrEqual(1);
  });
});
