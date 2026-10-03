// server/tests/unit/task-state.test.ts
// Phase 3 — TaskState unit tests.
//
// Tests the task-state object's lifecycle: init → start → complete → interrupt → resume.
// Uses the file system (server/.task-states/) for real persistence verification.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initTaskState,
  startStep,
  completeStep,
  failStep,
  completeTask,
  markInterrupted,
  loadTaskState,
  getResumptionPoint,
  deleteTaskState,
} from '../../src/orchestration/task-state.js';

describe('TaskState — Phase 3 resumption object', () => {
  const testTaskId = `test-unit-${Date.now()}`;

  afterEach(() => {
    deleteTaskState(testTaskId);
  });

  // ── Initialization ──────────────────────────────────────────────────

  it('initTaskState creates a state file with correct initial values', () => {
    const state = initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Generate a Dockerfile',
      steps: [
        { label: 'Generate config' },
        { label: 'Memorize output' },
      ],
    });

    expect(state.taskId).toBe(testTaskId);
    expect(state.agentId).toBe('deployment-agent');
    expect(state.goal).toBe('Generate a Dockerfile');
    expect(state.status).toBe('not-started');
    expect(state.steps).toHaveLength(2);
    expect(state.steps[0].status).toBe('planned');
    expect(state.steps[1].status).toBe('planned');
    expect(state.interruptedAtStep).toBeNull();
    expect(state.changedArtifacts).toEqual([]);
    expect(state.verificationSummary).toEqual({ total: 0, passed: 0, failed: 0, unverified: 0 });

    // Verify it's persisted to disk
    const loaded = loadTaskState(testTaskId);
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe(testTaskId);
  });

  // ── Step lifecycle ──────────────────────────────────────────────────

  it('startStep marks a step as running + updates task status', () => {
    initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Test',
      steps: [{ label: 'Step 1' }, { label: 'Step 2' }],
    });

    startStep(testTaskId, 0);

    const state = loadTaskState(testTaskId)!;
    expect(state.steps[0].status).toBe('running');
    expect(state.steps[0].startedAt).not.toBeNull();
    expect(state.steps[0].completedAt).toBeNull();
    expect(state.status).toBe('in-progress');
  });

  it('completeStep marks a step as succeeded + records evidence', () => {
    initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Test',
      steps: [{ label: 'Step 1' }],
    });

    startStep(testTaskId, 0);
    completeStep(testTaskId, 0, {
      output: 'Some output text',
      changedFiles: ['/app/Dockerfile'],
      verification: { name: 'file-exists', status: 'succeeded' },
    });

    const state = loadTaskState(testTaskId)!;
    expect(state.steps[0].status).toBe('succeeded');
    expect(state.steps[0].completedAt).not.toBeNull();
    expect(state.steps[0].output).toBe('Some output text');
    expect(state.steps[0].changedFiles).toEqual(['/app/Dockerfile']);
    expect(state.changedArtifacts).toContain('/app/Dockerfile');
    expect(state.verificationSummary.total).toBe(1);
    expect(state.verificationSummary.passed).toBe(1);
  });

  it('failStep marks a step as failed + records error', () => {
    initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Test',
      steps: [{ label: 'Step 1' }],
    });

    startStep(testTaskId, 0);
    failStep(testTaskId, 0, 'Connection refused');

    const state = loadTaskState(testTaskId)!;
    expect(state.steps[0].status).toBe('failed');
    expect(state.steps[0].error).toBe('Connection refused');
    expect(state.status).toBe('failed');
    expect(state.error).toContain('Connection refused');
  });

  // ── Completion ─────────────────────────────────────────────────────

  it('completeTask marks the entire task as completed', () => {
    initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Test',
      steps: [{ label: 'Step 1' }],
    });

    startStep(testTaskId, 0);
    completeStep(testTaskId, 0, { output: 'Done' });
    completeTask(testTaskId, 'Final output');

    const state = loadTaskState(testTaskId)!;
    expect(state.status).toBe('completed');
    expect(state.completedAt).not.toBeNull();
    expect(state.interruptedAtStep).toBeNull();
    expect(state.finalOutput).toBe('Final output');
  });

  // ── Interruption + resumption ──────────────────────────────────────

  it('markInterrupted records which step was running', () => {
    initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Test',
      steps: [{ label: 'Step 1' }, { label: 'Step 2' }],
    });

    startStep(testTaskId, 0);
    // Simulate crash — markInterrupted is called by a watchdog
    markInterrupted(testTaskId);

    const state = loadTaskState(testTaskId)!;
    expect(state.status).toBe('interrupted');
    expect(state.interruptedAtStep).toBe(0);  // step 0 was running
  });

  it('getResumptionPoint for a not-started task returns resume=true from step 0', () => {
    initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Test',
      steps: [{ label: 'Step 1' }],
    });

    const resumption = getResumptionPoint(testTaskId);
    expect(resumption.shouldResume).toBe(true);
    expect(resumption.resumeFromStep).toBe(0);
  });

  it('getResumptionPoint for an interrupted task returns the interrupted step', () => {
    initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Test',
      steps: [{ label: 'Step 1' }, { label: 'Step 2' }],
    });

    // Complete step 0, start step 1, then crash
    startStep(testTaskId, 0);
    completeStep(testTaskId, 0, { output: 'Step 0 done' });
    startStep(testTaskId, 1);
    markInterrupted(testTaskId);

    const resumption = getResumptionPoint(testTaskId);
    expect(resumption.shouldResume).toBe(true);
    expect(resumption.resumeFromStep).toBe(1);  // step 1 was running
    expect(resumption.reason).toContain('step 2 of 2');
    expect(resumption.reason).toContain('1 step(s) completed');
  });

  it('getResumptionPoint for a completed task returns resume=false', () => {
    initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Test',
      steps: [{ label: 'Step 1' }],
    });

    startStep(testTaskId, 0);
    completeStep(testTaskId, 0, { output: 'Done' });
    completeTask(testTaskId, 'Final');

    const resumption = getResumptionPoint(testTaskId);
    expect(resumption.shouldResume).toBe(false);
    expect(resumption.reason).toContain('already completed');
  });

  it('getResumptionPoint for a non-existent task returns resume=false', () => {
    const resumption = getResumptionPoint('non-existent-task-id');
    expect(resumption.shouldResume).toBe(false);
    expect(resumption.state).toBeNull();
  });

  // ── Provider-agnostic design ────────────────────────────────────────

  it('state object is serializable + readable without provider internals', () => {
    initTaskState({
      taskId: testTaskId,
      agentId: 'deployment-agent',
      goal: 'Generate a Dockerfile',
      steps: [{ label: 'Generate config' }],
    });

    startStep(testTaskId, 0);
    completeStep(testTaskId, 0, { output: 'FROM node:20-alpine', changedFiles: ['/Dockerfile'] });
    completeTask(testTaskId, 'FROM node:20-alpine');

    const state = loadTaskState(testTaskId)!;
    const json = JSON.stringify(state);
    expect(json).toContain('"goal":"Generate a Dockerfile"');
    expect(json).toContain('"status":"completed"');
    expect(json).toContain('"FROM node:20-alpine"');
    expect(json).toContain('"/Dockerfile"');

    // A model reading this JSON can answer: what was I asked to do?
    const parsed = JSON.parse(json);
    expect(parsed.goal).toBe('Generate a Dockerfile');
    // What's done?
    expect(parsed.steps[0].status).toBe('succeeded');
    // What's left? (nothing — all steps succeeded)
    expect(parsed.steps.every((s: any) => s.status === 'succeeded')).toBe(true);
    // Where do I pick up? (nowhere — task is completed)
    expect(parsed.status).toBe('completed');
  });
});
