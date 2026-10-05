// server/src/observability/traces.ts
// Trace recorder — the SEED of server/observability/ per user instruction
// ("capture it now while it's cheap, rather than retrofitting telemetry onto
// strategies after they're already built").
//
// Every strategy run (single-shot, react, codeact) appends a trace entry.
// Traces are:
//   1. Held in an in-memory ring buffer (last 1000 runs, queryable via API)
//   2. Persisted to server/.traces/runs.jsonl (one JSON object per line, append-only)
//
// This is the format the agent-evolver (Step 6 #10) and Skills discovery
// (Step 3) will mine later. Capture shape now, mine it later.

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionMode } from '../types.js';
import { scopesMatch, type TenantScope } from '../tenancy/scope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACES_DIR = join(__dirname, '..', '..', '.traces');
const TRACES_FILE = join(TRACES_DIR, 'runs.jsonl');

// Ensure the traces directory exists
if (!existsSync(TRACES_DIR)) {
  mkdirSync(TRACES_DIR, { recursive: true });
}

// ── Trace shapes ─────────────────────────────────────────────────────────

export type TraceStepKind =
  | 'llm-call'           // a call to the Model Router
  | 'tool-call'          // a tool invocation (within react/codeact)
  | 'code-exec'          // a Python code block execution (codeact only)
  | 'parse'              // parsing model output (action / final answer / code block)
  | 'loop-guard'         // LoopGuard blocked a call
  | 'done'               // strategy returned
  | 'error';             // strategy threw

/**
 * Phase 5: Execution truth status for each step.
 * This is recorded from actual execution evidence, NOT from model-generated claims.
 *
 * - 'planned': the step was intended (e.g. task description says "run tests")
 * - 'running': the step is currently executing
 * - 'succeeded': the step completed successfully (verified by actual execution)
 * - 'failed': the step failed (verified by actual error/exception)
 * - 'skipped': the step was intentionally not executed
 * - 'unverified': the step claims to have done something but no verification evidence exists
 */
export type StepStatus = 'planned' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'unverified';

/**
 * Phase 5: A verification record — evidence that an actual verification
 * step (typecheck, test, lint, etc.) was executed. This is NOT model text.
 * It is recorded by the system when a verification command actually runs.
 */
export interface VerificationRecord {
  name: string;           // e.g. 'typecheck', 'tests', 'lint'
  kind: 'typecheck' | 'test' | 'lint' | 'build' | 'custom';
  status: StepStatus;     // 'succeeded' | 'failed' | 'skipped' | 'unverified'
  timestamp: number;      // when the verification was recorded
  output?: string;        // output of the verification (truncated to 500 chars)
  durationMs?: number;    // how long the verification took
  exitCode?: number;      // exit code if available
}

export interface TraceStep {
  ts: number;                       // epoch ms
  kind: TraceStepKind;
  label: string;                    // human-readable summary
  input?: unknown;                  // what went in (prompt, tool name+args, code)
  output?: unknown;                 // what came out (response text, tool result, exec output)
  durationMs?: number;              // how long this step took
  meta?: Record<string, unknown>;   // anything else (turn number, model id, etc.)
  status?: StepStatus;              // Phase 5: execution truth per step
}

export interface AgentRunTrace {
  traceId: string;                  // uuid — same as taskId
  taskId: string;                   // FK to agent_tasks.id
  agentId: string;                  // e.g. 'qa-tester-agent'
  domain: string;                   // e.g. 'QA'
  executionMode: ExecutionMode;     // 'single-shot' | 'react' | 'codeact'
  input: string;                    // user's original prompt
  output?: string;                  // final assembled response
  startedAt: number;                // epoch ms
  completedAt?: number;             // epoch ms
  totalDurationMs?: number;
  turns: number;                    // how many LLM turns the strategy took
  steps: TraceStep[];               // ordered call/step trace
  toolResults: Array<{ name: string; args: unknown; result: unknown; success: boolean }>;
  outcome: 'success' | 'error' | 'loop-blocked' | 'max-turns' | 'aborted';
  errorMessage?: string;
  /** Server-resolved tenant scope; unscoped legacy traces are never public. */
  scope?: TenantScope;
  // Phase 5: Execution truth — what ACTUALLY happened vs what the model CLAIMED.
  // These fields are populated by real execution evidence, not by model text.
  verificationRecords: VerificationRecord[];         // actual verification runs
  verificationStatus: 'unverified' | 'passed' | 'failed' | 'partial';  // computed from records
}

