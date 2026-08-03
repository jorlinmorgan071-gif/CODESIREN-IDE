// server/src/orchestration/ghost-mode.ts
// Ghost Mode FSM — PDF Section 16.
//
// States:  inactive → scanning → detected → planning → awaiting_approval →
//          applying → verifying → complete | rolled_back
// Levels:  observation-only | approval-required | auto-amend | autonomous
//
// Per directive Section 7: the Sentinel Agent (Step 9) reuses THIS state machine
// shape rather than inventing a parallel one for the Personal Pillar.
//
// Phase A Section 1: scanCycle() is NO LONGER a no-op. Two real scanners are
// wired in via registerScanner():
//   - PerformanceAgent.scanAntiPatterns() — every 30s (regex, cheap, no network)
//   - SecurityAgent.scanDependencies()    — every 5min (npm audit, network call)
// Each scanner returns GhostFinding[]; scanCycle() calls reportFinding() for
// each finding. The .unref() fix on both timers matches middleware/cache.ts.

import { v4 as uuid } from 'uuid';
import type { GhostState, GhostModeLevel, GhostFinding, GhostPlan } from '../types.js';
import { makeEvent, broadcast } from '../ws/events.js';
// Phase A Section 1b: real remediation logic. Imported here (not inlined)
// because the remediation module imports validateShellCommand + execSync —
// keeping it separate lets ghost-mode.ts stay focused on the FSM.
// No circular dep: ghost-remediation.ts imports only types from this module's
// type namespace (via ../types.js), not the ghostMode singleton.
import {
  buildDependencyFixPlan,
  buildPerformanceSuggestionPlan,
  buildTerminalErrorSuggestionPlan,
  applyNpmAuditFix,
} from './ghost-remediation.js';

// Resolve the default project root from the server's cwd. The server runs
// from <projectRoot>/server/, so projectRoot = parent of process.cwd().
// Mirrors the logic in ghost-scanners.ts:resolveProjectRoot.
function resolveDefaultProjectRoot(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('/server') || cwd.endsWith('\\server')) {
    return cwd.replace(/[/\\]server$/, '');
  }
  return cwd;
}

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

// ── Scanner registration (Phase A Section 1) ────────────────────────────
//
// Scanners are functions that return GhostFinding[] (already mapped to the
// GhostFinding shape — severity translation happens in the scanner adapter,
// not here). Ghost Mode owns the interval timer for each scanner and calls
// reportFinding() for each finding returned.
//
// Why registration instead of direct imports: ghost-mode.ts is imported by
// SecurityAgent (circular dep risk). The registration pattern lets a separate
// wiring module (ghost-scanners.ts) import both ghostMode AND the agents,
// breaking the cycle.

export type GhostScanner = () => Omit<GhostFinding, 'id'>[];

