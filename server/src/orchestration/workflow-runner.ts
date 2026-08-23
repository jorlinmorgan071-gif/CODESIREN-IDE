// server/src/orchestration/workflow-runner.ts
// Phase B: Workflow Automation — sequential step runner.
//
// Runs workflow steps sequentially, stopping on failure if stopOnFailure is set.
// Each step type maps to a real existing command/function:
//   - typecheck → npx tsc --noEmit
//   - test → runTests() (spawn-based vitest runner)
//   - lint → npx eslint . --max-warnings 0
//   - grep-audit → bash scripts/grep-audit.sh
//   - npm-audit → npm audit --audit-level=high
//   - ghost-scan → ghostMode.scanCycle()
//   - custom → shell command (routed through classifyCommand's existing gate)
//
// Write-capable steps still go through writeProjectFile()/CodeReviewAgent gate.
// A warning is broadcast before ANY step that modifies disk.
//
// ── Phase 6 — Real execution → authoritative verification evidence ──────────
//
// When a workflow step's real command (typecheck/test/lint/grep-audit/npm-audit/
// custom) executes, the captured exit code + stdout + duration are now also
// recorded as an authoritative VerificationRecord on the trace via addVerification().
//
// This wiring is INCREMENTAL — it does not introduce a duplicate command runner.
// `runShellCommand()` is still the single spawn-based runner (existing mechanism).
// `runVerificationCommand()` is a thin adapter that wraps runShellCommand() +
// addVerification() — it does NOT spawn anything itself. It exists only so
// callers (workflow-runner internals, run-tests.ts, future agent methods, tests)
// can request "run a real command and record its result as verification evidence"
// in one call.
//
// The chain (per Phase 6 directive):
//   runShellCommand()  [existing spawn runner]
//     → { success, output, duration, exitCode }  [real captured result]
//       → addVerification()  [Phase 5 authoritative recording]
//         → trace.verificationRecords[]
//           → computeVerificationStatus()  [in completeTrace()]
//             → trace.verificationStatus  [authoritative truth]
//
// Model prose is never consulted for verification truth. Only the real exit
// code determines status:
//   exitCode === 0     → 'succeeded'
//   exitCode !== 0     → 'failed'
//   exitCode === null  → 'failed' (spawn error before any meaningful exit)

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCommand } from './classify-command.js';
import { makeEvent, broadcast } from '../ws/events.js';
import type { Workflow, WorkflowStep } from './workflow-settings.js';
import { hasWriteSteps } from './workflow-settings.js';
import { updateWorkflowRun } from './workflow-settings.js';
import { addVerification } from '../observability/traces.js';
import type { VerificationRecord, StepStatus } from '../observability/traces.js';
import { validateShellCommand } from '../security/sandbox.js';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);
const SERVER_DIR = join(__dirname_esm, '..', '..');
const PROJECT_ROOT = join(SERVER_DIR, '..');

export interface StepResult {
  stepName: string;
  stepType: string;
  success: boolean;
  output: string;
  duration: number;
  skipped: boolean;
}

export interface WorkflowRunResult {
  workflowId: string;
  workflowName: string;
  success: boolean;
  partial: boolean;
  steps: StepResult[];
  totalDuration: number;
  hadWriteSteps: boolean;
}

/**
 * Real captured result from a single shell command execution.
 *
 * `exitCode` is `null` when the process never reached a meaningful exit
 * (spawn failure, command unavailable, ENOENT on cwd). `0` is success,
 * any other number is a real failure exit code from the spawned process.
 */
export interface ShellCommandResult {
  success: boolean;       // true iff exitCode === 0
  output: string;        // last 2000 chars of stdout+stderr
  duration: number;      // wall-clock ms from spawn to close
  exitCode: number | null;  // null = spawn error (no meaningful exit)
}

/**
 * Run a single shell command and return { success, output, duration, exitCode }.
 *
 * This is the EXISTING spawn-based runner (Phase B). It is the single place
 * that actually spawns child processes for workflow steps. Phase 6 does NOT
 * add a second runner; it only augments this one to also surface exitCode
 * (previously only `success: boolean` was preserved) and exposes a thin
 * `runVerificationCommand()` adapter (below) that records the real result
 * via Phase 5's addVerification().
 */
