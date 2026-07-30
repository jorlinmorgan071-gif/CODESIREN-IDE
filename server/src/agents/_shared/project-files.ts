// server/src/agents/_shared/project-files.ts
// The SINGLE funnel for any agent writing a project source file to disk.
//
// Per Fix 3: no agent calls fs.writeFileSync directly for source files.
// Every write goes through writeProjectFile(), which:
//   1. Calls CodeReviewAgent.review() FIRST
//   2. Refuses the write on approved: false
//   3. Only touches fs on approved: true
//
// Explicitly OUT OF SCOPE: face-factor.ts's biometric template write
// stays exactly as-is — untraced, un-reviewed, isolated. That exemption
// was deliberate (Step 10), not an oversight.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentManager } from '../../orchestration/agent-manager.js';
import type { ReviewResult } from '../../types.js';
import { addStep, addToolResult } from '../../observability/traces.js';

export interface ProjectFileWriteResult {
  written: boolean;
  path: string;
  review: ReviewResult;
  reason?: string;
}

/**
 * Write a project source file to disk, gated by Code Review.
 *
 * This is the ONLY function agents should call to persist source files.
 * It calls CodeReviewAgent.review() first — if the review rejects the
 * content (approved: false), the file is NOT written.
 *
 * @param agentId The agent attempting the write
 * @param filePath Absolute path to the file
 * @param content The file content
 * @param traceId Optional trace ID for recording the review step
 * @returns { written, path, review, reason }
 */
export async function writeProjectFile(
  agentId: string,
  filePath: string,
  content: string,
  traceId?: string,
): Promise<ProjectFileWriteResult> {
  // 1. Get the Code Review Agent
  const codeReviewAgent = agentManager.get('code-review-agent');
  if (!codeReviewAgent) {
    // If Code Review Agent isn't registered, refuse the write — fail closed
    const result: ProjectFileWriteResult = {
      written: false,
      path: filePath,
      review: { approved: false, score: 0, notes: 'Code Review Agent not registered', issues: ['Code Review Agent unavailable — write refused (fail closed)'] },
      reason: 'Code Review Agent not registered',
    };
    if (traceId) {
      addStep(traceId, {
        kind: 'loop-guard',
        label: `writeProjectFile REFUSED — Code Review Agent not registered`,
        meta: { agentId, filePath, failClosed: true },
      });
    }
    return result;
  }

  // 2. Call CodeReviewAgent.review() — the gate
  if (traceId) {
    addStep(traceId, {
      kind: 'tool-call',
      label: `codeReviewAgent.review() — gating write to ${filePath}`,
      input: { agentId, filePath, contentPreview: content.slice(0, 200) },
      meta: { viaInterface: true, gate: true },
    });
  }

  const review = await codeReviewAgent.review({ content, files: [filePath] });

  if (traceId) {
    addStep(traceId, {
      kind: review.approved ? 'tool-call' : 'loop-guard',
      label: review.approved
        ? `codeReviewAgent.review() → APPROVED (score: ${review.score})`
        : `codeReviewAgent.review() → REJECTED (score: ${review.score}, issues: ${review.issues.length})`,
      output: { approved: review.approved, score: review.score, notes: review.notes, issues: review.issues },
      meta: { viaInterface: true, gate: true, approved: review.approved, score: review.score },
    });
    addToolResult(traceId, {
      name: 'codeReviewAgent.review',
      args: { agentId, filePath, contentLength: content.length },
      result: review.approved ? `approved (score: ${review.score})` : `rejected (score: ${review.score}, ${review.issues.length} issues)`,
      success: review.approved,
    });
  }

  // 3. If rejected, refuse the write — do NOT touch fs
  if (!review.approved) {
    return {
      written: false,
      path: filePath,
      review,
      reason: `Code Review rejected: ${review.issues.join('; ')}`,
    };
  }

  // 4. Approved — write the file
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content, 'utf8');

    if (traceId) {
      addStep(traceId, {
        kind: 'done',
        label: `writeProjectFile → written ${filePath} (${content.length} chars)`,
        meta: { written: true, filePath, contentLength: content.length },
      });
    }

    return {
      written: true,
      path: filePath,
      review,
    };
  } catch (err: any) {
    return {
      written: false,
      path: filePath,
      review,
      reason: `fs error: ${err.message}`,
    };
  }
}
