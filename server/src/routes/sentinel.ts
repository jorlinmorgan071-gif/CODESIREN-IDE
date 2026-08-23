// server/src/routes/sentinel.ts
// Sentinel Agent API — directive Section 6.
//   POST /api/sentinel/watch     register a watch
//   GET  /api/sentinel/watches   list watches
//   POST /api/sentinel/scan      trigger a scan (delegates to SentinelAgent via AgentManager.send)
//   GET  /api/sentinel/health    sentinel + ghost mode status

import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { agentManager } from '../orchestration/agent-manager.js';
import { ghostMode } from '../orchestration/ghost-mode.js';
import { registerWatch, listWatches, removeWatch } from '../agents/sentinel/index.js';
import type { AgentTask } from '../types.js';

export const sentinelRouter = Router();

// Watches are stored in a global singleton without user/project metadata. P0
// must not expose, scan, mutate, or summarize another tenant's watches, so this
// router is explicitly unavailable until the watch registry becomes owned.
sentinelRouter.use(requireAuth, (_req, res) => {
  res.status(503).json({
    error: 'Sentinel watches are unavailable until project ownership is implemented',
  });
});

const watchSchema = z.object({
  watchType: z.string().min(1),
  config: z.record(z.unknown()).default({}),
});

sentinelRouter.post('/watch', requireAuth, (req, res) => {
  const parsed = watchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const watch = registerWatch(parsed.data);
  res.status(201).json({ watch });
});

sentinelRouter.get('/watches', requireAuth, (_req, res) => {
  res.json({ watches: listWatches() });
});

sentinelRouter.delete('/watch/:id', requireAuth, (req, res) => {
  const ok = removeWatch(req.params.id);
  res.json({ removed: ok });
});

sentinelRouter.post('/scan', requireAuth, async (req, res) => {
  const agent = agentManager.get('sentinel-agent');
  if (!agent) { res.status(503).json({ error: 'Sentinel Agent not registered' }); return; }

  const projectId = '00000000-0000-0000-0000-000000000000';
  const task: AgentTask = {
    id: uuid(), projectId, sessionId: projectId, agentId: 'sentinel-agent',
    type: 'monitor', description: JSON.stringify({ action: 'scan' }),
    context: { projectId, rootPath: '/tmp/code-siren-step-9', techStack: {}, activeFiles: [] },
    priority: 'normal', executionMode: 'single-shot', origin: 'api', createdAt: Date.now(),
  };
  agentManager.send(task).catch((err) => console.error(`[sentinel] scan failed:`, err));
  res.status(202).json({ taskId: task.id, agentId: 'sentinel-agent', status: 'accepted' });
});

sentinelRouter.get('/health', requireAuth, (_req, res) => {
  res.json({
    ghostMode: {
      state: ghostMode.currentState,
      level: ghostMode.currentLevel,
    },
    watches: listWatches().length,
  });
});
