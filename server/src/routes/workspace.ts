import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { ProjectAccessError } from '../tenancy/scope.js';
import { WorkspaceAccessError, resolveWorkspace } from '../workspace/service.js';

export const workspaceRouter = Router();

workspaceRouter.get('/current', requireAuth, async (req, res) => {
  const requestedProjectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
  try {
    const workspace = await resolveWorkspace(req.user!.id, requestedProjectId);
    // The root path is intentionally server-private. Clients need a stable
    // project identity for REST/WS subscription, not filesystem coordinates.
    res.json({ projectId: workspace.projectId, name: workspace.name });
  } catch (error) {
    if (error instanceof ProjectAccessError || error instanceof WorkspaceAccessError) {
      res.status(403).json({ error: 'Project access denied' });
      return;
    }
    res.status(500).json({ error: 'Workspace resolution failed' });
  }
});
