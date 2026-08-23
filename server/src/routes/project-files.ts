// server/src/routes/project-files.ts
// Test route for the writeProjectFile funnel (Fix 3 evidence).
//   POST /api/project-files/write   attempts a write through the Code Review gate

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { writeProjectFile } from '../agents/_shared/project-files.js';
import { v4 as uuid } from 'uuid';
import { ProjectAccessError } from '../tenancy/scope.js';
import { WorkspaceAccessError, resolveWorkspace, resolveWorkspacePath } from '../workspace/service.js';

export const projectFilesRouter = Router();

const writeSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
  agentId: z.string().default('backend-agent'),
  projectId: z.string().uuid().optional(),
});

projectFilesRouter.post('/write', requireAuth, async (req, res) => {
  const parsed = writeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  let workspace;
  let fullPath: string;
  try {
    workspace = await resolveWorkspace(req.user!.id, parsed.data.projectId);
    fullPath = resolveWorkspacePath(workspace, parsed.data.path);
  } catch (error) {
    if (error instanceof ProjectAccessError || error instanceof WorkspaceAccessError) {
      res.status(403).json({ error: 'Workspace path access denied' });
      return;
    }
    throw error;
  }
  const traceId = uuid();
  const result = await writeProjectFile(parsed.data.agentId, fullPath, parsed.data.content, traceId);
  res.json({ ...result, traceId, projectId: workspace.projectId });
});
