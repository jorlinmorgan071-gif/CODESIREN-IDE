import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { contextManager } from '../../src/context/manager.js';
import { resolveWorkspace, resolveWorkspacePath, sanitizeWorkspacePaths } from '../../src/workspace/service.js';
import { appendSessionMessage, clearSessionHistory, getSessionHistory } from '../../src/orchestrator/tier1-chat.js';
import type { AgentTask } from '../../src/types.js';

const USER_A = `workspace-user-a-${Date.now()}`;
const USER_B = `workspace-user-b-${Date.now()}`;
const roots = new Set<string>();

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceService P0 identity and root boundaries', () => {
  it('returns a stable managed workspace identity for the same user', async () => {
    const first = await resolveWorkspace(USER_A);
    const second = await resolveWorkspace(USER_A);
    roots.add(first.rootPath);

    expect(second.projectId).toBe(first.projectId);
    expect(second.rootPath).toBe(first.rootPath);
    expect(first.rootPath).toContain(first.projectId);
  });

  it('refuses a project identity owned by another user', async () => {
    const ownerWorkspace = await resolveWorkspace(USER_A);
    roots.add(ownerWorkspace.rootPath);

    await expect(resolveWorkspace(USER_B, ownerWorkspace.projectId)).rejects.toThrow('Project not found or not owned');
  });

  it('scopes in-memory chat history by stable project identity', async () => {
    const workspaceA = await resolveWorkspace(USER_A);
    const workspaceB = await resolveWorkspace(USER_B);
    roots.add(workspaceA.rootPath);
    roots.add(workspaceB.rootPath);
    const sharedClientSessionLabel = `browser-session-${Date.now()}`;

    appendSessionMessage(sharedClientSessionLabel, { role: 'user', content: 'tenant A message' }, workspaceA);
    appendSessionMessage(sharedClientSessionLabel, { role: 'user', content: 'tenant B message' }, workspaceB);

    expect(getSessionHistory(sharedClientSessionLabel, workspaceA).map(message => message.content)).toEqual(['tenant A message']);
    expect(getSessionHistory(sharedClientSessionLabel, workspaceB).map(message => message.content)).toEqual(['tenant B message']);
    clearSessionHistory(sharedClientSessionLabel, workspaceA);
    clearSessionHistory(sharedClientSessionLabel, workspaceB);
  });

  it('rejects absolute paths, traversal, and symlinks that resolve outside the selected workspace', async () => {
    const workspace = await resolveWorkspace(USER_A);
    roots.add(workspace.rootPath);
    const outsideRoot = join(dirname(workspace.rootPath), `outside-${Date.now()}`);
    const outsideFile = join(outsideRoot, 'private.txt');
    const linkPath = join(workspace.rootPath, 'outside-link.txt');
    const linkDirectory = join(workspace.rootPath, 'outside-directory');
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(outsideFile, 'private content', 'utf8');
    symlinkSync(outsideFile, linkPath);
    symlinkSync(outsideRoot, linkDirectory, 'dir');

    expect(() => resolveWorkspacePath(workspace, '../private.txt')).toThrow('escapes the selected workspace');
    expect(() => resolveWorkspacePath(workspace, outsideFile)).toThrow('relative paths');
    expect(() => resolveWorkspacePath(workspace, 'outside-link.txt', { mustExist: true })).toThrow('resolves outside');
    expect(() => resolveWorkspacePath(workspace, 'outside-directory/new-file.ts')).toThrow('resolves outside');
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  it('omits invalid editor paths and never reads them into a context bundle', async () => {
    const workspace = await resolveWorkspace(USER_A);
    roots.add(workspace.rootPath);
    const allowedPath = join(workspace.rootPath, 'src', 'allowed.ts');
    const outsideFile = join(dirname(workspace.rootPath), `secret-${Date.now()}.ts`);
    mkdirSync(dirname(allowedPath), { recursive: true });
    writeFileSync(allowedPath, 'export const allowed = true;', 'utf8');
    writeFileSync(outsideFile, 'export const secret = true;', 'utf8');

    expect(sanitizeWorkspacePaths(workspace, ['src/allowed.ts', '../secret.ts', outsideFile])).toEqual(['src/allowed.ts']);

    const task: AgentTask = {
      id: `workspace-context-${Date.now()}`,
      projectId: workspace.projectId,
      sessionId: `workspace-session-${Date.now()}`,
      agentId: 'architect-agent',
      type: 'chat',
      description: 'inspect workspace files',
      context: {
        projectId: workspace.projectId,
        rootPath: workspace.rootPath,
        userId: workspace.userId,
        techStack: {},
        activeFiles: ['src/allowed.ts', `../${outsideFile.split('/').pop()}`],
      },
      priority: 'normal',
      executionMode: 'single-shot',
      origin: 'chat',
      createdAt: Date.now(),
    };

    const bundle = await contextManager.assemble({ userId: workspace.userId, agentId: task.agentId, task, modelId: '' });
    expect(bundle.openFiles.map(file => file.path)).toEqual(['src/allowed.ts']);
    expect(bundle.openFiles.some(file => file.content.includes('secret'))).toBe(false);
    rmSync(outsideFile, { force: true });
  });
});
