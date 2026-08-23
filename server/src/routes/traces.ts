import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listTraces, getTrace } from '../observability/traces.js';
import { ProjectAccessError, resolveTenantScope } from '../tenancy/scope.js';

export const tracesRouter = Router();

function projectIdFrom(req: any): string | undefined {
  return typeof req.query.projectId === 'string' && req.query.projectId.length > 0 ? req.query.projectId : undefined;
}

async function scopeFor(req: any) {
  return resolveTenantScope(req.user!.id, projectIdFrom(req));
}

function scopeError(res: any, error: unknown): boolean {
  if (error instanceof ProjectAccessError) {
    res.status(403).json({ error: 'Project access denied' });
    return true;
  }
  return false;
}

tracesRouter.get('/', requireAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req);
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const executionMode = typeof req.query.executionMode === 'string'
      ? (req.query.executionMode as 'single-shot' | 'react' | 'codeact')
      : undefined;
    const limit = Math.min(typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || 100 : 100, 1000);
    const traces = listTraces({ agentId, executionMode, limit, scope });
    res.json({ count: traces.length, traces, projectId: scope.projectId });
  } catch (error) {
    if (scopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to list traces' });
  }
});

tracesRouter.get('/file/preview', requireAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req);
    // The physical path and global line count are server-wide metadata; exposing
    // either would reveal other tenants' activity. Only report scoped availability.
    res.json({ projectId: scope.projectId, persistentTraceStore: true });
  } catch (error) {
    if (scopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to inspect trace store' });
  }
});

tracesRouter.get('/:taskId', requireAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req);
    const trace = getTrace(req.params.taskId, scope);
    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }
    res.json({ trace });
  } catch (error) {
    if (scopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to get trace' });
  }
});
