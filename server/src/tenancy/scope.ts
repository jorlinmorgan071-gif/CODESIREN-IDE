import { v4 as uuid } from 'uuid';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDbAvailable, memGet, memSet, query } from '../db/client.js';

export interface TenantScope {
  userId: string;
  projectId: string;
}

export class ProjectAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectAccessError';
  }
}

const PERSONAL_PROJECT_PREFIX = 'personal-project:';
const PROJECT_PREFIX = 'project:';
const __dirname = dirname(fileURLToPath(import.meta.url));
const MANAGED_WORKSPACES_DIR = resolve(__dirname, '..', '..', '.workspaces');

function managedWorkspaceRoot(userId: string, projectId: string): string {
  return resolve(MANAGED_WORKSPACES_DIR, userId, projectId);
}

function personalProjectKey(userId: string): string {
  return `${PERSONAL_PROJECT_PREFIX}${userId}`;
}

function projectKey(projectId: string): string {
  return `${PROJECT_PREFIX}${projectId}`;
}

export function scopesMatch(a: TenantScope | undefined, b: TenantScope | undefined): boolean {
  return Boolean(a && b && a.userId === b.userId && a.projectId === b.projectId);
}

/**
 * Resolve a user-owned project server-side. A missing project creates or returns
 * the user's personal workspace; a client-supplied project must already belong
 * to that same user. This deliberately avoids trusting a raw project ID from a
 * request body or WebSocket query string.
 */
export async function resolveTenantScope(userId: string, requestedProjectId?: string): Promise<TenantScope> {
  if (!userId) throw new ProjectAccessError('Authenticated user identity is required');

  if (requestedProjectId) {
    const owned = await isProjectOwnedByUser(userId, requestedProjectId);
    if (!owned) throw new ProjectAccessError('Project not found or not owned by the authenticated user');
    return { userId, projectId: requestedProjectId };
  }

  const projectId = await ensurePersonalProject(userId);
  return { userId, projectId };
}

export async function isProjectOwnedByUser(userId: string, projectId: string): Promise<boolean> {
  if (isDbAvailable()) {
    const rows = await query<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2 LIMIT 1',
      [projectId, userId],
    );
    return rows.length === 1;
  }

  const project = memGet<{ id: string; userId: string }>(projectKey(projectId));
  return project?.userId === userId;
}

export async function ensurePersonalProject(userId: string): Promise<string> {
  if (isDbAvailable()) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM projects
       WHERE user_id = $1 AND metadata->>'systemManaged' = 'true'
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId],
    );
    if (existing[0]?.id) return existing[0].id;

    const projectId = uuid();
    const rootPath = managedWorkspaceRoot(userId, projectId);
    await query(
      `INSERT INTO projects (id, user_id, name, root_path, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        projectId,
        userId,
        'Personal Workspace',
        rootPath,
        JSON.stringify({ systemManaged: true, kind: 'personal-workspace' }),
      ],
    );
    return projectId;
  }

  const existing = memGet<string>(personalProjectKey(userId));
  if (existing) return existing;

  const projectId = uuid();
  const rootPath = managedWorkspaceRoot(userId, projectId);
  memSet(personalProjectKey(userId), projectId);
  memSet(projectKey(projectId), { id: projectId, userId, name: 'Personal Workspace', rootPath });
  return projectId;
}
