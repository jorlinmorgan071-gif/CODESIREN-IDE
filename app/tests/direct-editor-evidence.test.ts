import { describe, expect, it } from 'vitest';
import { summarizeDirectEditorEvidence } from '../src/lib/direct-editor-evidence';
import type { DirectEditorEvidence } from '../src/lib/api';

const proposedEdit: DirectEditorEvidence = {
  taskId: 'task-direct-editor',
  traceId: 'task-direct-editor',
  action: 'refactor',
  inputs: { fields: ['code', 'mode'], characterCounts: { code: 20 } },
  provider: 'ollama',
  output: { status: 'succeeded', characterCount: 42 },
  apply: { status: 'pending-approval' },
  verification: { status: 'unverified' },
};

describe('direct editor evidence summary', () => {
  it('preserves server-derived pending approval and unverified status without claiming an edit ran', () => {
    expect(summarizeDirectEditorEvidence(proposedEdit))
      .toBe('Task task-direct-editor used ollama; output succeeded; apply pending-approval; verification unverified.');
  });
});