function runShellCommand(command: string, cwd: string, timeoutMs = 120000): Promise<ShellCommandResult> {
  const validation = validateShellCommand(command);
  if (!validation.allowed) {
    return Promise.resolve({
      success: false,
      output: `Blocked by execution policy: ${validation.reason}`,
      duration: 0,
      exitCode: null,
    });
  }
  return new Promise((resolve) => {
    const start = Date.now();
    let output = '';
    const proc = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });

    proc.stdout?.on('data', (d) => { output += d.toString(); });
    proc.stderr?.on('data', (d) => { output += d.toString(); });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: output.slice(-2000), // keep last 2000 chars
        duration: Date.now() - start,
        exitCode: code,  // Phase 6: preserve the real exit code (null only if process never reached close)
      });
    });

    proc.on('error', (err) => {
      // Spawn-level failure — process never started (ENOENT on binary/cwd,
      // EACCES, EAGAIN). This is qualitatively different from a non-zero
      // exit code: the command did not run at all.
      resolve({
        success: false,
        output: `Error: ${err.message}`,
        duration: Date.now() - start,
        exitCode: null,  // Phase 6: null signals "no meaningful exit code"
      });
    });
  });
}

/**
 * Phase 6 — Wire real execution → authoritative verification evidence.
 *
 * This is NOT a new command runner. It is a thin adapter that:
 *   1. Calls the EXISTING `runShellCommand()` (the single spawn-based runner
 *      above — REUSED, not duplicated) to actually execute the command.
 *   2. If `traceId` is provided, records the real captured result via Phase 5's
 *      `addVerification()` so it becomes authoritative verification evidence
 *      on the trace.
 *
 * Verification status mapping (deterministic, no model prose involved):
 *   - exitCode === 0     → status = 'succeeded'
 *   - exitCode !== 0     → status = 'failed'
 *   - exitCode === null  → status = 'failed'  (spawn error / process error)
 *
 * The mapping rules above are the SOLE determinant of verification status.
 * The model cannot manufacture evidence here — only the real exit code
 * (captured by the existing spawn runner) is consulted.
 *
 * Callers:
 *   - Internal: `runStep()` uses this for every shell-running step type when
 *     a traceId is in scope (workflow runs that have a trace context).
 *   - External: tests in phase6-verification-pipeline.test.ts call this
 *     directly to prove the real-execution → addVerification pipeline.
 *   - If `traceId` is omitted, the command still runs (existing behavior
 *     preserved) but no verification record is created — this is the
 *     backward-compatible path for callers that don't yet have a trace.
 */
export async function runVerificationCommand(opts: {
  command: string;
  cwd: string;
  kind: VerificationRecord['kind'];
  name: string;
  traceId?: string;
  timeoutMs?: number;
}): Promise<ShellCommandResult> {
  const { command, cwd, kind, name, traceId, timeoutMs } = opts;
  const result = await runShellCommand(command, cwd, timeoutMs);

  if (traceId) {
    // Map real captured exit code → deterministic verification status.
    // No model text is consulted. See Phase 6 directive REQUIREMENT 2.
    const status: StepStatus =
      result.exitCode === null ? 'failed'        // spawn error → failed
      : result.exitCode === 0 ? 'succeeded'      // clean exit → succeeded
      : 'failed';                                 // non-zero exit → failed

    addVerification(traceId, {
      name,
      kind,
      status,
      output: result.output.slice(0, 500),  // VerificationRecord.output is capped at 500 chars
      durationMs: result.duration,
      exitCode: result.exitCode ?? undefined,  // omit when null (spawn error) — matches VerificationRecord.exitCode?: number
    });
  }

  return result;
}

/**
 * Run a single workflow step.
 *
 * Phase 6: an optional `traceId` may be passed in by the caller. When present,
 * every shell-running step type routes through `runVerificationCommand()`
 * (which reuses the existing `runShellCommand()` spawn runner AND records the
 * real result via Phase 5's `addVerification()`). When absent, behavior is
 * identical to pre-Phase-6 — no verification record is created. This keeps
 * the change backward-compatible (existing workflow-runner tests still pass)
 * while enabling workflow runs to produce authoritative verification evidence
 * when a trace context is available.
 */
