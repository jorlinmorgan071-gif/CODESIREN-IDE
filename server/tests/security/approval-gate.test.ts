// tests/security/approval-gate.test.ts
// Approval-gate fix: evidence tests.
//
// These tests prove the fix is real:
//   1. autoApprove: true sent in a non-test environment is IGNORED — the
//      command still waits for real approval.
//   2. The approval endpoint rejects unauthenticated requests (401).
//   3. The approval endpoint rejects unknown findingId (404).
//   4. The approval endpoint rejects a finding belonging to another user (403).
//   5. Full flow: command proposed → ghost:plan WS event fires → approval
//      endpoint called with valid auth + valid findingId → command executes.
//      Trace shows the approval came from the authenticated endpoint, not
//      from the task body.
//
// These tests run in NODE_ENV=test (vitest sets this). To prove the
// production behavior (autoApprove ignored), we temporarily override
// NODE_ENV within the test and verify the agent's behavior changes.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import { TerminalAgent } from '../../src/agents/terminal/index.js';
import { requireAuth } from '../../src/auth/middleware.js';
import { ghostModeRouter } from '../../src/routes/ghost-mode.js';
import { signToken } from '../../src/auth/jwt.js';
import type { AgentTask, AgentChunk } from '../../src/types.js';
import { listTraces, getTrace, startTrace } from '../../src/observability/traces.js';

// ── Test server setup ────────────────────────────────────────────────────

let server: http.Server;
let testPort = 3199;
const BASE: string = `http://localhost:${testPort}`;

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(cors());
    app.use('/api/ghost-mode', ghostModeRouter);

    // Minimal auth register endpoint for tests
    app.post('/api/auth/register', (_req, res) => {
      const token = signToken({
        id: 'test-user-id',
        email: 'test@example.com',
        name: 'Test',
        plan: 'free',
      });
      res.json({ token, user: { id: 'test-user-id', email: 'test@example.com', name: 'Test', plan: 'free' } });
    });

    server = app.listen(testPort, () => resolve());
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function getTestToken(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'test', name: 'Test' }),
  });
  const body = await res.json() as { token: string };
  return body.token;
}

