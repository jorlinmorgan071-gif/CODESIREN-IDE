// server/src/routes/operative.ts
// Operative Agent API — directive Section 6.
//   POST /api/operative/browse                assign a browser automation task (Step 6)
//   POST /api/operative/device                assign a smart-home device command (Step 7)
//   POST /api/operative/kasa-crash-test       kasa sidecar lifecycle proof (Step 7 condition)
//   GET  /api/operative/health                browser + device client status

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { agentManager } from '../orchestration/agent-manager.js';
import { getBrowserClient } from '../agents/operative/browser-client.js';
import { getDeviceClient } from '../agents/operative/device-client.js';
import { sidecarManager } from '../sidecars/manager.js';
import { v4 as uuid } from 'uuid';
import type { AgentTask } from '../types.js';

export const operativeRouter = Router();

// ── Browser (Step 6) ─────────────────────────────────────────────────────

const browseSchema = z.object({
  actions: z.union([z.array(z.record(z.unknown())), z.record(z.unknown())]).optional(),
  prompt: z.string().optional(),
  projectId: z.string().uuid().optional(),
});

operativeRouter.post('/browse', requireAuth, async (req, res) => {
  const parsed = browseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const agent = agentManager.get('operative-agent');
  if (!agent) { res.status(503).json({ error: 'Operative Agent not registered' }); return; }

  const projectId = parsed.data.projectId ?? '00000000-0000-0000-0000-000000000000';
  const description = parsed.data.actions ? JSON.stringify(parsed.data.actions) : parsed.data.prompt ?? 'navigate to https://example.com';
  const task: AgentTask = {
    id: uuid(), projectId, sessionId: projectId, agentId: 'operative-agent',
    type: 'browse', description,
    // Approval-gate fix: pass userId so the agent can tag findings for write
    // browser actions (navigate/click/type/evaluate/scroll). Without this,
    // the approval endpoint would 403 with 'no_userId' and the user could
    // never approve the action.
    context: { projectId, rootPath: '/tmp/code-siren-step-6', techStack: {}, activeFiles: [], userId: req.user?.id },
    priority: 'normal', executionMode: 'single-shot', origin: 'api', createdAt: Date.now(),
  };
  agentManager.send(task).catch((err) => console.error(`[operative] browse failed:`, err));
  res.status(202).json({ taskId: task.id, agentId: 'operative-agent', status: 'accepted', browserClient: getBrowserClient().implementation });
});

// ── Smart-home device control (Step 7) ───────────────────────────────────

const deviceSchema = z.object({
  command: z.enum(['discover', 'turn_on', 'turn_off', 'set_brightness', 'set_color']),
  target: z.string().optional(),
  brightness: z.number().int().min(0).max(100).optional(),
  color: z.union([z.string(), z.tuple([z.number(), z.number(), z.number()])]).optional(),
  projectId: z.string().uuid().optional(),
});

operativeRouter.post('/device', requireAuth, async (req, res) => {
  const parsed = deviceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const agent = agentManager.get('operative-agent');
  if (!agent) { res.status(503).json({ error: 'Operative Agent not registered' }); return; }

  const projectId = parsed.data.projectId ?? '00000000-0000-0000-0000-000000000000';
  const task: AgentTask = {
    id: uuid(), projectId, sessionId: projectId, agentId: 'operative-agent',
    type: 'device-command', description: JSON.stringify(parsed.data),
    // Approval-gate fix: pass userId so the agent can tag findings for write
    // device commands (turn_on/turn_off/set_brightness/set_color).
    context: { projectId, rootPath: '/tmp/code-siren-step-7', techStack: {}, activeFiles: [], userId: req.user?.id },
    priority: 'normal', executionMode: 'single-shot', origin: 'api', createdAt: Date.now(),
  };
  agentManager.send(task).catch((err) => console.error(`[operative] device failed:`, err));
  res.status(202).json({ taskId: task.id, agentId: 'operative-agent', status: 'accepted', deviceClient: getDeviceClient().implementation });
});

// ── Kasa sidecar lifecycle proof (Step 7 condition) ──────────────────────
// Same two proofs as build123d in Step 4, re-proven for kasa specifically:
//   (a) crash → SidecarCrashedError → fresh sidecar spawned (no hang)
//   (b) sidecar is direct child of Node (no orphan)

operativeRouter.post('/kasa-crash-test', requireAuth, async (_req, res) => {
  // Force-ensure the kasa sidecar is running
  const deviceClient = getDeviceClient();
  // Trigger a discover to ensure the sidecar is spawned
  await deviceClient.discoverDevices().catch(() => {});

  const beforeRunning = sidecarManager.isRunning('kasa');
  const beforePid = beforeRunning
    ? (sidecarManager as any).children.get('kasa')?.child?.pid
    : null;

  let crashError: string | null = null;
  let crashErrorName: string | null = null;
  try {
    await sidecarManager.request('kasa', { type: 'crash' }, 5000);
  } catch (err: any) {
    crashError = err.message;
    crashErrorName = err.name;
  }

  await new Promise((r) => setTimeout(r, 500));
  const afterRunning = sidecarManager.isRunning('kasa');

  // Recovery: spawn fresh + ping
  let recoveryOk = false;
  try {
    // The next deviceClient call will re-spawn via ensureSidecar()
    await deviceClient.discoverDevices();
    await new Promise((r) => setTimeout(r, 300));
    const pingResp = await sidecarManager.request('kasa', { type: 'ping' }, 5000);
    recoveryOk = pingResp.ok === true && (pingResp as any).pong === true;
  } catch {
    recoveryOk = false;
  }

  res.json({
    before: { running: beforeRunning, pid: beforePid },
    crash: { caught: crashError !== null, error: crashError, errorName: crashErrorName },
    after: { running: afterRunning },
    recovery: { ok: recoveryOk },
  });
});

// ── Health ───────────────────────────────────────────────────────────────

operativeRouter.get('/health', requireAuth, (_req, res) => {
  res.json({
    browserClient: { implementation: getBrowserClient().implementation },
    deviceClient: { implementation: getDeviceClient().implementation },
    sidecars: sidecarManager.list().map((name) => ({ name, running: sidecarManager.isRunning(name) })),
  });
});
