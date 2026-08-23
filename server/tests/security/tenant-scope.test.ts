import { describe, expect, it } from 'vitest';
import { completeTrace, getTrace, listTraces, startTrace } from '../../src/observability/traces.js';
import { SessionAccessError, ensureOwnedSession, ensurePersonalProject, resolveTenantScope, scopesMatch } from '../../src/tenancy/scope.js';
import { getActiveTenantScope, runWithTenantScope } from '../../src/tenancy/execution-scope.js';

const SCOPE_A = { userId: 'p0-user-a', projectId: 'p0-project-a' };
const SCOPE_B = { userId: 'p0-user-b', projectId: 'p0-project-b' };

describe('P0 tenant scope boundaries', () => {
  it('requires exact user and project matches', () => {
    expect(scopesMatch(SCOPE_A, SCOPE_A)).toBe(true);
    expect(scopesMatch(SCOPE_A, SCOPE_B)).toBe(false);
    expect(scopesMatch(SCOPE_A, { userId: 'p0-user-a', projectId: 'p0-project-b' })).toBe(false);
    expect(scopesMatch(SCOPE_A, undefined)).toBe(false);
  });

  it('creates a stable personal project in degraded mode and refuses foreign project access', async () => {
    const ownerScope = await resolveTenantScope('p0-owner');
    expect(ownerScope.userId).toBe('p0-owner');
    expect(ownerScope.projectId).toBe(await ensurePersonalProject('p0-owner'));
    await expect(resolveTenantScope('p0-attacker', ownerScope.projectId)).rejects.toThrow('Project not found or not owned');
  });

  it('creates an owned durable-session identity and rejects a foreign owner from reusing it', async () => {
    const ownerScope = await resolveTenantScope(`memory-owner-${Date.now()}`);
    const foreignScope = await resolveTenantScope(`memory-attacker-${Date.now()}`);
    const sessionId = crypto.randomUUID();
    const sessionScope = await ensureOwnedSession(ownerScope, sessionId);

    expect(sessionScope).toEqual({ ...ownerScope, sessionId });
    await expect(ensureOwnedSession(foreignScope, sessionId)).rejects.toBeInstanceOf(SessionAccessError);
  });

  it('propagates a session scope through asynchronous execution without collapsing it to project scope', async () => {
    const scope = { ...SCOPE_A, sessionId: '26a9801b-8079-45f4-9b7f-3bd9f9e3fc95' };
    const observed = await runWithTenantScope(scope, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return getActiveTenantScope();
    });
    expect(observed).toEqual(scope);
  });

  it('lists traces only for their exact owner and project', () => {
    const taskA = `p0-trace-a-${Date.now()}`;
    const taskB = `p0-trace-b-${Date.now()}`;
    startTrace({ taskId: taskA, agentId: 'architect-agent', domain: 'ARCHITECT', executionMode: 'single-shot', input: 'tenant A private request', scope: SCOPE_A });
    startTrace({ taskId: taskB, agentId: 'architect-agent', domain: 'ARCHITECT', executionMode: 'single-shot', input: 'tenant B private request', scope: SCOPE_B });
    completeTrace(taskA, 'A done');
    completeTrace(taskB, 'B done');

    const tracesA = listTraces({ scope: SCOPE_A, limit: 1000 });
    const tracesB = listTraces({ scope: SCOPE_B, limit: 1000 });
    expect(tracesA.some(trace => trace.taskId === taskA)).toBe(true);
    expect(tracesA.some(trace => trace.taskId === taskB)).toBe(false);
    expect(tracesB.some(trace => trace.taskId === taskB)).toBe(true);
    expect(tracesB.some(trace => trace.taskId === taskA)).toBe(false);
    expect(getTrace(taskA, SCOPE_B)).toBeNull();
  });

  it('keeps concurrent asynchronous execution scopes isolated', async () => {
    const observed = await Promise.all([
      runWithTenantScope(SCOPE_A, async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return getActiveTenantScope();
      }),
      runWithTenantScope(SCOPE_B, async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return getActiveTenantScope();
      }),
    ]);

    expect(observed).toEqual([SCOPE_A, SCOPE_B]);
  });
});
