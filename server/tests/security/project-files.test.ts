// tests/security/project-files.test.ts
// P1: Code Review gate — writeProjectFile blocks bad writes, allows good writes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { projectFilesRouter } from '../../src/routes/project-files.js';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import { initDb, closeDb } from '../../src/db/client.js';
import { CodeReviewAgent } from '../../src/agents/code-review/index.js';
import { ArchitectAgent } from '../../src/agents/architect/index.js';
import { signToken } from '../../src/auth/jwt.js';
import { existsSync } from 'node:fs';

let server: http.Server;
const BASE = 'http://localhost:3097';

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(cors());
    app.use('/api/project-files', projectFilesRouter);
    server = app.listen(3097, () => resolve());
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

describe('Code Review Gate — writeProjectFile', () => {
  let token: string;
  let approvedWorkspacePath: string | undefined;
  const rejectedWorkspacePaths: string[] = [];

  beforeAll(async () => {
    await initDb();
    ghostMode.setLevel('approval-required');
    ghostMode.start();
    agentManager.register(new ArchitectAgent());
    agentManager.register(new CodeReviewAgent());
    await startTestServer();
    token = signToken({ id: 'test-user', email: 'test@test.com', name: 'Test', plan: 'free' });
  });

  afterAll(async () => {
    ghostMode.stop();
    await stopTestServer();
    await closeDb();
  });

  it('REJECTS write with hardcoded secret', async () => {
    const res = await fetch(`${BASE}/api/project-files/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        path: 'bad/secret.ts',
        content: 'const apiKey = "sk-1234567890abcdef"; export default apiKey;',
        agentId: 'backend-agent',
      }),
    });
    const body = await res.json() as any;
    expect(body.written).toBe(false);
    expect(body.review.approved).toBe(false);
    expect(body.review.score).toBe(0);
    expect(body.review.issues.some((i: string) => i.includes('secret'))).toBe(true);
    rejectedWorkspacePaths.push(body.path);
    expect(existsSync(body.path)).toBe(false);
  });

  it('REJECTS write with eval()', async () => {
    const res = await fetch(`${BASE}/api/project-files/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        path: 'bad/eval.ts',
        content: 'function run(code) { return eval(code); }',
        agentId: 'backend-agent',
      }),
    });
    const body = await res.json() as any;
    expect(body.written).toBe(false);
    expect(body.review.issues.some((i: string) => i.includes('eval'))).toBe(true);
    rejectedWorkspacePaths.push(body.path);
  });

  it('REJECTS write with private key', async () => {
    const res = await fetch(`${BASE}/api/project-files/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        path: 'bad/key.ts',
        content: 'const key = "-----BEGIN RSA PRIVATE KEY-----\\nMIIE...";',
        agentId: 'backend-agent',
      }),
    });
    const body = await res.json() as any;
    expect(body.written).toBe(false);
    rejectedWorkspacePaths.push(body.path);
  });

  it('APPROVES clean write (valid code)', async () => {
    const res = await fetch(`${BASE}/api/project-files/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        path: 'good/utils.ts',
        content: 'export function add(a: number, b: number): number { return a + b; }',
        agentId: 'backend-agent',
      }),
    });
    const body = await res.json() as any;
    expect(body.written).toBe(true);
    expect(body.review.approved).toBe(true);
    approvedWorkspacePath = body.path;
    expect(existsSync(approvedWorkspacePath!)).toBe(true);
  });

  it('file appears on disk after approved write', async () => {
    expect(approvedWorkspacePath).toBeDefined();
    expect(existsSync(approvedWorkspacePath!)).toBe(true);
  });

  it('file does NOT appear on disk after rejected write', async () => {
    expect(rejectedWorkspacePaths).toHaveLength(3);
    expect(rejectedWorkspacePaths.every(path => !existsSync(path))).toBe(true);
  });
});
