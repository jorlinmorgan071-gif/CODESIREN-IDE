// server/tests/unit/workflow-runner.test.ts
// Phase B: Workflow Automation — workflow runner tests.
//
// Tests:
//   1. Read-only workflow (typecheck + grep-audit) — real step-by-step results, stopOnFailure
//   2. Write-capable step warning — workflow with write step shows warning on every run
//   3. Scheduled trigger — timer actually fires

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { runWorkflow, startScheduledWorkflow, stopScheduledWorkflow } from '../../src/orchestration/workflow-runner.js';
import { saveWorkflow, deleteWorkflow, getWorkflows } from '../../src/orchestration/workflow-settings.js';
import { registerSink } from '../../src/ws/events.js';
import type { Workflow } from '../../src/orchestration/workflow-settings.js';
import type { AgentEvent } from '../../src/types.js';

let capturedEvents: AgentEvent[] = [];
let unsubscribeSink: (() => void) | null = null;

beforeAll(() => {
  unsubscribeSink = registerSink((event) => {
    capturedEvents.push(event);
  });
});

afterAll(() => {
  if (unsubscribeSink) unsubscribeSink();
});

describe('Phase B: Workflow Automation — Workflow Runner', () => {

  it('Test 1: Read-only workflow runs steps sequentially with real results', async () => {
    capturedEvents = [];

    const workflow: Workflow = {
      id: `test-readonly-${Date.now()}`,
      name: 'Read-Only Test Workflow',
      description: 'typecheck + grep-audit',
      steps: [
        { name: 'Typecheck', type: 'typecheck', stopOnFailure: true },
        { name: 'Grep Audit', type: 'grep-audit', stopOnFailure: true },
      ],
      trigger: 'manual',
      createdAt: new Date().toISOString(),
      enabled: true,
    };

    const result = await runWorkflow(workflow);

    // Verify structure
    expect(result.workflowId).toBe(workflow.id);
    expect(result.steps.length).toBe(2);
    expect(result.hadWriteSteps).toBe(false);

    // Log real results
    console.log(`  [test 1] workflow success: ${result.success}`);
    console.log(`  [test 1] total duration: ${result.totalDuration}ms`);
    for (const step of result.steps) {
      console.log(`  [test 1] step "${step.stepName}": ${step.success ? 'PASS' : 'FAIL'} (${step.duration}ms) skipped=${step.skipped}`);
      console.log(`  [test 1]   output: ${step.output.slice(0, 100)}`);
    }

    // Verify step results are real (not placeholders)
    expect(result.steps[0].stepName).toBe('Typecheck');
    expect(result.steps[0].stepType).toBe('typecheck');
    expect(typeof result.steps[0].success).toBe('boolean');
    expect(result.steps[0].duration).toBeGreaterThan(0);
    expect(result.steps[0].skipped).toBe(false);

    expect(result.steps[1].stepName).toBe('Grep Audit');
    expect(result.steps[1].stepType).toBe('grep-audit');
    expect(typeof result.steps[1].success).toBe('boolean');
    expect(result.steps[1].skipped).toBe(false);

    // Verify WS events were broadcast
    const startEvents = capturedEvents.filter(e => e.event === ('workflow:start' as any));
    const stepStartEvents = capturedEvents.filter(e => e.event === ('workflow:step-start' as any));
    const stepResultEvents = capturedEvents.filter(e => e.event === ('workflow:step-result' as any));
    const completeEvents = capturedEvents.filter(e => e.event === ('workflow:complete' as any));

    expect(startEvents.length).toBe(1);
    expect(stepStartEvents.length).toBe(2);
    expect(stepResultEvents.length).toBe(2);
    expect(completeEvents.length).toBe(1);
  }, 120000);

  it('Test 1b: stopOnFailure actually halts on real induced failure', async () => {
    capturedEvents = [];

    const workflow: Workflow = {
      id: `test-stoponfail-${Date.now()}`,
      name: 'StopOnFailure Test',
      description: 'failing step + step that should be skipped',
      steps: [
        { name: 'Failing Step', type: 'custom', command: 'exit 1', stopOnFailure: true },
        { name: 'Should Be Skipped', type: 'typecheck', stopOnFailure: true },
      ],
      trigger: 'manual',
      createdAt: new Date().toISOString(),
      enabled: true,
    };

    const result = await runWorkflow(workflow);

    console.log(`  [test 1b] workflow success: ${result.success}`);
    for (const step of result.steps) {
      console.log(`  [test 1b] step "${step.stepName}": success=${step.success} skipped=${step.skipped}`);
    }

    // First step should fail
    expect(result.steps[0].success).toBe(false);
    expect(result.steps[0].skipped).toBe(false);

    // Second step should be skipped (stopOnFailure halted execution)
    expect(result.steps[1].skipped).toBe(true);
    expect(result.steps[1].output).toContain('Skipped');

    // Overall result should be failed
    expect(result.success).toBe(false);
  }, 30000);

  it('Test 2: Write-capable step warning shows on every run', async () => {
    capturedEvents = [];

    const workflow: Workflow = {
      id: `test-write-${Date.now()}`,
      name: 'Write Step Test',
      description: 'workflow with a write-capable custom step',
      steps: [
        { name: 'Typecheck', type: 'typecheck', stopOnFailure: true },
        { name: 'Write Step', type: 'custom', command: 'npm audit fix --dry-run', stopOnFailure: false },
      ],
      trigger: 'manual',
      createdAt: new Date().toISOString(),
      enabled: true,
    };

    const result = await runWorkflow(workflow);

    console.log(`  [test 2] hadWriteSteps: ${result.hadWriteSteps}`);
    console.log(`  [test 2] workflow success: ${result.success}`);

    // Verify warning was broadcast
    const warningEvents = capturedEvents.filter(e => e.event === ('workflow:warning' as any));
    console.log(`  [test 2] warning events: ${warningEvents.length}`);

    expect(result.hadWriteSteps).toBe(true);
    expect(warningEvents.length).toBe(1);
    const warningPayload = warningEvents[0]?.payload as { warning?: string };
    expect(warningPayload).toHaveProperty('warning');
    expect(warningPayload.warning?.toLowerCase()).toContain('write');

    // Run again — warning should appear again (every run, not just creation)
    capturedEvents = [];
    await runWorkflow(workflow);
    const warningEvents2 = capturedEvents.filter(e => e.event === ('workflow:warning' as any));
    console.log(`  [test 2] warning events on 2nd run: ${warningEvents2.length}`);
    expect(warningEvents2.length).toBe(1);
  }, 60000);

  it('Test 3: Scheduled trigger actually fires on its own timer', async () => {
    capturedEvents = [];

    const workflow: Workflow = {
      id: `test-scheduled-${Date.now()}`,
      name: 'Scheduled Test',
      description: 'scheduled workflow with 5s interval',
      steps: [
        { name: 'Quick Check', type: 'custom', command: 'echo hello-from-scheduled-workflow', stopOnFailure: true },
      ],
      trigger: 'scheduled',
      scheduleIntervalMs: 5000, // 5 seconds (minimum allowed)
      createdAt: new Date().toISOString(),
      enabled: true,
    };

    // Start the scheduled workflow
    startScheduledWorkflow(workflow);
    console.log(`  [test 3] scheduled workflow started with 5s interval`);

    // Wait 7 seconds for the timer to fire
    await new Promise(r => setTimeout(r, 7000));

    // Check if workflow:complete events fired
    const completeEvents = capturedEvents.filter(e => e.event === ('workflow:complete' as any));
    console.log(`  [test 3] workflow:complete events after 7s: ${completeEvents.length}`);

    // Stop the scheduled workflow
    stopScheduledWorkflow(workflow.id);
    console.log(`  [test 3] scheduled workflow stopped`);

    // Verify the timer actually fired
    expect(completeEvents.length).toBeGreaterThanOrEqual(1);

    // Verify the workflow actually ran
    const startEvents = capturedEvents.filter(e => e.event === ('workflow:start' as any));
    expect(startEvents.length).toBeGreaterThanOrEqual(1);

    // Log the actual event payload
    if (completeEvents.length > 0) {
      const payload = completeEvents[0]?.payload as any;
      console.log(`  [test 3] complete event payload: success=${payload?.success}, stepCount=${payload?.stepCount}, duration=${payload?.totalDuration}ms`);
    }
  }, 30000);
});
