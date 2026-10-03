// server/src/orchestration/task-state.ts
// Phase 3 — Task State & Resumption Object.
//
// A structured task-state object, written incrementally during execution —
// not reconstructed after the fact from logs. This is the foundation Phase 4
// (Universal Routing) depends on.
//
// Design principles:
//   1. Provider-agnostic — any model reading this object can answer
//      "what was I asked to do, what's done, what's left, where do I pick up"
//      without needing the halting provider's internal state.
//   2. Incremental persistence — state is written to disk at every step
//      transition, so a crash mid-execution preserves the state up to the
//      last completed step.
//   3. Truth from execution, not from model claims — step status reflects
//      what actually happened (files changed, verification ran), not what
//      the model said it would do.
//
// Storage: JSON file at server/.task-states/<taskId>.json
// One file per task — simple, debuggable, no DB dependency.

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepStatus } from '../observability/traces.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', '..', '.task-states');

// Ensure the state directory exists
if (!existsSync(STATE_DIR)) {
  mkdirSync(STATE_DIR, { recursive: true });
}

// ── Types ────────────────────────────────────────────────────────────────

export type TaskStepStatus = StepStatus;  // Reuse the existing type: 'planned' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'unverified'

export interface TaskStep {
  /** Unique step ID within this task (e.g. 'step-1', 'step-2') */
  id: string;
  /** Human-readable description of what this step does */
  label: string;
  /** Current status of this step */
  status: TaskStepStatus;
  /** When this step started (epoch ms), or null if not started */
  startedAt: number | null;
  /** When this step completed (epoch ms), or null if not done */
  completedAt: number | null;
  /** Output produced by this step (truncated to 2000 chars for storage) */
  output?: string;
  /** Error message if this step failed */
  error?: string;
  /** Files created/modified by this step (actual disk changes, not model claims) */
  changedFiles?: string[];
  /** Verification that actually ran on this step's output */
  verification?: {
    name: string;
    status: TaskStepStatus;
    output?: string;
    timestamp: number;
  };
}

export type TaskStateStatus = 'not-started' | 'in-progress' | 'completed' | 'interrupted' | 'failed';

export interface TaskState {
  /** The task ID (same as AgentTask.id / traceId) */
  taskId: string;
  /** Which agent was running this task */
  agentId: string;
  /** The original user request / goal */
  goal: string;
  /** Overall task status */
  status: TaskStateStatus;
  /** When the task was created (epoch ms) */
  createdAt: number;
  /** When the task was last updated (epoch ms) — every state write updates this */
  updatedAt: number;
  /** When the task completed (epoch ms), or null if not done */
  completedAt: number | null;
  /** The plan: ordered list of steps to complete the task */
  steps: TaskStep[];
  /** Index of the step that was in-progress when the task was interrupted.
   *  null if not interrupted, or if the interruption happened between steps. */
  interruptedAtStep: number | null;
  /** All files created/modified across all steps (actual disk changes) */
  changedArtifacts: string[];
  /** What verification has actually run (not what the model claimed) */
  verificationSummary: {
    total: number;
    passed: number;
    failed: number;
    unverified: number;
  };
  /** The model's final output (if the task completed) */
  finalOutput?: string;
  /** Error message if the task failed */
  error?: string;
}

// ── State manager ───────────────────────────────────────────────────────

