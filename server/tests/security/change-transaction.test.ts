import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import { getTrace } from '../../src/observability/traces.js';
import { approveChangeTransaction, planChangeTransaction, __test__ } from '../../src/changes/transaction.js';
import { resolveWorkspace, resolveWorkspacePath } from '../../src/workspace/service.js';

describe('authoritative change transaction', () => {
  beforeEach(() => {
    __test__.clearTransactions();
    vi.spyOn(agentManager, 'get').mockReturnValue({
      review: vi.fn().mockResolvedValue({ approved: true, score: 100, notes: 'approved', issues: [] }),
    } as any);
  });

  it('plans, approves, writes, rereads, diffs, and records exact verification for one owned workspace file', async () => {
    const userId = `transaction-user-${Date.now()}`;
    const workspace = await resolveWorkspace(userId);
    const path = 'src/example.ts';
    const fullPath = resolveWorkspacePath(workspace, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, 'export const answer = 1;\n', 'utf8');

    const planned = await planChangeTransaction({
      userId,
      projectId: workspace.projectId,
      path,
      before: '1',
      after: '42',
      expectedContent: 'export const answer = 1;\n',
      mode: 'refactor',
    });
    expect(planned.status).toBe('planned');
    expect(planned.diff).toContain('-export const answer = 1;');
    expect(planned.diff).toContain('+export const answer = 42;');
    expect(readFileSync(fullPath, 'utf8')).toContain('= 1');

    const applied = await approveChangeTransaction(userId, planned.transactionId);
    expect(applied.status).toBe('applied');
    expect(applied.content).toBe('export const answer = 42;\n');
    expect(applied.verification).toEqual({
      name: 'disk-reconcile',
      status: 'passed',
      detail: 'Disk reread exactly matches the approved patch',
    });
    expect(readFileSync(fullPath, 'utf8')).toBe(applied.content);
    expect(getTrace(planned.traceId, workspace)).toMatchObject({ verificationStatus: 'passed' });
  });

  it('refuses a stale plan instead of overwriting a newer disk edit', async () => {
    const userId = `transaction-stale-${Date.now()}`;
    const workspace = await resolveWorkspace(userId);
    const path = 'src/stale.ts';
    const fullPath = resolveWorkspacePath(workspace, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, 'export const state = "before";\n', 'utf8');
    const planned = await planChangeTransaction({
      userId,
      path,
      before: '"before"',
      after: '"after"',
      expectedContent: 'export const state = "before";\n',
      mode: 'refactor',
    });
    writeFileSync(fullPath, 'export const state = "newer";\n', 'utf8');

    const result = await approveChangeTransaction(userId, planned.transactionId);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('changed after planning');
    expect(readFileSync(fullPath, 'utf8')).toContain('"newer"');
  });

  it('refuses to plan when the editor snapshot differs from the current workspace file', async () => {
    const userId = `transaction-editor-stale-${Date.now()}`;
    const workspace = await resolveWorkspace(userId);
    const path = 'src/editor-stale.ts';
    const fullPath = resolveWorkspacePath(workspace, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, 'export const source = "disk";\n', 'utf8');

    await expect(planChangeTransaction({
      userId,
      path,
      before: '"buffer"',
      after: '"next"',
      expectedContent: 'export const source = "buffer";\n',
      mode: 'refactor',
    })).rejects.toThrow('editor buffer does not exactly match');
    expect(readFileSync(fullPath, 'utf8')).toBe('export const source = "disk";\n');
  });

  it('locks approval before the review await so only one concurrent request can write', async () => {
    const userId = `transaction-race-${Date.now()}`;
    const workspace = await resolveWorkspace(userId);
    const path = 'src/race.ts';
    const fullPath = resolveWorkspacePath(workspace, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, 'export const version = 1;\n', 'utf8');
    const planned = await planChangeTransaction({ userId, path, before: '1', after: '2', expectedContent: 'export const version = 1;\n', mode: 'refactor' });

    const results = await Promise.allSettled([
      approveChangeTransaction(userId, planned.transactionId),
      approveChangeTransaction(userId, planned.transactionId),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(readFileSync(fullPath, 'utf8')).toBe('export const version = 2;\n');
  });

  it('does not disclose or approve another user’s transaction', async () => {
    const ownerId = `transaction-owner-${Date.now()}`;
    const workspace = await resolveWorkspace(ownerId);
    const path = 'src/private.ts';
    const fullPath = resolveWorkspacePath(workspace, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, 'export const privateValue = 1;\n', 'utf8');
    const planned = await planChangeTransaction({ userId: ownerId, path, before: '1', after: '2', expectedContent: 'export const privateValue = 1;\n', mode: 'refactor' });

    await expect(approveChangeTransaction(`transaction-other-${Date.now()}`, planned.transactionId))
      .rejects.toThrow('not found or not owned');
    expect(readFileSync(fullPath, 'utf8')).toBe('export const privateValue = 1;\n');
  });
});
