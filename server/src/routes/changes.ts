import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { approveChangeTransaction, planChangeTransaction } from '../changes/transaction.js';
import { ProjectAccessError } from '../tenancy/scope.js';
import { WorkspaceAccessError } from '../workspace/service.js';

export const changesRouter = Router();

const planSchema = z.object({
  projectId: z.string().uuid().optional(),
  path: z.string().min(1).max(1024),
  before: z.string().min(1).max(20_000),
  after: z.string().max(20_000),
  expectedContent: z.string().max(1_000_000),
  mode: z.enum(['refactor', 'document', 'optimize', 'convert']),
});

changesRouter.post('/plan', requireAuth, async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid change plan', issues: parsed.error.issues });
    return;
  }
  try {
    const transaction = await planChangeTransaction({ userId: req.user!.id, ...parsed.data });
    res.status(201).json({
      transactionId: transaction.transactionId,
      traceId: transaction.traceId,
      projectId: transaction.projectId,
      path: transaction.path,
      status: transaction.status,
      diff: transaction.diff,
      impact: transaction.impact,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError || error instanceof WorkspaceAccessError) {
      res.status(403).json({ error: 'Workspace path access denied' });
      return;
    }
    res.status(409).json({ error: error instanceof Error ? error.message : 'Change plan could not be created' });
  }
});

changesRouter.post('/:transactionId/approve', requireAuth, async (req, res) => {
  try {
    const transaction = await approveChangeTransaction(req.user!.id, req.params.transactionId);
    const status = transaction.status === 'applied' ? 200 : transaction.status === 'rejected' ? 422 : 409;
    res.status(status).json(transaction);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Change transaction approval failed';
    res.status(message.includes('not found or not owned') ? 404 : 409).json({ error: message });
  }
});
