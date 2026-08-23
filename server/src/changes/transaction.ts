import { readFileSync } from 'node:fs';
import { v4 as uuid } from 'uuid';
import { writeProjectFile, type ProjectFileWriteResult } from '../agents/_shared/project-files.js';
import { analyzeChangeImpact, type ChangeImpactAnalysis } from './impact.js';
import { addStep, addVerification, completeTrace, setOutcome, startTrace } from '../observability/traces.js';
import { resolveWorkspace, resolveWorkspacePath, workspaceRelativePath, type WorkspaceIdentity } from '../workspace/service.js';

export type ChangeTransactionStatus = 'planned' | 'applying' | 'rejected' | 'applied' | 'failed';

export interface ChangePlanInput {
  userId: string;
  projectId?: string;
  path: string;
  before: string;
  after: string;
  expectedContent: string;
  mode: 'refactor' | 'document' | 'optimize' | 'convert';
}

export interface ChangeTransactionResult {
  transactionId: string;
  traceId: string;
  projectId: string;
  path: string;
  status: ChangeTransactionStatus;
  diff: string;
  impact?: ChangeImpactAnalysis;
  verification?: { name: 'disk-reconcile'; status: 'passed' | 'failed'; detail: string };
  reason?: string;
  content?: string;
}

interface ChangeTransaction extends ChangeTransactionResult {
  workspace: WorkspaceIdentity;
  absolutePath: string;
  originalContent: string;
  replacementContent: string;
}

const transactions = new Map<string, ChangeTransaction>();

function exactReplacement(original: string, before: string, after: string): string {
  if (!before) throw new Error('A change transaction requires a non-empty selected source range');
  const first = original.indexOf(before);
  if (first === -1) throw new Error('The selected source range no longer matches the workspace file');
  if (original.indexOf(before, first + before.length) !== -1) {
    throw new Error('The selected source range is ambiguous; narrow the selection before applying a change');
  }
  return `${original.slice(0, first)}${after}${original.slice(first + before.length)}`;
}

function makeDiff(path: string, before: string, after: string): string {
  // This is evidence of the exact server-side patch, not a model-written summary.
  // Do not truncate the content: the returned diff must describe the complete
  // planned replacement that can later be approved.
  return `--- ${path}\n+++ ${path}\n@@ authoritative change transaction @@\n-${before}\n+${after}`;
}

export async function planChangeTransaction(input: ChangePlanInput): Promise<ChangeTransactionResult> {
  const workspace = await resolveWorkspace(input.userId, input.projectId);
  const absolutePath = resolveWorkspacePath(workspace, input.path, { mustExist: true });
  const relativePath = workspaceRelativePath(workspace, input.path);
  const originalContent = readFileSync(absolutePath, 'utf8');
  if (originalContent !== input.expectedContent) {
    throw new Error('The editor buffer does not exactly match the current workspace file; reload before planning a change');
  }
  const replacementContent = exactReplacement(originalContent, input.before, input.after);
  const transactionId = uuid();
  const traceId = transactionId;
  const diff = makeDiff(relativePath, originalContent, replacementContent);
  const impact = analyzeChangeImpact({
    workspace,
    path: relativePath,
    before: originalContent,
    after: replacementContent,
  });

  startTrace({
    taskId: traceId,
    agentId: 'change-transaction-service',
    domain: 'ARCHITECT',
    executionMode: 'single-shot',
    input: `Plan ${input.mode} change for ${relativePath}`,
    scope: { userId: workspace.userId, projectId: workspace.projectId },
  });
  addStep(traceId, {
    kind: 'parse',
    label: `change transaction planned for ${relativePath}`,
    meta: { transactionId, mode: input.mode, path: relativePath, stage: 'plan', exactReplacement: true },
  });
  addStep(traceId, {
    kind: 'parse',
    label: `impact analysis ${impact.status} for ${relativePath}`,
    meta: {
      transactionId,
      stage: 'impact-analysis',
      status: impact.status,
      dependentCount: impact.dependents.length,
      testCount: impact.tests.length,
      verificationCount: impact.verification.length,
    },
  });

  const transaction: ChangeTransaction = {
    transactionId,
    traceId,
    projectId: workspace.projectId,
    path: relativePath,
    status: 'planned',
    diff,
    impact,
    workspace,
    absolutePath,
    originalContent,
    replacementContent,
  };
  transactions.set(transactionId, transaction);
  return transaction;
}