// ── Recorder ─────────────────────────────────────────────────────────────

const RING_BUFFER_MAX = 1000;
const ringBuffer: AgentRunTrace[] = [];
// Phase 5 — O(1) traceId lookup index. Mirrors the ring buffer; kept in sync
// in completeTrace() and never exposed publicly. The existing getTrace() API
// is unchanged — it just becomes O(1) instead of O(n).
const traceIndex = new Map<string, AgentRunTrace>();
const activeTraces = new Map<string, AgentRunTrace>();  // traceId → in-progress trace

export function startTrace(opts: {
  taskId: string;
  agentId: string;
  domain: string;
  executionMode: ExecutionMode;
  input: string;
  scope?: TenantScope;
}): string {
  const traceId = opts.taskId;  // 1:1 with task for simplicity
  const trace: AgentRunTrace = {
    traceId,
    taskId: opts.taskId,
    agentId: opts.agentId,
    domain: opts.domain,
    executionMode: opts.executionMode,
    input: opts.input,
    startedAt: Date.now(),
    turns: 0,
    steps: [],
    toolResults: [],
    outcome: 'success',
    scope: opts.scope,
    // Phase 5: execution truth — starts unverified
    verificationRecords: [],
    verificationStatus: 'unverified',
  };
  activeTraces.set(traceId, trace);
  return traceId;
}

// ── Trace step recording ──────────────────────────────────────────────

export function addStep(traceId: string, step: Omit<TraceStep, 'ts'> & { ts?: number }): void {
  const trace = activeTraces.get(traceId);
  if (!trace) return;
  const fullStep: TraceStep = { ts: step.ts ?? Date.now(), ...step };
  trace.steps.push(fullStep);

  // Phase 5: broadcast the step as a WS event so the UI can show
  // real-time progress (Planning → Analysis → Editing → Tests → etc.)
  // This is the "observable window into the execution engine" — the chat
  // panel renders these as a visual step tracker.
  try {
    const { makeEvent, broadcast } = require('../ws/events.js');
    broadcast(makeEvent('agent:step' as any, {
      traceId,
      taskId: trace.taskId,
      agentId: trace.agentId,
      step: fullStep,
    }));
  } catch {
    // broadcast may fail if WS server isn't running (e.g., in tests)
  }
}

export function incrementTurn(traceId: string): void {
  const trace = activeTraces.get(traceId);
  if (!trace) return;
  trace.turns++;
}

export function addToolResult(traceId: string, result: { name: string; args: unknown; result: unknown; success: boolean }): void {
  const trace = activeTraces.get(traceId);
  if (!trace) return;
  trace.toolResults.push(result);
}

export function setOutcome(traceId: string, outcome: AgentRunTrace['outcome'], errorMessage?: string): void {
  const trace = activeTraces.get(traceId);
  if (!trace) return;
  trace.outcome = outcome;
  if (errorMessage) trace.errorMessage = errorMessage;
}

/**
 * Phase 5: Record a verification step that ACTUALLY executed.
 * This is NOT model text. It is recorded by the system when a real
 * verification command (typecheck, test, lint) runs.
 *
 * The model saying "tests passed" does NOT call this function.
 * Only actual system-level verification execution calls this.
 */
export function addVerification(traceId: string, record: Omit<VerificationRecord, 'timestamp'>): void {
  const trace = activeTraces.get(traceId);
  if (!trace) return;
  trace.verificationRecords.push({ ...record, timestamp: Date.now() });
}

/**
 * Phase 5: Compute verification status from the actual verification records.
 * - No records → 'unverified'
 * - All succeeded → 'passed'
 * - Any failed → 'failed'
 * - Mix of succeeded and skipped (but no failures) → 'partial'
 */
