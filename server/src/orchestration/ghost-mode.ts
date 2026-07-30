// server/src/orchestration/ghost-mode.ts
// Ghost Mode FSM — PDF Section 16.
//
// States:  inactive → scanning → detected → planning → awaiting_approval →
//          applying → verifying → complete | rolled_back
// Levels:  observation-only | approval-required | auto-amend | autonomous
//
// Per directive Section 7: the Sentinel Agent (Step 9) reuses THIS state machine
// shape rather than inventing a parallel one for the Personal Pillar.

import { v4 as uuid } from 'uuid';
import type { GhostState, GhostModeLevel, GhostFinding, GhostPlan } from '../types.js';
import { makeEvent, broadcast } from '../ws/events.js';

const TRANSITIONS: Record<GhostState, GhostState[]> = {
  inactive:          ['scanning'],
  scanning:          ['inactive', 'detected'],
  detected:          ['scanning', 'planning'],
  planning:          ['awaiting_approval', 'applying'],
  awaiting_approval: ['applying', 'rolled_back', 'scanning'],  // approval-gate fix: allow awaiting_approval → rolled_back (reject path)
  applying:          ['verifying', 'rolled_back'],
  verifying:         ['complete', 'rolled_back'],
  complete:          ['scanning'],
  rolled_back:       ['scanning'],
};

class GhostModeMachine {
  private state: GhostState = 'inactive';
  private level: GhostModeLevel = 'approval-required';
  private scanTimer: NodeJS.Timeout | null = null;
  private findings = new Map<string, GhostFinding>();
  private plans = new Map<string, GhostPlan>();
  // Approval-gate fix: track which findings were approved vs rejected, so
  // the waiting agent can distinguish "approved and FSM cycled back to
  // scanning" from "rejected and FSM cycled back to scanning". Without this,
  // a fast-completing approval looks identical to a rejection.
  private resolvedApprovals = new Map<string, 'approved' | 'rejected'>();

  get currentState(): GhostState { return this.state; }
  get currentLevel(): GhostModeLevel { return this.level; }

  setLevel(level: GhostModeLevel): void {
    this.level = level;
    console.log(`[ghost] level=${level}`);
  }

  start(): void {
    if (this.state !== 'inactive') return;
    this.transition('scanning');
    // Scan cycle: every 30 seconds (PDF Section 16).
    this.scanTimer = setInterval(() => this.scanCycle(), 30_000);
    console.log('[ghost] started — scan cycle every 30s');
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.transition('inactive');
    console.log('[ghost] stopped');
  }

  private transition(next: GhostState): void {
    if (!TRANSITIONS[this.state].includes(next)) {
      console.warn(`[ghost] illegal transition ${this.state} → ${next} (blocked)`);
      return;
    }
    console.log(`[ghost] ${this.state} → ${next}`);
    this.state = next;
  }

  // Step 0: scan is a no-op stub. Real scans come online with each Engineering-
  // Pillar agent that hooks in (Security Agent, Performance Agent, etc.).
  // Sentinel Agent (Step 9) reuses this exact cycle for ambient monitoring.
  private async scanCycle(): Promise<void> {
    if (this.state !== 'scanning' && this.state !== 'complete' && this.state !== 'rolled_back') return;
    // No findings in Step 0 — just heartbeat the state.
    // Real findings get injected via reportFinding() by other agents.
  }

  reportFinding(finding: Omit<GhostFinding, 'id'>): GhostFinding {
    const full: GhostFinding = { ...finding, id: uuid() };
    this.findings.set(full.id, full);
    broadcast(makeEvent('ghost:detection', full));

    if (this.level === 'observation-only') {
      // Detect + report only — no further action
      return full;
    }

    this.transition('detected');
    return full;
  }

  /**
   * Get a finding by ID. Used by the approval endpoint to verify the finding
   * exists and belongs to the requesting user before transitioning state.
   * Returns null if not found.
   */
  getFinding(findingId: string): GhostFinding | null {
    return this.findings.get(findingId) ?? null;
  }

  /**
   * Get the plan for a finding. Used by the approval endpoint to verify the
   * plan exists before transitioning state.
   */
  getPlan(findingId: string): GhostPlan | null {
    return this.plans.get(findingId) ?? null;
  }

  async planFix(finding: GhostFinding): Promise<GhostPlan> {
    this.transition('planning');
    const plan: GhostPlan = {
      findingId: finding.id,
      steps: ['(Step 0 stub plan — real planner comes with Security Agent in a later step)'],
      preview: `Planned fix for ${finding.type}: ${finding.description}`,
    };
    this.plans.set(finding.id, plan);
    broadcast(makeEvent('ghost:plan', plan));

    if (this.level === 'approval-required') {
      this.transition('awaiting_approval');
    } else {
      // auto-amend or autonomous — apply directly
      await this.applyFix(plan);
    }
    return plan;
  }

  async approve(plan: GhostPlan): Promise<void> {
    if (this.state !== 'awaiting_approval') return;
    // Record the resolution BEFORE transitioning — the waiting agent polls
    // getResolution() to distinguish approve from reject.
    this.resolvedApprovals.set(plan.findingId, 'approved');
    await this.applyFix(plan);
  }

  /**
   * Get the resolution of a finding's approval: 'approved', 'rejected', or
   * undefined (still pending). Used by waiting agents to distinguish a
   * fast-completing approval from a rejection — both end up in 'scanning'
   * state, so the agent can't tell from state alone.
   */
  getResolution(findingId: string): 'approved' | 'rejected' | undefined {
    return this.resolvedApprovals.get(findingId);
  }

  private async applyFix(plan: GhostPlan): Promise<void> {
    this.transition('applying');
    broadcast(makeEvent('ghost:fix', { detectionId: plan.findingId, diff: plan.preview }));
    this.transition('verifying');
    // Step 0: assume verify passes
    this.transition('complete');
    this.transition('scanning');
  }

  async rollback(plan: GhostPlan): Promise<void> {
    broadcast(makeEvent('ghost:rollback', { detectionId: plan.findingId }));
    this.transition('rolled_back');
    this.transition('scanning');
  }

  /**
   * Reject a finding's plan. This is the "no, don't do this" path — the user
   * explicitly refused the proposed action. Semantically distinct from
   * rollback() (which is "undo after applying"), but reuses the same FSM
   * path: awaiting_approval → rolled_back → scanning.
   *
   * Added in the approval-gate fix: the approval endpoint calls this when the
   * user clicks Reject. The Terminal/Operative/Fabrication agents waiting on
   * the approval will see the state transition and end their task in a refused
   * state (fail closed).
   */
  async reject(plan: GhostPlan): Promise<void> {
    this.resolvedApprovals.set(plan.findingId, 'rejected');
    broadcast(makeEvent('ghost:rollback', { detectionId: plan.findingId, reason: 'rejected-by-user' }));
    this.transition('rolled_back');
    this.transition('scanning');
  }
}

export const ghostMode = new GhostModeMachine();
