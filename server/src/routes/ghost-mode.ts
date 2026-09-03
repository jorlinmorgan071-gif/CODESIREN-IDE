// server/src/routes/ghost-mode.ts
// Approval-gate fix: REAL approval endpoints, separate from task creation.
//
//   POST /api/ghost-mode/findings/:findingId/approve   — requireAuth, verifies
//     the finding exists + belongs to req.user.id, calls ghostMode.approve(plan).
//   POST /api/ghost-mode/findings/:findingId/reject    — requireAuth, verifies
//     the finding exists + belongs to req.user.id, calls ghostMode.reject(plan).
//
// Neither endpoint accepts a body that bypasses verification — the finding
// must already exist in ghostMode's state, created by the agent's
// reportFinding() call, not invented by the request.
//
// This is the human-in-the-loop gate that the Terminal/Operative/Fabrication
// agents wait on. Same fail-closed discipline as writeProjectFile() when Code
// Review Agent isn't registered: refuse by default, only proceed on a positive,
// verified approval.

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { ghostMode } from '../orchestration/ghost-mode.js';
import { addStep } from '../observability/traces.js';

export const ghostModeRouter = Router();

/**
 * Verify the finding exists, belongs to the requesting user, and is in the
 * awaiting_approval state. Returns the finding + plan on success, or sends
 * an error response and returns null on failure.
 */
function verifyFindingOwnership(req: import('express').Request, res: import('express').Response): { finding: import('../types.js').GhostFinding; plan: import('../types.js').GhostPlan } | null {
  const { findingId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }

  const finding = ghostMode.getFinding(findingId);
  if (!finding) {
    res.status(404).json({ error: 'Finding not found', findingId });
    return null;
  }

  // Fail closed: if the finding has no userId (e.g. Sentinel ambient scan),
  // it cannot be approved via this endpoint — those findings don't gate
  // agent execution and don't need human approval.
  if (!finding.userId) {
    res.status(403).json({
      error: 'Finding has no associated user — cannot be approved via this endpoint',
      findingId,
      reason: 'no_userId',
    });
    return null;
  }

  // Verify ownership
  if (finding.userId !== userId) {
    res.status(403).json({
      error: 'Finding belongs to a different user',
      findingId,
      reason: 'ownership_mismatch',
    });
    return null;
  }

  // Verify state — must be awaiting_approval
  if (ghostMode.currentState !== 'awaiting_approval') {
    res.status(409).json({
      error: 'Finding is not in awaiting_approval state',
      findingId,
      currentState: ghostMode.currentState,
      reason: 'wrong_state',
    });
    return null;
  }

  const plan = ghostMode.getPlan(findingId);
  if (!plan) {
    res.status(404).json({ error: 'Plan not found for finding', findingId });
    return null;
  }

  return { finding, plan };
}

// ── Approve ─────────────────────────────────────────────────────────────

ghostModeRouter.post('/findings/:findingId/approve', requireAuth, async (req, res) => {
  const verified = verifyFindingOwnership(req, res);
  if (!verified) return;

  const { finding, plan } = verified;

  // Record the approval in the trace — this is the evidence that the approval
  // came from the authenticated endpoint, not from the task body.
  if (finding.taskId) {
    addStep(finding.taskId, {
      kind: 'tool-call',
      label: `ghostMode.approve() — via POST /api/ghost-mode/findings/${finding.id}/approve by user=${req.user?.id}`,
      meta: {
        viaApprovalEndpoint: true,
        approvedBy: req.user?.id,
        findingId: finding.id,
        agentId: finding.agentId,
        // Explicitly mark this is NOT from task body autoApprove
        autoApproveBypassed: false,
      },
    });
  }

  await ghostMode.approve(plan);

  res.json({
    approved: true,
    findingId: finding.id,
    state: ghostMode.currentState,
    approvedBy: req.user?.id,
  });
});

// ── Reject ──────────────────────────────────────────────────────────────

ghostModeRouter.post('/findings/:findingId/reject', requireAuth, async (req, res) => {
  const verified = verifyFindingOwnership(req, res);
  if (!verified) return;

  const { finding, plan } = verified;

  // Record the rejection in the trace
  if (finding.taskId) {
    addStep(finding.taskId, {
      kind: 'loop-guard',
      label: `ghostMode.reject() — via POST /api/ghost-mode/findings/${finding.id}/reject by user=${req.user?.id}`,
      meta: {
        viaApprovalEndpoint: true,
        rejectedBy: req.user?.id,
        findingId: finding.id,
        agentId: finding.agentId,
        failClosed: true,
      },
    });
  }

  await ghostMode.reject(plan);

  res.json({
    rejected: true,
    findingId: finding.id,
    state: ghostMode.currentState,
    rejectedBy: req.user?.id,
  });
});

// ── Read-only: list pending approvals for the requesting user ───────────
// Useful for the UI to poll on reconnect (in case WS events were missed).

ghostModeRouter.get('/pending', requireAuth, (_req, res) => {
  // The ghostMode singleton holds findings globally; we filter by user.
  // This is a read-only endpoint — no state transition.
  // Note: ghostMode doesn't expose a list-all-findings method, so we use
  // getFinding() per-known-ID. For now, return the current state + level
  // so the UI can decide whether to show the approval dialog.
  res.json({
    state: ghostMode.currentState,
    level: ghostMode.currentLevel,
    note: 'Per-user pending list not implemented — UI should rely on ghost:plan WS events. This endpoint returns global state only.',
  });
});

// ── D10 #3 closeout — Ghost Mode level endpoints ─────────────────────────
//
// Pre-closeout the StatusBar Ghost Mode dropdown dispatched only a local
// reducer action — the server stayed at 'approval-required' (hardcoded at
// boot from index.ts:82) regardless of what the user picked. The client
// GhostMode type also used short names ('observation'/'approval'/'auto'/
// 'autonomous') that didn't match the server's GhostModeLevel enum
// ('observation-only'/'approval-required'/'auto-amend'/'autonomous').
//
// These two new endpoints close that gap:
//   GET  /api/ghost-mode/level — returns the server's current GhostModeLevel
//   POST /api/ghost-mode/level — calls ghostMode.setLevel(level) to actually
//                                 transition the server's FSM
//
// The client GhostMode type was updated to match the server's enum 1:1.

const VALID_GHOST_MODE_LEVELS = ['observation-only', 'approval-required', 'auto-amend', 'autonomous'] as const;
type ValidGhostModeLevel = typeof VALID_GHOST_MODE_LEVELS[number];

function isGhostModeLevel(value: unknown): value is ValidGhostModeLevel {
  return typeof value === 'string' && (VALID_GHOST_MODE_LEVELS as readonly string[]).includes(value);
}

ghostModeRouter.get('/level', requireAuth, (_req, res) => {
  res.json({ level: ghostMode.currentLevel });
});

ghostModeRouter.post('/level', requireAuth, (req, res) => {
  const requested = req.body?.level;
  if (!isGhostModeLevel(requested)) {
    res.status(400).json({
      error: 'Invalid level — must be one of: observation-only, approval-required, auto-amend, autonomous',
      received: typeof requested === 'string' ? requested : typeof requested,
    });
    return;
  }
  const previousLevel = ghostMode.currentLevel;
  ghostMode.setLevel(requested);
  console.log(`[ghost-mode] level changed by user ${req.user?.id}: ${previousLevel} → ${requested}`);
  res.json({ level: ghostMode.currentLevel, previousLevel });
});
