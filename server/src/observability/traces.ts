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

export interface TraceStep {
  ts: number;                       // epoch ms
  kind: TraceStepKind;
  label: string;                    // human-readable summary
  input?: unknown;                  // what went in (prompt, tool name+args, code)
  output?: unknown;                 // what came out (response text, tool result, exec output)
  durationMs?: number;              // how long this step took
  meta?: Record<string, unknown>;   // anything else (turn number, model id, etc.)
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
  };
  activeTraces.set(traceId, trace);
  return traceId;
}

export function addStep(traceId: string, step: Omit<TraceStep, 'ts'> & { ts?: number }): void {
  const trace = activeTraces.get(traceId);
  if (!trace) return;
  trace.steps.push({ ts: step.ts ?? Date.now(), ...step });
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

export function completeTrace(traceId: string, output: string): AgentRunTrace | null {
  const trace = activeTraces.get(traceId);
  if (!trace) return null;
  trace.output = output;
  trace.completedAt = Date.now();
  trace.totalDurationMs = trace.completedAt - trace.startedAt;

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

export function getTrace(traceId: string): AgentRunTrace | null {
  // Phase 5 — O(1) lookup via the index. Falls back to active traces
  // (still O(1) — activeTraces is already a Map).
  return activeTraces.get(traceId) ?? traceIndex.get(traceId) ?? null;
}

export function listTraces(opts: { agentId?: string; executionMode?: ExecutionMode; limit?: number } = {}): AgentRunTrace[] {
  const limit = opts.limit ?? 100;
  // Phase 5 — avoid copying the entire ring buffer when no filters are set.
  // Just slice the last `limit` entries (still returns newest-first).
  if (!opts.agentId && !opts.executionMode) {
    // No filters — slice from the end (newest), reverse to newest-first
    const start = Math.max(0, ringBuffer.length - limit);
    const slice = ringBuffer.slice(start);
    return slice.reverse();
  }
  // Filtered path — has to scan, but only filters once (combined predicate)
  const pred = (t: AgentRunTrace) =>
    (!opts.agentId || t.agentId === opts.agentId) &&
    (!opts.executionMode || t.executionMode === opts.executionMode);
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