interface RegisteredScanner {
  name: string;
  cadenceMs: number;
  fn: GhostScanner;
  timer: NodeJS.Timeout;
}

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

  // Phase A Section 1b: project root + server cwd, set by the wiring layer
  // (ghost-scanners.ts via setProjectRoot) so planFix()/applyFix() can pass
  // the right cwd to npm audit fix. Defaults to process.cwd()/.. (the server
  // runs from <root>/server/, so parent is the project root).
  private projectRoot: string = resolveDefaultProjectRoot();
  private serverCwd: string = this.projectRoot + '/server';

  // Phase A Section 1: registered scanners + their intervals
  private scanners = new Map<string, RegisteredScanner>();

  // Track findings already reported in a prior cycle so we don't re-report
  // the same finding every tick (would flood the FSM + WS). Dedup key is
  // `${type}::${filePath}::${line}::${description}` — same finding from the
  // same scanner in a later cycle is suppressed. Cleared on stop().
  private reportedFindingKeys = new Set<string>();

  get currentState(): GhostState { return this.state; }
  get currentLevel(): GhostModeLevel { return this.level; }

  setLevel(level: GhostModeLevel): void {
    this.level = level;
    console.log(`[ghost] level=${level}`);
  }

  /**
   * Phase A Section 1b: set the project root + server cwd for remediation.
   * Called by the wiring layer (ghost-scanners.ts) so that planFix()/applyFix()
   * can pass the right cwd to `npm audit fix`. Tests also use this to point
   * at fixture directories.
   */
  setProjectRoot(root: string): void {
    this.projectRoot = root;
    this.serverCwd = root + '/server';
  }

  /** Test/helper: get the current server cwd (for assertions in tests). */
  getServerCwd(): string {
    return this.serverCwd;
  }

  start(): void {
    if (this.state !== 'inactive') return;
    this.transition('scanning');
    // Scan cycle: every 30 seconds (PDF Section 16).
    // .unref() so the timer doesn't keep Node alive after HTTP/WS close —
    // matches the pattern in middleware/cache.ts:160.
    this.scanTimer = setInterval(() => { void this.scanCycle(); }, 30_000);
    this.scanTimer.unref();
    console.log('[ghost] started — scan cycle every 30s');
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    // Stop all registered scanners too
    for (const scanner of this.scanners.values()) {
      clearInterval(scanner.timer);
    }
    this.scanners.clear();
    this.reportedFindingKeys.clear();
    // Transition to inactive. The FSM may be in a non-terminal state
    // (e.g. awaiting_approval, applying, verifying) when stop() is called.
    // The TRANSITIONS table only allows inactive←scanning, so we may need
    // to walk through scanning first. This is safe — stop() is a teardown
    // path, not a normal runtime transition.
    if (this.state !== 'inactive' && this.state !== 'scanning') {
      // Force-transition through scanning (bypasses the illegal-transition
      // guard — stop() is explicit teardown).
      this.state = 'scanning';
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

  // ── Phase A Section 1: real scanCycle ──────────────────────────────
  // The 30s heartbeat. Runs all scanners registered at EXACTLY 30s cadence
  // (the heartbeat cadence). Scanners at other cadences (shorter OR longer)
  // run on their OWN intervals via registerScanner() — they don't fire from
  // here.
  //
  // State guard preserved from the no-op stub: only runs when the FSM is
  // in a scan-eligible state (scanning | complete | rolled_back). If the
  // FSM is mid-approval-flow (awaiting_approval, applying, verifying), the
  // tick is skipped — we don't want a new finding to disrupt an in-flight
  // remediation.
  private async scanCycle(): Promise<void> {
    if (this.state !== 'scanning' && this.state !== 'complete' && this.state !== 'rolled_back') return;

    // Run all scanners registered at EXACTLY 30s cadence (the heartbeat).
    // Other cadences have their own intervals.
    for (const scanner of this.scanners.values()) {
      if (scanner.cadenceMs !== 30_000) continue;
      this._runScanner(scanner);
    }
  }

  // Shared scanner-runner used by both scanCycle (30s heartbeat) and the
  // per-scanner intervals (other cadences). Dedup is applied so the same
  // finding isn't re-reported every tick.
  private _runScanner(scanner: RegisteredScanner): void {
    if (this.state !== 'scanning' && this.state !== 'complete' && this.state !== 'rolled_back') return;
    try {
      const findings = scanner.fn();
      for (const finding of findings) {
        const key = `${finding.type}::${finding.filePath ?? ''}::${finding.line ?? ''}::${finding.description}`;
        if (this.reportedFindingKeys.has(key)) continue;
        this.reportedFindingKeys.add(key);
        this.reportFinding(finding);
      }
    } catch (err: any) {
      console.warn(`[ghost] scanner "${scanner.name}" failed: ${err.message}`);
    }
  }

  /**
   * Register a periodic scanner. Ghost Mode owns the interval timer.
   * The scanner returns GhostFinding[] (already severity-mapped). Ghost Mode
   * calls reportFinding() for each, with dedup so the same finding isn't
   * re-reported every cycle.
   *
   * Scanners at cadence == 30s run from the main scanCycle() heartbeat
   * (no separate timer — they piggyback on the existing 30s interval).
   * Scanners at any OTHER cadence get their OWN interval (with .unref()).
   *
   * This can be called before or after start(); the scanner's own interval
   * starts immediately, but the state guard inside _runScanner ensures it
   * only actually scans when the FSM is in a scan-eligible state.
   */
  registerScanner(name: string, cadenceMs: number, fn: GhostScanner): void {
    if (this.scanners.has(name)) {
      console.warn(`[ghost] scanner "${name}" already registered — replacing`);
      clearInterval(this.scanners.get(name)!.timer);
    }

    let timer: NodeJS.Timeout;
    if (cadenceMs === 30_000) {
      // Piggyback on the main scanCycle heartbeat — no separate timer.
      // Store a no-op timer so the RegisteredScanner shape is uniform.
      timer = setInterval(() => {}, 2 ** 31 - 1);
      timer.unref();
    } else {
      // Own interval — fires at its own cadence, independent of the 30s heartbeat.
      timer = setInterval(() => { this._runScanner({ name, cadenceMs, fn, timer }); }, cadenceMs);
      timer.unref();
    }

    this.scanners.set(name, { name, cadenceMs, fn, timer });
    console.log(`[ghost] scanner "${name}" registered (cadence=${cadenceMs}ms)`);
  }

  /**
   * Clear all reported-finding dedup keys. Used by tests to reset state
   * between subtests without restarting the whole FSM. NOT called in
   * production — dedup persists for the lifetime of the process.
   */
  clearReportedFindings(): void {
    this.reportedFindingKeys.clear();
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

    // Phase A Section 1b: dispatch by finding type to build a real plan.
    //   - dependency-vulnerability → run npm audit fix --dry-run, build real
    //     or suggest-only plan based on whether an in-range fix exists
    //   - performance:*            → suggest-only (NOT auto-fixable per Section 0)
    //   - terminal:error            → suggest-only (Phase A Section 2 — no safe
    //     generic auto-fix for "a command failed")
    //   - terminal:command / operative:action / fabrication:print → legacy
    //     stub plan (these are approval-gate findings from agents that wait
    //     on the FSM transition, not on applyFix(); the plan content doesn't
    //     matter for them, only the state transitions)
    let plan: GhostPlan;
    if (finding.type === 'dependency-vulnerability') {
      plan = buildDependencyFixPlan(finding, this.serverCwd);
    } else if (finding.type.startsWith('performance:')) {
      plan = buildPerformanceSuggestionPlan(finding);
    } else if (finding.type === 'terminal:error') {
      plan = buildTerminalErrorSuggestionPlan(finding);
    } else {
      // Legacy approval-gate findings (terminal:command, operative:action, etc.)
      // These don't go through applyFix() for real work — the calling agent
      // does the real action after the FSM transitions to applying/complete.
      // The stub plan is fine here.
      plan = {
        findingId: finding.id,
        steps: [`Approve proposed action: ${finding.description}`],
        preview: `Proposed action: ${finding.description}`,
      };
    }

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

  /**
   * Phase A Section 1b: real applyFix() — dispatches by plan.fixAction.
   *
   *   'npm-audit-fix' : runs `npm audit fix` (NO --force) + verifies with
   *                      re-audit. Verification failure → rolled_back.
   *   'suggest-only'  : NO-OP. No file written, no command run. The "fix" is
   *                      the human having seen the suggestion. Transitions
   *                      straight to complete.
   *   undefined       : legacy approval-gate flow (terminal:command etc.).
   *                      The calling agent does the real action; applyFix()
   *                      just walks the FSM through to complete.
   *
   * applyFix() is private — called from planFix() (auto modes) or approve()
   * (approval-required mode). Never called directly from outside.
   */
  private async applyFix(plan: GhostPlan): Promise<void> {
    this.transition('applying');
    broadcast(makeEvent('ghost:fix', { detectionId: plan.findingId, diff: plan.preview }));

    if (plan.fixAction === 'npm-audit-fix') {
      // Path A: real npm audit fix + verification
      const cwd = plan.fixCwd ?? this.serverCwd;
      console.log(`[ghost] applyFix: running npm audit fix in ${cwd}`);
      const result = applyNpmAuditFix(cwd);
      console.log(
        `[ghost] applyFix: npm audit fix result — success=${result.success}, ` +
        `vulns ${result.vulnsBefore} → ${result.vulnsAfter}` +
        (result.reason ? `, reason=${result.reason}` : '')
      );

      this.transition('verifying');
      if (result.success) {
        this.transition('complete');
      } else {
        // Verification failed — honest rollback. The fix didn't actually
        // reduce the vuln count, so we transition to rolled_back (NOT complete).
        // This is the "verify" step doing real work, not assuming success.
        //
        // Broadcast ghost:rollback (matching the existing rollback() method's
        // pattern) so the UI + any waiting agents see the rollback signal.
        // Without this broadcast, the only observable signal would be the
        // state transition — which cycles to 'scanning' immediately.
        console.warn(`[ghost] applyFix: verification failed — rolling back. ${result.reason ?? ''}`);
        broadcast(makeEvent('ghost:rollback', {
          detectionId: plan.findingId,
          reason: `verification failed: ${result.reason ?? 'vuln count did not decrease'}`,
          vulnsBefore: result.vulnsBefore,
          vulnsAfter: result.vulnsAfter,
        }));
        this.transition('rolled_back');
      }
      this.transition('scanning');
      return;
    }

    // Path B (suggest-only) OR legacy (undefined fixAction):
    // No file write, no shell command. The "fix" is informational.
    // For suggest-only: the human reviewed the suggestion, that's the action.
    // For legacy: the calling agent does the real work after the FSM transition.
    this.transition('verifying');
    // No real verification possible for suggest-only — assume the human read it.
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
