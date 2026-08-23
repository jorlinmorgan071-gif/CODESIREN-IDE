import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { memoryEngine } from '../memory/engine.js';
import { ProjectAccessError, SessionAccessError, ensureOwnedSession, resolveTenantScope } from '../tenancy/scope.js';

export const memoryRouter = Router();

function requestedProjectId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requestedSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function resolveRequestScope(req: Parameters<typeof memoryRouter.get>[1] extends never ? never : any) {
  const scope = await resolveTenantScope(req.user!.id, requestedProjectId(req.query.projectId));
  const sessionId = requestedSessionId(req.query.sessionId);
  if (!sessionId) throw new SessionAccessError('A session ID is required for memory access');
  return ensureOwnedSession(scope, sessionId);
}

function sendScopeError(res: any, err: unknown): boolean {
  if (err instanceof ProjectAccessError || err instanceof SessionAccessError) {
    res.status(403).json({ error: 'Memory scope access denied' });
    return true;
  }
  return false;
}

memoryRouter.get('/', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(typeof req.query.limit === 'string' ? req.query.limit : '500', 10) || 500, 1000);
  const offset = Math.max(parseInt(typeof req.query.offset === 'string' ? req.query.offset : '0', 10) || 0, 0);
  try {
    const scope = await resolveRequestScope(req);
    const entries = await memoryEngine.list(limit, offset, scope);
    const total = await memoryEngine.count(scope);
    res.json({ entries, total, limit, offset, hasMore: offset + entries.length < total, projectId: scope.projectId, sessionId: scope.sessionId });
  } catch (err: any) {
    if (sendScopeError(res, err)) return;
    res.status(500).json({ error: 'Failed to list memories' });
  }
});

memoryRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    const scope = await resolveRequestScope(req);
    const deleted = await memoryEngine.delete(req.params.id, scope);
    if (!deleted) {
      // Do not reveal whether an entry exists outside this tenant scope.
      res.status(404).json({ error: 'Memory not found' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  } catch (err: any) {
    if (sendScopeError(res, err)) return;
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

memoryRouter.get('/:id', requireAuth, async (req, res) => {
  try {
    const scope = await resolveRequestScope(req);
    const entry = await memoryEngine.get(req.params.id, scope);
    if (!entry) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }
    res.json(entry);
  } catch (err: any) {
    if (sendScopeError(res, err)) return;
    res.status(500).json({ error: 'Failed to get memory' });
  }
});
