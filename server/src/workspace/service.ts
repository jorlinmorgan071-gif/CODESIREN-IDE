import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDbAvailable, memGet, memSet, query } from '../db/client.js';
import { ProjectAccessError, resolveTenantScope, type TenantScope } from '../tenancy/scope.js';

export interface WorkspaceIdentity extends TenantScope {
  name: string;
  /** Canonical, server-resolved workspace root. Never accept this from a client. */
  rootPath: string;
}

interface StoredWorkspaceProject {
  id: string;
  userId: string;
  name: string;
  rootPath: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_STORE = resolve(__dirname, '..', '..', '.workspaces');
const PROJECT_PREFIX = 'project:';

function projectKey(projectId: string): string {
  return `${PROJECT_PREFIX}${projectId}`;
}

export function managedWorkspaceRoot(userId: string, projectId: string): string {
  // The project ID is part of the path to avoid two projects owned by the same
  // user silently sharing a mutable working directory.
  return resolve(WORKSPACE_STORE, userId, projectId);
}

export class WorkspaceAccessError extends ProjectAccessError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function ensureCanonicalDirectory(rootPath: string): string {
  try {
    mkdirSync(rootPath, { recursive: true, mode: 0o700 });
    const stat = lstatSync(rootPath);
    if (!stat.isDirectory()) {
      throw new WorkspaceAccessError('Configured workspace root is not a directory');
    }
    return realpathSync(rootPath);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw error;
    throw new WorkspaceAccessError('Workspace root could not be prepared');
  }
}

function assertExistingAncestorIsContained(rootPath: string, candidatePath: string): void {
  let ancestor = candidatePath;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new WorkspaceAccessError('Workspace path could not be resolved');
    ancestor = parent;
  }
  const canonicalAncestor = realpathSync(ancestor);
  if (!isContained(rootPath, canonicalAncestor)) {
    throw new WorkspaceAccessError('Workspace path resolves outside the selected workspace');
  }
}

function normalizeRelativePath(rawPath: string): string {
  if (!rawPath || rawPath.includes('\0') || isAbsolute(rawPath)) {
    throw new WorkspaceAccessError('Workspace file paths must be non-empty relative paths');
  }
  // Backslashes are valid Linux filename characters but accepting them as a
  // path separator makes platform-specific traversal policy ambiguous.
  if (rawPath.includes('\\')) {
    throw new WorkspaceAccessError('Workspace file paths must use forward slashes');
  }
  return rawPath;
}

async function loadOwnedProject(scope: TenantScope): Promise<StoredWorkspaceProject> {
  if (isDbAvailable()) {
    const rows = await query<{ id: string; user_id: string; name: string; root_path: string }>(
      `SELECT id, user_id, name, root_path
       FROM projects
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [scope.projectId, scope.userId],
    );
    const project = rows[0];
    if (!project) throw new WorkspaceAccessError('Project not found or not owned by the authenticated user');
    return {
      id: project.id,
      userId: project.user_id,
      name: project.name,
      rootPath: project.root_path,
    };
  }

  const project = memGet<Partial<StoredWorkspaceProject>>(projectKey(scope.projectId));
  if (!project || project.userId !== scope.userId) {
    throw new WorkspaceAccessError('Project not found or not owned by the authenticated user');
  }
  const rootPath = project.rootPath ?? managedWorkspaceRoot(scope.userId, scope.projectId);
  const hydrated: StoredWorkspaceProject = {
    id: scope.projectId,
    userId: scope.userId,
    name: project.name ?? 'Personal Workspace',
    rootPath,
  };
  memSet(projectKey(scope.projectId), hydrated);
  return hydrated;
}

/**
 * The authoritative project/workspace resolver. It rechecks ownership through
 * the existing tenant resolver, reads the durable project root, and returns a
 * canonical root path. Browser-supplied filesystem roots are never an input.
 */
export async function resolveWorkspace(userId: string, requestedProjectId?: string): Promise<WorkspaceIdentity> {
  const scope = await resolveTenantScope(userId, requestedProjectId);
  const project = await loadOwnedProject(scope);
  return {
    userId: scope.userId,
    projectId: scope.projectId,
    name: project.name,
    rootPath: ensureCanonicalDirectory(project.rootPath),
  };
}

/**
 * Resolve a client/editor relative path below an already-authorized workspace.
 * Existing files are realpath-checked, preventing a symlink in the workspace
 * from becoming a read/write escape hatch.
 */
export function resolveContainedWorkspacePath(rootPath: string, rawPath: string, options: { mustExist?: boolean } = {}): string {
  const relativePath = normalizeRelativePath(rawPath);
  const canonicalRoot = ensureCanonicalDirectory(rootPath);
  const candidate = resolve(canonicalRoot, relativePath);
  if (!isContained(canonicalRoot, candidate)) {
    throw new WorkspaceAccessError('Workspace path escapes the selected workspace');
  }
  assertExistingAncestorIsContained(canonicalRoot, candidate);

  if (!existsSync(candidate)) {
    if (options.mustExist) throw new WorkspaceAccessError('Workspace file does not exist');
    return candidate;
  }

  const canonicalCandidate = realpathSync(candidate);
  if (!isContained(canonicalRoot, canonicalCandidate)) {
    throw new WorkspaceAccessError('Workspace path resolves outside the selected workspace');
  }
  return canonicalCandidate;
}

export function resolveWorkspacePath(workspace: WorkspaceIdentity, rawPath: string, options: { mustExist?: boolean } = {}): string {
  return resolveContainedWorkspacePath(workspace.rootPath, rawPath, options);
}

export function workspaceRelativePath(workspace: WorkspaceIdentity, rawPath: string): string {
  const absolute = resolveWorkspacePath(workspace, rawPath);
  const rel = relative(workspace.rootPath, absolute);
  if (!rel || rel === '.') throw new WorkspaceAccessError('Workspace root is not a file path');
  return rel.split(sep).join('/');
}

/** Resolve several client-provided editor paths without allowing one invalid path to widen the boundary. */
export function sanitizeWorkspacePaths(workspace: WorkspaceIdentity, paths: string[] = []): string[] {
  const valid = new Set<string>();
  for (const path of paths) {
    try {
      valid.add(workspaceRelativePath(workspace, path));
    } catch {
      // A malformed editor tab is omitted instead of broadening file access.
    }
  }
  return [...valid];
}
