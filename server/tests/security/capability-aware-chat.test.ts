import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ArchitectAgent } from '../../src/agents/architect/index.js';
import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';
import { executeWorkspaceFileRead } from '../../src/orchestration/capabilities/workspace-file-read.js';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import { getTrace } from '../../src/observability/traces.js';
import { createCapabilityChangePlan } from '../../src/orchestrator/relay-loop.js';
import { selectNormalChatCapability } from '../../src/orchestrator/normal-chat-capabilities.js';
import { runChatViaAgentManager } from '../../src/orchestrator/tier1-chat.js';
import { getPlan } from '../../src/orchestrator/plans-repo.js';
import { resolveWorkspace, resolveWorkspacePath } from '../../src/workspace/service.js';

const userId = `capability-chat-user-${Date.now()}`;
const roots = new Set<string>();

beforeAll(() => {
  if (!agentManager.get('architect-agent')) agentManager.register(new ArchitectAgent());
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('P1 capability-aware normal chat', () => {
  it('selects and records a real workspace_file_read capability for an owned read-and-explain request', async () => {
    const workspace = await resolveWorkspace(userId);
    roots.add(workspace.rootPath);
    const path = 'src/explain-me.ts';
    const fullPath = resolveWorkspacePath(workspace, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, 'export const capabilityProof = "real disk content";\n', 'utf8');

    const taskId = `capability-read-${Date.now()}`;
    await runChatViaAgentManager(
      `session-${Date.now()}`,
      'Read and explain the active file.',
      taskId,
      workspace,
      { activeFile: path, openFiles: [path] },
      workspace,
    );

    const trace = getTrace(taskId);
    expect(trace?.toolResults).toContainEqual(expect.objectContaining({
      name: 'workspace_file_read',
      args: { path },
      success: true,
    }));
    expect(trace?.steps).toContainEqual(expect.objectContaining({
      kind: 'tool-call',
      status: 'succeeded',
      meta: expect.objectContaining({ capability: 'read-explain', path }),
    }));
    expect(trace?.outcome).toBe('error');
    expect(trace?.errorMessage).toContain('No synthetic explanation was generated');
    expect(trace?.verificationStatus).toBe('unverified');
  });

  it('keeps the scoped reader out of the global registry and refuses traversal', async () => {
    const workspace = await resolveWorkspace(userId);
    roots.add(workspace.rootPath);
    expect(toolRegistry.get('workspace_file_read')).toBeUndefined();
    expect(toolRegistry.get('code_interpreter')).toBeDefined();

    const denied = await executeWorkspaceFileRead(workspace, '../outside.ts');
    expect(denied.success).toBe(false);
    expect(denied.content).toMatch(/escapes|relative/i);
  });

  it('turns a fix/test request into a persistent review-only draft with a real-verification requirement', async () => {
    const workspace = await resolveWorkspace(userId);
    roots.add(workspace.rootPath);
    const request = 'Fix the failing authentication tests.';
    expect(selectNormalChatCapability(request, 'src/auth.ts')).toEqual({ kind: 'change-plan' });

    const record = await createCapabilityChangePlan(`session-${Date.now()}`, workspace, request);
    const persisted = await getPlan(record.id);
    expect(persisted?.status).toBe('draft');
    expect(persisted?.engine).toBe('capability-policy');
    expect(persisted?.approvalMode).toBe('default');
    const verificationMilestone = persisted?.plan.milestones.find((milestone) => milestone.id === 'M03');
    expect(verificationMilestone?.assignedAgent).toBe('qa-tester-agent');
    expect(verificationMilestone?.acceptanceCriteria.join(' ')).toMatch(/real verifier|failed, skipped, or unavailable/i);
    expect(persisted?.plan.summary).toContain('No file was changed and no test was run');
  });

  it('keeps ambiguous requests in general chat rather than granting a capability by inference', () => {
    expect(selectNormalChatCapability('Could you help me think through this?', 'src/auth.ts')).toEqual({ kind: 'general-chat' });
    expect(selectNormalChatCapability('Explain the project architecture', 'src/auth.ts')).toEqual({ kind: 'general-chat' });
    expect(selectNormalChatCapability('Read the file and tell me what you see', 'src/auth.ts')).toEqual({ kind: 'general-chat' });
    expect(selectNormalChatCapability('Read and explain the file')).toEqual({ kind: 'general-chat' });
  });
});
