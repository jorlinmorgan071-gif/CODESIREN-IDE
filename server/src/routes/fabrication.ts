// server/src/routes/fabrication.ts
// Fabrication API — directive Section 6.
//   POST /api/fabrication/generate          generate CAD from a prompt (Step 4)
//   POST /api/fabrication/fabricate-print   full pipeline: CAD → slice → print (Step 5)
//   POST /api/fabrication/slice             slice an existing STL (Step 5)
//   POST /api/fabrication/discover          discover printers (Step 5)
//   GET  /api/fabrication/health            sidecar + printer client status
//   POST /api/fabrication/crash-test        deliberately crash the sidecar (lifecycle proof)

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { agentManager } from '../orchestration/agent-manager.js';
import { sidecarManager, ensureBuild123dSidecar, SidecarCrashedError } from '../sidecars/manager.js';
import { getPrinterClient } from '../agents/fabrication/printer-client.js';
import { v4 as uuid } from 'uuid';
import type { AgentTask, TaskType } from '../types.js';

export const fabricationRouter = Router();

const generateSchema = z.object({
  prompt: z.string().min(1).max(4000),
  projectId: z.string().uuid().optional(),
});

fabricationRouter.post('/generate', requireAuth, async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const agent = agentManager.get('fabrication-agent');
  if (!agent) {
    res.status(503).json({ error: 'Fabrication Agent not registered' });
    return;
  }

  const projectId = parsed.data.projectId ?? '00000000-0000-0000-0000-000000000000';
  const task: AgentTask = {
    id: uuid(),
    projectId,
    sessionId: projectId,
    agentId: 'fabrication-agent',
    type: 'fabricate-cad',
    description: parsed.data.prompt,
    context: {
      projectId,
      rootPath: '/tmp/code-siren-step-4',
      techStack: {},
      activeFiles: [],
      // Approval-gate fix: pass userId so the agent can tag findings
      userId: req.user?.id,
    },
    priority: 'normal',
    executionMode: 'single-shot',
    origin: 'api',
    createdAt: Date.now(),
  };

  agentManager.send(task).catch((err) => {
    console.error(`[fabrication] send failed for ${task.id}:`, err);
  });

  res.status(202).json({
    taskId: task.id,
    agentId: 'fabrication-agent',
    status: 'accepted',
    stream: `ws://localhost:${process.env.PORT ?? 3001}/ws?token=${req.headers.authorization?.slice(7) ?? ''}&projectId=${projectId}`,
  });
});

// Step 5: full pipeline — CAD → slice → print
fabricationRouter.post('/fabricate-print', requireAuth, async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const agent = agentManager.get('fabrication-agent');
  if (!agent) {
    res.status(503).json({ error: 'Fabrication Agent not registered' });
    return;
  }

  const projectId = parsed.data.projectId ?? '00000000-0000-0000-0000-000000000000';
  const task: AgentTask = {
    id: uuid(),
    projectId,
    sessionId: projectId,
    agentId: 'fabrication-agent',
    type: 'fabricate-print' as TaskType,
    description: parsed.data.prompt,
    // Approval-gate fix: pass userId so the agent can tag the print-submission
    // finding. Without this, the approval endpoint would 403 with 'no_userId'
    // and the user could never approve the print.
    context: { projectId, rootPath: '/tmp/code-siren-step-5', techStack: {}, activeFiles: [], userId: req.user?.id },
    priority: 'normal',
    executionMode: 'single-shot',
    origin: 'api',
    createdAt: Date.now(),
  };

  agentManager.send(task).catch((err) => {
    console.error(`[fabrication] fabricate-print send failed for ${task.id}:`, err);
  });

  res.status(202).json({
    taskId: task.id,
    agentId: 'fabrication-agent',
    type: 'fabricate-print',
    status: 'accepted',
    stream: `ws://localhost:${process.env.PORT ?? 3001}/ws?token=${req.headers.authorization?.slice(7) ?? ''}&projectId=${projectId}`,
  });
});

// Step 5: slice an existing STL
const sliceSchema = z.object({
  stlPath: z.string().min(1),
  projectId: z.string().uuid().optional(),
});

fabricationRouter.post('/slice', requireAuth, async (req, res) => {
  const parsed = sliceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const agent = agentManager.get('fabrication-agent');
  if (!agent) {
    res.status(503).json({ error: 'Fabrication Agent not registered' });
    return;
  }

  const projectId = parsed.data.projectId ?? '00000000-0000-0000-0000-000000000000';
  const task: AgentTask = {
    id: uuid(),
    projectId,
    sessionId: projectId,
    agentId: 'fabrication-agent',
    type: 'slice' as TaskType,
    description: parsed.data.stlPath,
    context: { projectId, rootPath: '/tmp/code-siren-step-5', techStack: {}, activeFiles: [], userId: req.user?.id },
    priority: 'normal',
    executionMode: 'single-shot',
    origin: 'api',
    createdAt: Date.now(),
  };

  agentManager.send(task).catch((err) => {
    console.error(`[fabrication] slice send failed for ${task.id}:`, err);
  });

  res.status(202).json({
    taskId: task.id,
    agentId: 'fabrication-agent',
    type: 'slice',
    status: 'accepted',
  });
});

// Step 5: discover printers
fabricationRouter.post('/discover', requireAuth, async (req, res) => {
  const agent = agentManager.get('fabrication-agent');
  if (!agent) {
    res.status(503).json({ error: 'Fabrication Agent not registered' });
    return;
  }

  const projectId = '00000000-0000-0000-0000-000000000000';
  const task: AgentTask = {
    id: uuid(),
    projectId,
    sessionId: projectId,
    agentId: 'fabrication-agent',
    type: 'discover' as TaskType,
    description: 'discover printers',
    context: { projectId, rootPath: '/tmp/code-siren-step-5', techStack: {}, activeFiles: [], userId: req.user?.id },
    priority: 'normal',
    executionMode: 'single-shot',
    origin: 'api',
    createdAt: Date.now(),
  };

  agentManager.send(task).catch((err) => {
    console.error(`[fabrication] discover send failed for ${task.id}:`, err);
  });

  res.status(202).json({
    taskId: task.id,
    agentId: 'fabrication-agent',
    type: 'discover',
    status: 'accepted',
  });
});

fabricationRouter.get('/health', requireAuth, (_req, res) => {
  const printerClient = getPrinterClient();
  res.json({
    sidecars: sidecarManager.list().map((name) => ({
      name,
      running: sidecarManager.isRunning(name),
    })),
    printerClient: {
      implementation: printerClient.implementation,
    },
  });
});

fabricationRouter.post('/crash-test', requireAuth, async (_req, res) => {
  ensureBuild123dSidecar();
  const beforeRunning = sidecarManager.isRunning('build123d');
  const beforePid = sidecarManager.isRunning('build123d')
    ? (sidecarManager as any).children.get('build123d')?.child?.pid
    : null;

  let crashError: string | null = null;
  let crashErrorName: string | null = null;
  try {
    await sidecarManager.request('build123d', { type: 'crash' }, 5000);
  } catch (err: any) {
    crashError = err.message;
    crashErrorName = err.name;
  }

  await new Promise((r) => setTimeout(r, 500));

  const afterRunning = sidecarManager.isRunning('build123d');

  let recoveryOk = false;
  try {
    ensureBuild123dSidecar();
    await new Promise((r) => setTimeout(r, 500));
    const pingResp = await sidecarManager.request('build123d', { type: 'ping' }, 5000);
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