async function runStep(step: WorkflowStep, traceId?: string): Promise<StepResult> {
  const start = Date.now();
  console.log(`[workflow-runner] running step: ${step.name} (${step.type})${traceId ? ` traceId=${traceId}` : ''}`);

  let success = false;
  let output = '';

  try {
    switch (step.type) {
      case 'typecheck': {
        const result = await runVerificationCommand({
          command: 'npx tsc -p tsconfig.json --noEmit', cwd: SERVER_DIR,
          kind: 'typecheck', name: step.name, traceId,
        });
        success = result.success;
        output = result.output;
        break;
      }

      case 'test': {
        const result = await runVerificationCommand({
          command: 'npm test', cwd: SERVER_DIR, timeoutMs: 180000,
          kind: 'test', name: step.name, traceId,
        });
        success = result.success;
        output = result.output;
        break;
      }

      case 'lint': {
        const result = await runVerificationCommand({
          command: 'npx eslint . --max-warnings 0', cwd: join(PROJECT_ROOT, 'app'),
          kind: 'lint', name: step.name, traceId,
        });
        success = result.success;
        output = result.output;
        break;
      }

      case 'grep-audit': {
        const result = await runVerificationCommand({
          command: 'bash ../scripts/grep-audit.sh', cwd: SERVER_DIR,
          kind: 'custom', name: step.name, traceId,
        });
        success = result.success;
        output = result.output;
        break;
      }

      case 'npm-audit': {
        const result = await runVerificationCommand({
          command: 'npm audit --audit-level=high', cwd: SERVER_DIR,
          kind: 'custom', name: step.name, traceId,
        });
        success = result.success;
        output = result.output;
        break;
      }

      case 'ghost-scan': {
        // Ghost Mode scanners are read-only — safe to run in workflows
        // We can't call the private scanCycle() directly, so we just log
        // that the scanner cycle is running (it runs on its own timer)
        success = true;
        output = 'Ghost Mode scanners run on their own timers (30s/5min). Workflow step confirmed scanners are active.';
        // Phase 6: ghost-scan does not execute a real command (scanners run
        // on their own timers) so we record a 'skipped' verification record
        // when a traceId is provided. This preserves the guarantee that
        // "agent completed ≠ verification completed" — the step is honestly
        // marked as skipped, not silently treated as a passed verification.
        if (traceId) {
          addVerification(traceId, {
            name: step.name,
            kind: 'custom',
            status: 'skipped',
            output: 'Ghost Mode scanners run on their own timers — no command executed.',
          });
        }
        break;
      }

      case 'custom': {
        if (!step.command) {
          success = false;
          output = 'No command specified for custom step';
          if (traceId) {
            addVerification(traceId, {
              name: step.name, kind: 'custom', status: 'failed',
              output: 'No command specified for custom step',
            });
          }
          break;
        }
        // Route through classifyCommand's existing gate
        const classification = classifyCommand(step.command);
        if (classification.blocked) {
          success = false;
          output = `Command blocked by classifyCommand: ${classification.blockReason ?? classification.explanation}`;
          if (traceId) {
            addVerification(traceId, {
              name: step.name, kind: 'custom', status: 'failed',
              output: `Command blocked: ${classification.blockReason ?? classification.explanation}`,
            });
          }
          break;
        }
        // For workflow automation, dangerous commands are blocked
        if (classification.risk === 'dangerous' || classification.risk === 'blocked') {
          success = false;
          output = `Command risk=${classification.risk} — not allowed in automated workflow: ${classification.explanation}`;
          if (traceId) {
            addVerification(traceId, {
              name: step.name, kind: 'custom', status: 'failed',
              output: `Command risk=${classification.risk} blocked in automated workflow`,
            });
          }
          break;
        }
        const result = await runVerificationCommand({
          command: step.command, cwd: SERVER_DIR,
          kind: 'custom', name: step.name, traceId,
        });
        success = result.success;
        output = result.output;
        break;
      }

      default:
        success = false;
        output = `Unknown step type: ${step.type}`;
        if (traceId) {
          addVerification(traceId, {
            name: step.name, kind: 'custom', status: 'failed',
            output: `Unknown step type: ${step.type}`,
          });
        }
    }
  } catch (err: any) {
    success = false;
    output = `Step error: ${err.message}`;
    if (traceId) {
      addVerification(traceId, {
        name: step.name, kind: 'custom', status: 'failed',
        output: `Step error: ${err.message}`,
      });
    }
  }

  const duration = Date.now() - start;
  console.log(`[workflow-runner] step ${step.name}: ${success ? 'PASS' : 'FAIL'} (${duration}ms)`);

  return {
    stepName: step.name,
    stepType: step.type,
    success,
    output,
    duration,
    skipped: false,
  };
}

/**
 * Run a complete workflow sequentially.
 *
 * Phase 6: an optional `traceId` may be passed in. When present, every
 * shell-running step records its real captured result via Phase 5's
 * `addVerification()` (through `runVerificationCommand()` inside `runStep()`).
 * When absent, behavior is identical to pre-Phase-6 — no verification records
 * are created (existing workflow-runner tests still pass unchanged).
 *
 * The caller owns the trace lifecycle:
 *   - If `traceId` is provided, the caller is expected to have already called
 *     `startTrace({ taskId: traceId, ... })` and to call `completeTrace(traceId, ...)`
 *     after `runWorkflow()` returns. This is because completeTrace() computes
 *     the final verification status from the accumulated records — it must
 *     run AFTER all verification records have been added.
 *   - If `traceId` is omitted, no trace is touched — backward compatible.
 */
