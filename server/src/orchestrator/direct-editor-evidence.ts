import { v4 as uuid } from 'uuid';
import type { EngineId } from '../types.js';
import { addStep, completeTrace, setOutcome, startTrace } from '../observability/traces.js';
import type { SessionScope } from '../tenancy/scope.js';

export type DirectEditorAction = 'completion' | 'explain' | 'refactor' | 'document' | 'optimize' | 'convert' | 'vision';
export type DirectEditorProvider = EngineId | 'z-ai-vision' | 'none-configured' | string;
export type DirectEditorOutputStatus = 'succeeded' | 'timed-out' | 'failed';
export type DirectEditorApplyStatus = 'not-applicable' | 'pending-approval';

export interface DirectEditorEvidence {
  taskId: string;
  traceId: string;
  action: DirectEditorAction;
  inputs: {
    fields: string[];
    characterCounts: Record<string, number>;
    language?: string;
    mode?: Exclude<DirectEditorAction, 'completion' | 'explain' | 'vision'>;
    imageRetained?: false;
  };
  provider: DirectEditorProvider;
  output: { status: DirectEditorOutputStatus; characterCount: number };
  apply: { status: DirectEditorApplyStatus };
  verification: { status: 'unverified' };
}

export interface DirectEditorEvidenceRun {
  evidence: DirectEditorEvidence;
  succeed(outputCharacterCount: number): DirectEditorEvidence;
  timeout(outputCharacterCount: number): DirectEditorEvidence;
  fail(): DirectEditorEvidence;
}

function applyStatusFor(action: DirectEditorAction): DirectEditorApplyStatus {
  return action === 'refactor' || action === 'document' || action === 'optimize' || action === 'convert'
    ? 'pending-approval'
    : 'not-applicable';
}

function finishEvidence(
  evidence: DirectEditorEvidence,
  status: DirectEditorOutputStatus,
  outputCharacterCount: number,
): DirectEditorEvidence {
  const completed: DirectEditorEvidence = {
    ...evidence,
    output: { status, characterCount: Math.max(0, outputCharacterCount) },
  };
  addStep(completed.traceId, {
    kind: status === 'failed' ? 'error' : 'llm-call',
    label: `direct editor ${completed.action} ${status}`,
    meta: { directEditor: completed },
    status: status === 'succeeded' ? 'succeeded' : status === 'timed-out' ? 'skipped' : 'failed',
  });
  setOutcome(completed.traceId, status === 'failed' ? 'error' : 'success', status === 'failed' ? `direct editor ${completed.action} failed` : undefined);
  completeTrace(completed.traceId, `direct editor ${completed.action} ${status}; output characters=${completed.output.characterCount}`);
  return completed;
}

export function startDirectEditorEvidence(input: {
  action: DirectEditorAction;
  scope: SessionScope;
  provider: DirectEditorProvider;
  inputs: DirectEditorEvidence['inputs'];
}): DirectEditorEvidenceRun {
  const taskId = uuid();
  const evidence: DirectEditorEvidence = {
    taskId,
    traceId: taskId,
    action: input.action,
    inputs: input.inputs,
    provider: input.provider,
    output: { status: 'failed', characterCount: 0 },
    apply: { status: applyStatusFor(input.action) },
    verification: { status: 'unverified' },
  };

  startTrace({
    taskId,
    agentId: `direct-editor-${input.action}`,
    domain: 'EDITOR',
    executionMode: 'single-shot',
    input: `direct editor action=${input.action}; declared inputs only`,
    scope: input.scope,
  });
  addStep(taskId, {
    kind: 'llm-call',
    label: `direct editor ${input.action} started`,
    meta: { directEditor: evidence },
    status: 'running',
  });

  return {
    evidence,
    succeed: (count) => finishEvidence(evidence, 'succeeded', count),
    timeout: (count) => finishEvidence(evidence, 'timed-out', count),
    fail: () => finishEvidence(evidence, 'failed', 0),
  };
}