export async function approveChangeTransaction(userId: string, transactionId: string): Promise<ChangeTransactionResult> {
  const transaction = transactions.get(transactionId);
  if (!transaction || transaction.workspace.userId !== userId) {
    throw new Error('Change transaction not found or not owned by the authenticated user');
  }
  if (transaction.status !== 'planned') {
    throw new Error(`Change transaction is already ${transaction.status}`);
  }

  addStep(transaction.traceId, {
    kind: 'tool-call',
    label: `change transaction approved by authenticated owner for ${transaction.path}`,
    meta: { transactionId, stage: 'approval', approved: true },
  });
  // Lock before awaiting the review gate so concurrent approval requests
  // cannot race a second write for the same immutable transaction.
  transaction.status = 'applying';

  let currentContent: string;
  try {
    currentContent = readFileSync(transaction.absolutePath, 'utf8');
  } catch {
    transaction.status = 'failed';
    transaction.reason = 'Workspace file could not be reread before apply';
    setOutcome(transaction.traceId, 'error', transaction.reason);
    completeTrace(transaction.traceId, transaction.reason);
    return transaction;
  }
  if (currentContent !== transaction.originalContent) {
    transaction.status = 'failed';
    transaction.reason = 'Workspace file changed after planning; transaction refused without overwriting newer disk content';
    addVerification(transaction.traceId, { name: 'disk-reconcile', kind: 'custom', status: 'failed', output: transaction.reason });
    setOutcome(transaction.traceId, 'error', transaction.reason);
    completeTrace(transaction.traceId, transaction.reason);
    return transaction;
  }

  const writeResult: ProjectFileWriteResult = await writeProjectFile(
    'change-transaction-service',
    transaction.absolutePath,
    transaction.replacementContent,
    transaction.traceId,
  );
  if (!writeResult.written) {
    transaction.status = 'rejected';
    transaction.reason = writeResult.reason ?? 'Code review rejected the transaction';
    addVerification(transaction.traceId, { name: 'disk-reconcile', kind: 'custom', status: 'skipped', output: transaction.reason });
    setOutcome(transaction.traceId, 'loop-blocked', transaction.reason);
    completeTrace(transaction.traceId, transaction.reason);
    return transaction;
  }

  const persisted = readFileSync(transaction.absolutePath, 'utf8');
  const verified = persisted === transaction.replacementContent;
  transaction.status = verified ? 'applied' : 'failed';
  transaction.content = verified ? persisted : undefined;
  transaction.verification = {
    name: 'disk-reconcile',
    status: verified ? 'passed' : 'failed',
    detail: verified ? 'Disk reread exactly matches the approved patch' : 'Disk reread did not match the approved patch',
  };
  if (!verified) transaction.reason = transaction.verification.detail;

  addVerification(transaction.traceId, {
    name: 'disk-reconcile',
    kind: 'custom',
    status: verified ? 'succeeded' : 'failed',
    output: transaction.verification.detail,
  });
  addStep(transaction.traceId, {
    kind: verified ? 'done' : 'error',
    label: `change transaction ${verified ? 'reconciled' : 'failed reconciliation'} for ${transaction.path}`,
    meta: { transactionId, stage: 'verification', verified, path: transaction.path },
  });
  setOutcome(transaction.traceId, verified ? 'success' : 'error', transaction.reason);
  completeTrace(transaction.traceId, transaction.verification.detail);
  return transaction;
}

export const __test__ = {
  clearTransactions: () => transactions.clear(),
};