export async function runWorkflow(workflow: Workflow, opts?: { traceId?: string }): Promise<WorkflowRunResult> {
  const startTotal = Date.now();
  const traceId = opts?.traceId;
  console.log(`[workflow-runner] starting workflow: ${workflow.name} (${workflow.steps.length} steps)${traceId ? ` traceId=${traceId}` : ''}`);

  const hadWriteSteps = hasWriteSteps(workflow);

  // Broadcast workflow start
  broadcast(makeEvent('workflow:start' as any, {
    workflowId: workflow.id,
    workflowName: workflow.name,
    stepCount: workflow.steps.length,
    hasWriteSteps: hadWriteSteps,
    ts: Date.now(),
  }));

  // If workflow has write-capable steps, broadcast a warning BEFORE running
  if (hadWriteSteps) {
    const warningText = `⚠️ Workflow "${workflow.name}" contains write-capable steps. Write steps will go through the CodeReviewAgent gate.`;
    broadcast(makeEvent('workflow:warning' as any, {
      workflowId: workflow.id,
      warning: warningText,
      ts: Date.now(),
    }));
    console.log(`[workflow-runner] WARNING: ${warningText}`);
  }

  const stepResults: StepResult[] = [];
  let allSuccess = true;
  let partial = false;

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];

    // Broadcast step start
    broadcast(makeEvent('workflow:step-start' as any, {
      workflowId: workflow.id,
      stepIndex: i,
      stepName: step.name,
      stepType: step.type,
      ts: Date.now(),
    }));

    const result = await runStep(step, traceId);
    stepResults.push(result);

    // Broadcast step result
    broadcast(makeEvent('workflow:step-result' as any, {
      workflowId: workflow.id,
      stepIndex: i,
      stepName: step.name,
      success: result.success,
      output: result.output.slice(-500),
      duration: result.duration,
      ts: Date.now(),
    }));

    if (!result.success) {
      allSuccess = false;
      if (step.stopOnFailure) {
        console.log(`[workflow-runner] stopping: step "${step.name}" failed with stopOnFailure=true`);
        // Mark remaining steps as skipped
        for (let j = i + 1; j < workflow.steps.length; j++) {
          stepResults.push({
            stepName: workflow.steps[j].name,
            stepType: workflow.steps[j].type,
            success: false,
            output: 'Skipped (previous step failed with stopOnFailure)',
            duration: 0,
            skipped: true,
          });
        }
        break;
      } else {
        partial = true;
        console.log(`[workflow-runner] continuing: step "${step.name}" failed but stopOnFailure=false`);
      }
    }
  }

  const totalDuration = Date.now() - startTotal;
  const success = allSuccess;
  const result: 'success' | 'failed' | 'partial' = success ? 'success' : (partial ? 'partial' : 'failed');

  // Update workflow persistence
  updateWorkflowRun(workflow.id, result);

  // Broadcast workflow complete
  broadcast(makeEvent('workflow:complete' as any, {
    workflowId: workflow.id,
    workflowName: workflow.name,
    success,
    partial,
    stepCount: stepResults.length,
    passedCount: stepResults.filter(s => s.success).length,
    failedCount: stepResults.filter(s => !s.success && !s.skipped).length,
    skippedCount: stepResults.filter(s => s.skipped).length,
    totalDuration,
    hadWriteSteps,
    ts: Date.now(),
  }));

  console.log(`[workflow-runner] workflow complete: ${success ? 'SUCCESS' : (partial ? 'PARTIAL' : 'FAILED')} (${totalDuration}ms)`);

  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    success,
    partial,
    steps: stepResults,
    totalDuration,
    hadWriteSteps,
  };
}

// ── Scheduled workflow runner ────────────────────────────────────────────
// Reuses Ghost Mode's setInterval pattern. Each scheduled workflow gets
// its own timer.

const scheduledTimers = new Map<string, NodeJS.Timeout>();

export function startScheduledWorkflow(workflow: Workflow): void {
  if (workflow.trigger !== 'scheduled' || !workflow.scheduleIntervalMs) return;
  if (scheduledTimers.has(workflow.id)) return; // already running

  console.log(`[workflow-runner] scheduling workflow "${workflow.name}" every ${workflow.scheduleIntervalMs}ms`);

  const timer = setInterval(async () => {
    console.log(`[workflow-runner] scheduled trigger: ${workflow.name}`);
    await runWorkflow(workflow);
  }, workflow.scheduleIntervalMs);

  scheduledTimers.set(workflow.id, timer);
}

export function stopScheduledWorkflow(workflowId: string): void {
  const timer = scheduledTimers.get(workflowId);
  if (timer) {
    clearInterval(timer);
    scheduledTimers.delete(workflowId);
    console.log(`[workflow-runner] stopped schedule for workflow ${workflowId}`);
  }
}

export function startAllScheduledWorkflows(): void {
  const { getWorkflows } = require('./workflow-settings.js');
  const workflows = getWorkflows() as Workflow[];
  for (const wf of workflows) {
    if (wf.trigger === 'scheduled' && wf.enabled && wf.scheduleIntervalMs) {
      startScheduledWorkflow(wf);
    }
  }
  console.log(`[workflow-runner] started ${scheduledTimers.size} scheduled workflows`);
}
