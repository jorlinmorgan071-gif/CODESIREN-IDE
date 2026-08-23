// server/src/routes/workflow.ts
// Phase B: Workflow Automation — REST routes.
//
//   GET    /api/workflow               — list all workflows
//   POST   /api/workflow               — create/update a workflow
//   DELETE /api/workflow/:id           — delete a workflow
//   POST   /api/workflow/:id/run       — run a workflow manually
//   POST   /api/workflow/:id/schedule  — start/stop scheduled trigger
//   GET    /api/workflow/:id           — get a single workflow

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import {
  getWorkflows,
  getWorkflow,
  saveWorkflow,
  deleteWorkflow,
  validateWorkflow,
  hasWriteSteps,
} from '../orchestration/workflow-settings.js';
import { runWorkflow, startScheduledWorkflow, stopScheduledWorkflow } from '../orchestration/workflow-runner.js';

export const workflowRouter = Router();

// Workflow definitions and scheduled runs currently have no project/user owner
// in their persistence model. Serving them to authenticated users would expose
// shared state, so P0 deliberately makes this surface unavailable until an
// owned workflow model exists instead of guessing a tenant boundary.
workflowRouter.use(requireAuth, (_req, res) => {
  res.status(503).json({
    error: 'Workflow automation is unavailable until project ownership is implemented',
  });
});

// GET /api/workflow — list all
workflowRouter.get('/', requireAuth, (_req, res) => {
  res.json({ workflows: getWorkflows() });
});

// GET /api/workflow/:id — get one
workflowRouter.get('/:id', requireAuth, (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  res.json({ workflow: wf });
});

// POST /api/workflow — create or update
workflowRouter.post('/', requireAuth, (req, res) => {
  const { valid, error, workflow } = validateWorkflow(req.body);
  if (!valid) {
    res.status(400).json({ error });
    return;
  }
  const saved = saveWorkflow(workflow!);
  res.json({ workflow: workflow!, workflows: saved });
});

// DELETE /api/workflow/:id — delete
workflowRouter.delete('/:id', requireAuth, (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  stopScheduledWorkflow(req.params.id);
  const remaining = deleteWorkflow(req.params.id);
  res.json({ deleted: true, workflows: remaining });
});

// POST /api/workflow/:id/run — run manually
workflowRouter.post('/:id/run', requireAuth, async (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }

  // Check for write-capable steps — return warning in response
  const hasWrite = hasWriteSteps(wf);

  // Run the workflow (async — don't block the HTTP response for long-running workflows)
  try {
    const result = await runWorkflow(wf);
    res.json({ result, hadWriteWarning: hasWrite });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/workflow/:id/schedule — start or stop scheduled trigger
workflowRouter.post('/:id/schedule', requireAuth, (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  if (wf.trigger !== 'scheduled') {
    res.status(400).json({ error: 'Workflow is not a scheduled type' });
    return;
  }

  const { action } = req.body ?? {};
  if (action === 'start') {
    startScheduledWorkflow(wf);
    res.json({ scheduled: true, workflowId: wf.id });
  } else if (action === 'stop') {
    stopScheduledWorkflow(wf.id);
    res.json({ scheduled: false, workflowId: wf.id });
  } else {
    res.status(400).json({ error: 'action must be "start" or "stop"' });
  }
});
