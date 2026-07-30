// tests/unit/traces.test.ts
// P1: Trace system — startTrace, addStep, completeTrace, getTrace, listTraces.

import { describe, it, expect, beforeEach } from 'vitest';
import { startTrace, addStep, addToolResult, completeTrace, getTrace, listTraces, setOutcome } from '../../src/observability/traces.js';

describe('Trace System', () => {
  it('startTrace creates a trace with correct fields', () => {
    const traceId = startTrace({
      taskId: 'test-task-1',
      agentId: 'test-agent',
      domain: 'TEST',
      executionMode: 'single-shot',
      input: 'test input',
    });
    expect(traceId).toBe('test-task-1');

    const trace = getTrace(traceId);
    expect(trace).not.toBeNull();
    expect(trace!.agentId).toBe('test-agent');
    expect(trace!.executionMode).toBe('single-shot');
    expect(trace!.input).toBe('test input');
    expect(trace!.steps).toHaveLength(0);
    expect(trace!.outcome).toBe('success'); // default
  });

  it('addStep adds a step to the trace', () => {
    const traceId = startTrace({
      taskId: 'test-task-2',
      agentId: 'test-agent',
      domain: 'TEST',
      executionMode: 'single-shot',
      input: 'test',
    });
    addStep(traceId, {
      kind: 'llm-call',
      label: 'test LLM call',
      meta: { test: true },
    });
    const trace = getTrace(traceId);
    expect(trace!.steps).toHaveLength(1);
    expect(trace!.steps[0].kind).toBe('llm-call');
    expect(trace!.steps[0].label).toBe('test LLM call');
    expect(trace!.steps[0].meta?.test).toBe(true);
  });

  it('addToolResult adds a tool result', () => {
    const traceId = startTrace({
      taskId: 'test-task-3',
      agentId: 'test-agent',
      domain: 'TEST',
      executionMode: 'single-shot',
      input: 'test',
    });
    addToolResult(traceId, {
      name: 'calculator',
      args: { expr: '2+2' },
      result: '4',
      success: true,
    });
    const trace = getTrace(traceId);
    expect(trace!.toolResults).toHaveLength(1);
    expect(trace!.toolResults[0].name).toBe('calculator');
    expect(trace!.toolResults[0].success).toBe(true);
  });

  it('completeTrace sets output and duration', () => {
    const traceId = startTrace({
      taskId: 'test-task-4',
      agentId: 'test-agent',
      domain: 'TEST',
      executionMode: 'single-shot',
      input: 'test',
    });
    const trace = completeTrace(traceId, 'test output');
    expect(trace).not.toBeNull();
    expect(trace!.output).toBe('test output');
    expect(trace!.completedAt).toBeDefined();
    expect(trace!.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('setOutcome changes the outcome', () => {
    const traceId = startTrace({
      taskId: 'test-task-5',
      agentId: 'test-agent',
      domain: 'TEST',
      executionMode: 'single-shot',
      input: 'test',
    });
    setOutcome(traceId, 'error', 'something went wrong');
    const trace = getTrace(traceId);
    expect(trace!.outcome).toBe('error');
    expect(trace!.errorMessage).toBe('something went wrong');
  });

  it('listTraces returns recent traces', () => {
    const traces = listTraces({ limit: 10 });
    expect(traces.length).toBeGreaterThan(0);
    // Newest first
    expect(traces[0].completedAt).toBeDefined();
  });

  it('listTraces filters by agentId', () => {
    startTrace({
      taskId: 'test-task-filter',
      agentId: 'filter-agent',
      domain: 'TEST',
      executionMode: 'single-shot',
      input: 'test',
    });
    completeTrace('test-task-filter', 'done');
    const traces = listTraces({ agentId: 'filter-agent', limit: 10 });
    expect(traces.every(t => t.agentId === 'filter-agent')).toBe(true);
  });
});