function statePath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.json`);
}

/**
 * Create a new task state at task start.
 * Writes the initial state to disk immediately.
 */
export function initTaskState(opts: {
  taskId: string;
  agentId: string;
  goal: string;
  steps: Array<{ label: string }>;
}): TaskState {
  const now = Date.now();
  const state: TaskState = {
    taskId: opts.taskId,
    agentId: opts.agentId,
    goal: opts.goal,
    status: 'not-started',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    steps: opts.steps.map((s, i) => ({
      id: `step-${i + 1}`,
      label: s.label,
      status: 'planned' as TaskStepStatus,
      startedAt: null,
      completedAt: null,
    })),
    interruptedAtStep: null,
    changedArtifacts: [],
    verificationSummary: { total: 0, passed: 0, failed: 0, unverified: 0 },
  };
  persistState(state);
  return state;
}

/**
 * Mark a step as in-progress (started executing).
 * Persists immediately.
 */
export function startStep(taskId: string, stepIndex: number): void {
  const state = loadTaskState(taskId);
  if (!state) return;
  if (stepIndex < 0 || stepIndex >= state.steps.length) return;
  state.steps[stepIndex].status = 'running';
  state.steps[stepIndex].startedAt = Date.now();
  state.status = 'in-progress';
  state.updatedAt = Date.now();
  persistState(state);
}

/**
 * Mark a step as completed with evidence.
 * Persists immediately.
 */
export function completeStep(taskId: string, stepIndex: number, evidence: {
  output?: string;
  changedFiles?: string[];
  verification?: { name: string; status: TaskStepStatus; output?: string };
}): void {
  const state = loadTaskState(taskId);
  if (!state) return;
  if (stepIndex < 0 || stepIndex >= state.steps.length) return;

  const step = state.steps[stepIndex];
  step.status = 'succeeded';
  step.completedAt = Date.now();
  if (evidence.output) step.output = evidence.output.slice(0, 2000);
  if (evidence.changedFiles) {
    step.changedFiles = evidence.changedFiles;
    state.changedArtifacts = [...new Set([...state.changedArtifacts, ...evidence.changedFiles])];
  }
  if (evidence.verification) {
    step.verification = { ...evidence.verification, timestamp: Date.now() };
    state.verificationSummary.total++;
    if (evidence.verification.status === 'succeeded') state.verificationSummary.passed++;
    else if (evidence.verification.status === 'failed') state.verificationSummary.failed++;
    else state.verificationSummary.unverified++;
  }
  state.updatedAt = Date.now();
  persistState(state);
}

/**
 * Mark a step as failed.
 * Persists immediately.
 */
export function failStep(taskId: string, stepIndex: number, error: string): void {
  const state = loadTaskState(taskId);
  if (!state) return;
  if (stepIndex < 0 || stepIndex >= state.steps.length) return;
  state.steps[stepIndex].status = 'failed';
  state.steps[stepIndex].completedAt = Date.now();
  state.steps[stepIndex].error = error;
  state.status = 'failed';
  state.error = `Step ${stepIndex + 1} failed: ${error}`;
  state.updatedAt = Date.now();
  persistState(state);
}

/**
 * Mark the entire task as completed.
 * Persists immediately.
 */
export function completeTask(taskId: string, finalOutput?: string): void {
  const state = loadTaskState(taskId);
  if (!state) return;
  state.status = 'completed';
  state.completedAt = Date.now();
  state.updatedAt = Date.now();
  state.interruptedAtStep = null;
  if (finalOutput) state.finalOutput = finalOutput.slice(0, 5000);
  persistState(state);
}

/**
 * Mark the task as interrupted (process killed / crashed mid-execution).
 * Called by a watchdog or on resume detection — NOT by the dying process itself.
 * Records which step was in-progress at the time.
 */
export function markInterrupted(taskId: string): void {
  const state = loadTaskState(taskId);
  if (!state) return;
  // Find the step that was 'running' — that's where we were interrupted
  const runningStep = state.steps.findIndex(s => s.status === 'running');
  state.interruptedAtStep = runningStep >= 0 ? runningStep : null;
  state.status = 'interrupted';
  state.updatedAt = Date.now();
  persistState(state);
}

/**
 * Load a task state from disk.
 * Returns null if no state file exists.
 */
export function loadTaskState(taskId: string): TaskState | null {
  const path = statePath(taskId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as TaskState;
  } catch (err) {
    console.error(`[task-state] failed to load state for ${taskId}:`, err);
    return null;
  }
}

/**
 * Get the resumption point for an interrupted task.
 * Returns:
 *   - { shouldResume: true, resumeFromStep: N, reason: '...' } if the task
 *     was interrupted and can be resumed
 *   - { shouldResume: false, reason: '...' } if the task was completed,
 *     failed, or never started
 *
 * Any model reading this can answer "where do I pick up" from this.
 */
export function getResumptionPoint(taskId: string): {
  shouldResume: boolean;
  resumeFromStep: number | null;
  reason: string;
  state: TaskState | null;
} {
  const state = loadTaskState(taskId);
  if (!state) {
    return { shouldResume: false, resumeFromStep: null, reason: 'No state file found — task never started or state was lost', state: null };
  }

  if (state.status === 'completed') {
    return { shouldResume: false, resumeFromStep: null, reason: `Task already completed at ${new Date(state.completedAt!).toISOString()}`, state };
  }

  if (state.status === 'failed') {
    return { shouldResume: false, resumeFromStep: null, reason: `Task failed: ${state.error}`, state };
  }

  if (state.status === 'not-started') {
    return { shouldResume: true, resumeFromStep: 0, reason: 'Task was created but never started', state };
  }

  // in-progress or interrupted
  const resumeFrom = state.interruptedAtStep ?? state.steps.findIndex(s => s.status === 'running');
  const completedSteps = state.steps.filter(s => s.status === 'succeeded').length;
  const totalSteps = state.steps.length;

  if (resumeFrom >= 0) {
    // Re-do the interrupted step (it was 'running' but didn't complete)
    return {
      shouldResume: true,
      resumeFromStep: resumeFrom,
      reason: `Task was interrupted at step ${resumeFrom + 1} of ${totalSteps} ("${state.steps[resumeFrom].label}"). ${completedSteps} step(s) completed successfully. Resume from step ${resumeFrom + 1}.`,
      state,
    };
  }

  // No running step — resume from the first non-completed step
  const nextStep = state.steps.findIndex(s => s.status !== 'succeeded');
  if (nextStep >= 0) {
    return {
      shouldResume: true,
      resumeFromStep: nextStep,
      reason: `Task was interrupted. ${completedSteps} of ${totalSteps} steps completed. Resume from step ${nextStep + 1} ("${state.steps[nextStep].label}").`,
      state,
    };
  }

  return { shouldResume: false, resumeFromStep: null, reason: 'All steps show as succeeded but task was not marked completed', state };
}

/**
 * Delete a task state file (for cleanup after tests).
 */
export function deleteTaskState(taskId: string): void {
  const path = statePath(taskId);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * List all task state files (for debugging / API endpoints).
 */
export function listTaskStates(): TaskState[] {
  if (!existsSync(STATE_DIR)) return [];
  const files = readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      return JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8')) as TaskState;
    } catch {
      return null;
    }
  }).filter((s): s is TaskState => s !== null);
}

// ── Internal: persist to disk ───────────────────────────────────────────

function persistState(state: TaskState): void {
  const path = statePath(state.taskId);
  try {
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error(`[task-state] failed to persist state for ${state.taskId}:`, err);
  }
}
