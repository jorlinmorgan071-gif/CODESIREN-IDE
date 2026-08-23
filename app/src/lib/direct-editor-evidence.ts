import type { DirectEditorEvidence } from './api';

/** Formats server-derived evidence without implying a proposed edit was applied or verified. */
export function summarizeDirectEditorEvidence(evidence: DirectEditorEvidence): string {
  return `Task ${evidence.taskId} used ${evidence.provider}; output ${evidence.output.status}; apply ${evidence.apply.status}; verification ${evidence.verification.status}.`;
}
