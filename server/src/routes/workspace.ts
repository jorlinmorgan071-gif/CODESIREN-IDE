import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { ProjectAccessError } from '../tenancy/scope.js';
import { WorkspaceAccessError, resolveWorkspace, resolveWorkspacePath, workspaceRelativePath } from '../workspace/service.js';

export const workspaceRouter = Router();

const MAX_WORKSPACE_FILE_BYTES = 1_000_000;
const MAX_WORKSPACE_FILE_COUNT = 200;
const MAX_WORKSPACE_DEPTH = 8;
const SKIPPED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache']);
const projectQuery = z.object({ projectId: z.string().uuid().optional() });
const fileQuery = projectQuery.extend({ path: z.string().min(1) });

interface WorkspaceFileDescriptor {
  path: string;
  name: string;
  size: number;
}

function listWorkspaceFiles(rootPath: string): WorkspaceFileDescriptor[] {
  const files: WorkspaceFileDescriptor[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > MAX_WORKSPACE_DEPTH || files.length >= MAX_WORKSPACE_FILE_COUNT) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= MAX_WORKSPACE_FILE_COUNT) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) visit(resolve(directory, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = resolve(directory, entry.name);
      const stat = lstatSync(fullPath);
      if (!stat.isFile() || stat.size > MAX_WORKSPACE_FILE_BYTES) continue;
      const path = relative(rootPath, fullPath).split('\\').join('/');
      if (!path || path.startsWith('../')) continue;
      files.push({ path, name: basename(fullPath), size: stat.size });
    }
  };
  visit(rootPath, 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

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

workspaceRouter.get('/files', requireAuth, async (req, res) => {
  const parsed = projectQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid workspace selection' });
    return;
  }
  try {
    const workspace = await resolveWorkspace(req.user!.id, parsed.data.projectId);
    res.json({ projectId: workspace.projectId, files: listWorkspaceFiles(workspace.rootPath) });
  } catch (error) {
    if (error instanceof ProjectAccessError || error instanceof WorkspaceAccessError) {
      res.status(403).json({ error: 'Project access denied' });
      return;
    }
    res.status(500).json({ error: 'Workspace file inventory failed' });
  }
});

workspaceRouter.get('/file', requireAuth, async (req, res) => {
  const parsed = fileQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid workspace file request' });
    return;
  }
  try {
    const workspace = await resolveWorkspace(req.user!.id, parsed.data.projectId);
    const absolutePath = resolveWorkspacePath(workspace, parsed.data.path, { mustExist: true });
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_WORKSPACE_FILE_BYTES) {
      res.status(400).json({ error: 'Workspace file is not available for editing' });
      return;
    }
    const path = workspaceRelativePath(workspace, parsed.data.path);
    res.json({ projectId: workspace.projectId, path, content: readFileSync(absolutePath, 'utf8') });
  } catch (error) {
    if (error instanceof ProjectAccessError || error instanceof WorkspaceAccessError) {
      res.status(403).json({ error: 'Workspace file access denied' });
      return;
    }
    res.status(500).json({ error: 'Workspace file read failed' });
  }
});