function computeVerificationStatus(records: VerificationRecord[]): AgentRunTrace['verificationStatus'] {
  if (records.length === 0) return 'unverified';
  const hasFailed = records.some(r => r.status === 'failed');
  if (hasFailed) return 'failed';
  const allSucceeded = records.every(r => r.status === 'succeeded');
  if (allSucceeded) return 'passed';
  // Some succeeded, some skipped — partial
  return 'partial';
}

export function completeTrace(traceId: string, output: string): AgentRunTrace | null {
  const trace = activeTraces.get(traceId);
  if (!trace) return null;
  trace.output = output;
  trace.completedAt = Date.now();
  trace.totalDurationMs = trace.completedAt - trace.startedAt;

  // Phase 5: Compute final verification status from actual records
  trace.verificationStatus = computeVerificationStatus(trace.verificationRecords);

  // Move from active → ring buffer
  activeTraces.delete(traceId);
  ringBuffer.push(trace);
  // Phase 5 — keep the O(1) index in sync
  traceIndex.set(traceId, trace);
  if (ringBuffer.length > RING_BUFFER_MAX) {
    const evicted = ringBuffer.shift();
    if (evicted) traceIndex.delete(evicted.traceId);
  }

  // Persist to JSONL (append-only, one object per line)
  try {
    appendFileSync(TRACES_FILE, JSON.stringify(trace) + '\n', 'utf8');
  } catch (err) {
    console.error('[traces] failed to persist trace:', err);
  }

  return trace;
}

export function getTrace(traceId: string, scope?: TenantScope): AgentRunTrace | null {
  // Phase 5 — O(1) lookup via the index. Falls back to active traces
  // (still O(1) — activeTraces is already a Map).
  const trace = activeTraces.get(traceId) ?? traceIndex.get(traceId) ?? null;
  if (!trace) return null;
  if (scope && !scopesMatch(trace.scope, scope)) return null;
  return trace;
}

export function listTraces(opts: { agentId?: string; executionMode?: ExecutionMode; limit?: number; scope?: TenantScope } = {}): AgentRunTrace[] {
  const limit = opts.limit ?? 100;
  // Phase 5 — avoid copying the entire ring buffer when no filters are set.
  // Just slice the last `limit` entries (still returns newest-first).
  if (!opts.agentId && !opts.executionMode && !opts.scope) {
    // No filters — slice from the end (newest), reverse to newest-first
    const start = Math.max(0, ringBuffer.length - limit);
    const slice = ringBuffer.slice(start);
    return slice.reverse();
  }
  // Filtered path — has to scan, but only filters once (combined predicate)
  const pred = (t: AgentRunTrace) =>
    (!opts.agentId || t.agentId === opts.agentId) &&
    (!opts.executionMode || t.executionMode === opts.executionMode) &&
    (!opts.scope || scopesMatch(t.scope, opts.scope));
  // Walk the ring buffer backwards (newest first), collect up to `limit` matches
  const out: AgentRunTrace[] = [];
  for (let i = ringBuffer.length - 1; i >= 0 && out.length < limit; i--) {
    const t = ringBuffer[i];
    if (pred(t)) out.push(t);
  }
  return out;
}

export function getTracesFile(): string {
  return TRACES_FILE;
}

/**
 * Phase 5: Get the verification status of a trace.
 * Returns 'unverified' if the trace doesn't exist or has no verification records.
 * This is the authoritative verification truth — NOT model text.
 */
export function getVerificationStatus(traceId: string): AgentRunTrace['verificationStatus'] {
  const trace = activeTraces.get(traceId) ?? traceIndex.get(traceId);
  if (!trace) return 'unverified';
  return trace.verificationStatus;
}

/**
 * Phase 5: Get all verification records for a trace.
 * Returns empty array if no verification was recorded.
 */
export function getVerificationRecords(traceId: string): VerificationRecord[] {
  const trace = activeTraces.get(traceId) ?? traceIndex.get(traceId);
  if (!trace) return [];
  return [...trace.verificationRecords];
}