// ── Helper: create a task with a userId in context ───────────────────────

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: `test-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: '00000000-0000-0000-0000-000000000000',
    sessionId: '00000000-0000-0000-0000-000000000000',
    agentId: 'terminal-agent',
    type: 'chat',
    description: '',
    context: {
      projectId: '00000000-0000-0000-0000-000000000000',
      rootPath: '/tmp',
      techStack: {},
      activeFiles: [],
      userId: 'test-user-id',
    },
    priority: 'normal',
    executionMode: 'single-shot',
    origin: 'api',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ── Test suite ───────────────────────────────────────────────────────────

describe('Approval Gate Fix', () => {
  beforeAll(async () => {
    // Register the Terminal Agent
    if (!agentManager.get('terminal-agent')) {
      agentManager.register(new TerminalAgent());
    }
    await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  beforeEach(() => {
    // Reset ghost mode between tests
    ghostMode.stop();
    ghostMode.setLevel('approval-required');
    ghostMode.start();
  });

  // ── Test 1: autoApprove ignored in non-test environment ─────────────
  it('autoApprove: true is IGNORED in NODE_ENV=production — command waits for real approval', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const task = makeTask({
        description: JSON.stringify({ command: 'echo hello', autoApprove: true }),
      });

      const abort = new AbortController();
      const chunks: AgentChunk[] = [];
      let timedOut = false;

      // Start a trace so the agent's addStep() calls are recorded
      startTrace({
        taskId: task.id,
        agentId: 'terminal-agent',
        domain: 'TERMINAL',
        executionMode: 'single-shot',
        input: task.description,
      });

      // Run the agent with a short timeout — we expect it to enter
      // awaiting_approval and NOT execute (because autoApprove is ignored
      // in production).
      const agent = agentManager.get('terminal-agent')!;
      const runPromise = (async () => {
        for await (const chunk of agent.execute(task, abort.signal)) {
          chunks.push(chunk);
        }
      })();

      // Wait 2 seconds (the agent should be waiting for approval, not executing)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // The agent should NOT have produced a 'command' chunk (which would
      // indicate execution). It should have produced text saying it's
      // waiting for approval.
      const textContent = chunks.filter(c => c.type === 'text').map(c => c.content).join('');
      const commandChunks = chunks.filter(c => c.type === 'command');

      expect(commandChunks.length).toBe(0);
      expect(textContent).toContain('autoApprove:true IGNORED in production');
      expect(textContent).toContain('Waiting for user approval');
      expect(textContent).toContain('/api/ghost-mode/findings/');

      // Abort the task to clean up
      abort.abort();
      try { await runPromise; } catch { /* expected — aborted */ }

      // Verify the trace recorded the ignored autoApprove
      const trace = getTrace(task.id);
      expect(trace).not.toBeNull();
      const ignoredStep = trace!.steps.find(s => s.meta?.autoApproveIgnored === true);
      expect(ignoredStep).toBeDefined();
      expect(ignoredStep!.meta!.failClosed).toBe(true);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  // ── Test 1b: autoApprove HONORED in test environment (backwards compat) ──
  it('autoApprove: true IS honored in NODE_ENV=test (backwards compat for test suite)', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    try {
      const task = makeTask({
        description: JSON.stringify({ command: 'echo hello', autoApprove: true }),
      });

      const abort = new AbortController();
      const chunks: AgentChunk[] = [];
      const agent = agentManager.get('terminal-agent')!;

      startTrace({
        taskId: task.id,
        agentId: 'terminal-agent',
        domain: 'TERMINAL',
        executionMode: 'single-shot',
        input: task.description,
      });

      const runPromise = (async () => {
        for await (const chunk of agent.execute(task, abort.signal)) {
          chunks.push(chunk);
          if (chunk.type === 'done') break;
        }
      })();

      await runPromise;

      const textContent = chunks.filter(c => c.type === 'text').map(c => c.content).join('');
      const commandChunks = chunks.filter(c => c.type === 'command');

      // In test mode, autoApprove IS honored — command executes
      expect(commandChunks.length).toBe(1);
      expect(commandChunks[0].content).toBe('echo hello');
      expect(textContent).toContain('Auto-approved (TEST MODE ONLY');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  // ── Test 2: approval endpoint rejects unauthenticated requests (401) ──
  it('POST /api/ghost-mode/findings/:id/approve returns 401 without auth', async () => {
    const res = await fetch(`${BASE}/api/ghost-mode/findings/fake-id/approve`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/ghost-mode/findings/:id/reject returns 401 without auth', async () => {
    const res = await fetch(`${BASE}/api/ghost-mode/findings/fake-id/reject`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  // ── Test 3: approval endpoint rejects unknown findingId (404) ────────
  it('POST /api/ghost-mode/findings/:id/approve returns 404 for unknown findingId', async () => {
    const token = await getTestToken();
    const res = await fetch(`${BASE}/api/ghost-mode/findings/nonexistent-finding-id/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error?: string; reason?: string; approved?: boolean; rejected?: boolean; approvedBy?: string; };
    expect(body.error).toContain('not found');
  });

  // ── Test 4: approval endpoint rejects finding belonging to another user ──
  it('POST /api/ghost-mode/findings/:id/approve returns 403 for another user\'s finding', async () => {
    // Create a finding owned by 'user-A'
    const finding = ghostMode.reportFinding({
      type: 'terminal:command',
      severity: 'medium',
      description: 'echo test',
      userId: 'user-A',
      agentId: 'terminal-agent',
      taskId: 'task-A',
    });
    await ghostMode.planFix(finding);

    // Get a token for 'test-user-id' (different from 'user-A')
    const token = await getTestToken();

    const res = await fetch(`${BASE}/api/ghost-mode/findings/${finding.id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: string; reason?: string; approved?: boolean; rejected?: boolean; approvedBy?: string; };
    expect(body.reason).toBe('ownership_mismatch');
  });

  // ── Test 4b: approval endpoint rejects finding with no userId (fail closed) ──
  it('POST /api/ghost-mode/findings/:id/approve returns 403 for finding with no userId (fail closed)', async () => {
    // Create a finding with no userId (e.g. Sentinel ambient scan)
    const finding = ghostMode.reportFinding({
      type: 'sentinel:ambient-scan',
      severity: 'low',
      description: 'ambient finding',
      // no userId
    });
    await ghostMode.planFix(finding);

    const token = await getTestToken();
    const res = await fetch(`${BASE}/api/ghost-mode/findings/${finding.id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: string; reason?: string; approved?: boolean; rejected?: boolean; approvedBy?: string; };
    expect(body.reason).toBe('no_userId');
  });

  // ── Test 5: full flow — command proposed → approved via endpoint → executes ──
  it('full flow: command proposed → ghost:plan fires → endpoint approves → command executes (trace shows viaApprovalEndpoint)', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';  // production = no autoApprove

    try {
      const task = makeTask({
        description: JSON.stringify({ command: 'echo "real approval flow"', autoApprove: true }),
      });

      const abort = new AbortController();
      const chunks: AgentChunk[] = [];
      const agent = agentManager.get('terminal-agent')!;

      startTrace({
        taskId: task.id,
        agentId: 'terminal-agent',
        domain: 'TERMINAL',
        executionMode: 'single-shot',
        input: task.description,
      });

      // Start the agent — it will enter awaiting_approval and wait
      const runPromise = (async () => {
        for await (const chunk of agent.execute(task, abort.signal)) {
          chunks.push(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      // Wait for the agent to reach awaiting_approval
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify the agent is waiting
      expect(ghostMode.currentState).toBe('awaiting_approval');

      // Find the findingId from the trace
      const trace = getTrace(task.id);
      expect(trace).not.toBeNull();
      const reportStep = trace!.steps.find(s => s.label?.includes('ghostMode.reportFinding()'));
      expect(reportStep).toBeDefined();
      const findingId = reportStep!.meta!.findingId as string;
      expect(findingId).toBeDefined();

      // Approve via the real endpoint
      const token = await getTestToken();
      const approveRes = await fetch(`${BASE}/api/ghost-mode/findings/${findingId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(approveRes.status).toBe(200);
      const approveBody = await approveRes.json() as { approved?: boolean; approvedBy?: string; };
      expect(approveBody.approved).toBe(true);
      expect(approveBody.approvedBy).toBe('test-user-id');

      // Wait for the agent to complete
      await runPromise;

      // Verify the command executed
      const commandChunks = chunks.filter(c => c.type === 'command');
      expect(commandChunks.length).toBe(1);
      expect(commandChunks[0].content).toContain('echo "real approval flow"');

      // Verify the trace shows the approval came from the endpoint, NOT from autoApprove.
      // There should be at least one step with viaApprovalEndpoint=true — either
      // the route's addStep call or the agent's addStep call.
      const finalTrace = getTrace(task.id);
      expect(finalTrace).not.toBeNull();
      const endpointApproveSteps = finalTrace!.steps.filter(s => s.meta?.viaApprovalEndpoint === true);
      expect(endpointApproveSteps.length).toBeGreaterThan(0);

      // Verify the trace also shows autoApprove was IGNORED
      const ignoredStep = finalTrace!.steps.find(s => s.meta?.autoApproveIgnored === true);
      expect(ignoredStep).toBeDefined();

      // The trace must NOT contain a test-mode auto-approve step
      const testAutoApproveStep = finalTrace!.steps.find(s => s.meta?.viaTestAutoApprove === true);
      expect(testAutoApproveStep).toBeUndefined();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  // ── Test 6: full flow — command proposed → rejected via endpoint → NOT executed ──
  it('full flow: command proposed → endpoint rejects → command NOT executed (fail closed)', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const task = makeTask({
        description: JSON.stringify({ command: 'echo "should be rejected"', autoApprove: true }),
      });

      const abort = new AbortController();
      const chunks: AgentChunk[] = [];
      const agent = agentManager.get('terminal-agent')!;

      startTrace({
        taskId: task.id,
        agentId: 'terminal-agent',
        domain: 'TERMINAL',
        executionMode: 'single-shot',
        input: task.description,
      });

      const runPromise = (async () => {
        for await (const chunk of agent.execute(task, abort.signal)) {
          chunks.push(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      // Wait for awaiting_approval
      await new Promise(resolve => setTimeout(resolve, 500));

      // Find findingId
      const trace = getTrace(task.id);
      const reportStep = trace!.steps.find(s => s.label?.includes('ghostMode.reportFinding()'));
      const findingId = reportStep!.meta!.findingId as string;

      // Reject via the real endpoint
      const token = await getTestToken();
      const rejectRes = await fetch(`${BASE}/api/ghost-mode/findings/${findingId}/reject`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(rejectRes.status).toBe(200);
      const rejectBody = await rejectRes.json() as { rejected?: boolean; rejectedBy?: string; };
      expect(rejectBody.rejected).toBe(true);

      // Wait for the agent to complete (should be refused)
      await runPromise;

      // Verify the command did NOT execute
      const commandChunks = chunks.filter(c => c.type === 'command');
      expect(commandChunks.length).toBe(0);

      // Verify the trace shows rejection
      const finalTrace = getTrace(task.id);
      const rejectStep = finalTrace!.steps.find(s => s.meta?.reason === 'user_rejected');
      expect(rejectStep).toBeDefined();
      expect(rejectStep!.meta!.failClosed).toBe(true);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
