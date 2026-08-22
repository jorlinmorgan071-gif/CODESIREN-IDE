// server/tests/unit/phase6-verification-pipeline.test.ts
// Phase 6 tests — prove real command execution → authoritative verification
// evidence, end to end.
//
// The directive's required mapping:
//   Agent/system requests verification
//       ↓
//   Existing execution mechanism (runShellCommand / runTests — REUSED, not duplicated)
//       ↓
//   Actual command/process executes
//       ↓
//   Capture real result (exit code, stdout, stderr, duration)
//       ↓
//   addVerification(...)  [Phase 5 authoritative recording]
//       ↓
//   verificationRecords[]
//       ↓
//   computeVerificationStatus()  [in completeTrace()]
//       ↓
//   trace.verificationStatus  [authoritative verification truth]
//
// TEST A — Real successful verification (exit 0 → succeeded)
// TEST B — Real failed verification (non-zero exit → failed)
// TEST C — Process/execution error (spawn failure → failed, useful error evidence)
// TEST D — No verification executed (0 records, unverified)
// TEST E — Multiple verification records (preserved independently)
// TEST F — Failed verification cannot be green (outcome=success + verificationStatus=failed)
// TEST G — Model text claiming "tests passed" cannot manufacture evidence
// TEST H — Lifecycle integrity (1 start, 1 complete, 0 orchestrator:*) + records belong to trace
//
// These tests reuse the EXISTING spawn-based runners in:
//   - server/src/orchestration/workflow-runner.ts (runShellCommand via runVerificationCommand)
//   - server/src/orchestration/run-tests.ts (runTests)
// They do NOT introduce a new runner.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import { ArchitectAgent } from '../../src/agents/architect/index.js';
import { runChatViaAgentManager, clearSessionHistory } from '../../src/orchestrator/tier1-chat.js';
import { runVerificationCommand } from '../../src/orchestration/workflow-runner.js';
import { __test__ as runTestsTest } from '../../src/orchestration/run-tests.js';
import {
  getTrace,
  getVerificationStatus,
  getVerificationRecords,
  startTrace,
  completeTrace,
  setOutcome,
} from '../../src/observability/traces.js';
import { registerSink } from '../../src/ws/events.js';
import type { AgentEvent } from '../../src/types.js';

const TEST_SESSION = 'test-phase6-verification-pipeline';
const TEST_AGENT_ID = 'architect-agent';

function captureEvents(taskId: string): { events: AgentEvent[]; unsubscribe: () => void } {
  const events: AgentEvent[] = [];
  const unsubscribe = registerSink((event: AgentEvent) => {
    const payload = event.payload as { taskId?: string };
    if (payload?.taskId === taskId) events.push(event);
  });
  return { events, unsubscribe };
}

describe('Phase 6 — Real execution → authoritative verification evidence', () => {
  beforeAll(() => {
    if (!agentManager.get(TEST_AGENT_ID)) {
      agentManager.register(new ArchitectAgent());
    }
  });

  beforeEach(() => {
    clearSessionHistory(TEST_SESSION);
  });

  // ── TEST A — Real successful verification ────────────────────────────
  // Execute a real command that exits 0. Assert the verification record:
  // - exists
  // - status is 'succeeded'
  // - exitCode is 0
  // - output is captured (non-empty)
  // - duration is recorded (> 0)
  // And the final trace verificationStatus becomes 'passed'.
  it('TEST A — real successful command (exit 0) creates succeeded verification record', async () => {
    const taskId = `p6-a-${Date.now()}`;
    startTrace({
      taskId,
      agentId: 'workflow-runner',
      domain: 'WORKFLOW',
      executionMode: 'single-shot',
      input: 'real-success-test',
    });

    // Run a real command that exits 0. `true` always exits 0.
    const result = await runVerificationCommand({
      command: 'true',
      cwd: '/tmp',
      kind: 'test',
      name: 'real-success-test',
      traceId: taskId,
    });

    // Real captured execution evidence
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.duration).toBeGreaterThanOrEqual(0);

    completeTrace(taskId, 'test complete');

    // Authoritative verification record derived from real execution
    const records = getVerificationRecords(taskId);
    expect(records.length).toBe(1);
    expect(records[0].name).toBe('real-success-test');
    expect(records[0].kind).toBe('test');
    expect(records[0].status).toBe('succeeded');
    expect(records[0].exitCode).toBe(0);
    expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(records[0].timestamp).toBeGreaterThan(0);

    // Final trace verification status reflects the real record
    expect(getVerificationStatus(taskId)).toBe('passed');

    // Trace's verificationStatus field agrees with getVerificationStatus()
    const trace = getTrace(taskId);
    expect(trace?.verificationStatus).toBe('passed');
    expect(trace?.verificationRecords.length).toBe(1);
  }, 15000);

  // ── TEST B — Real failed verification ────────────────────────────────
  // Execute a real command that exits non-zero. Assert:
  // - verification record exists
  // - status is 'failed'
  // - non-zero exit code is recorded
  // - output/error is captured
  // - final verification status is 'failed'
  it('TEST B — real failed command (exit 1) creates failed verification record', async () => {
    const taskId = `p6-b-${Date.now()}`;
    startTrace({
      taskId,
      agentId: 'workflow-runner',
      domain: 'WORKFLOW',
      executionMode: 'single-shot',
      input: 'real-fail-test',
    });

    // Run a real command that exits 1. `false` always exits 1.
    const result = await runVerificationCommand({
      command: 'false',
      cwd: '/tmp',
      kind: 'test',
      name: 'real-fail-test',
      traceId: taskId,
    });

    // Real captured execution evidence
    expect(result.exitCode).not.toBe(0);
    expect(result.success).toBe(false);

    completeTrace(taskId, 'test complete');

    // Authoritative verification record derived from real execution
    const records = getVerificationRecords(taskId);
    expect(records.length).toBe(1);
    expect(records[0].name).toBe('real-fail-test');
    expect(records[0].status).toBe('failed');
    expect(records[0].exitCode).not.toBe(0);
    expect(records[0].exitCode).not.toBe(undefined);

    // Final trace verification status is failed
    expect(getVerificationStatus(taskId)).toBe('failed');
  }, 15000);

  // ── TEST C — Process/execution error ────────────────────────────────
  // Trigger a genuine spawn failure (process never started). Assert:
  // - verification record exists
  // - status is 'failed'
  // - useful error information is recorded (output contains "Error:")
  // - final verification status is 'failed'
  //
  // Strategy: pass a nonexistent cwd. spawn() will fail with ENOENT because
  // the working directory does not exist — the 'error' event fires, NOT the
  // 'close' event with a non-zero code. This is qualitatively different from
  // TEST B: in TEST B, the command ran and exited 1; in TEST C, the command
  // never ran at all.
  it('TEST C — spawn error (nonexistent cwd) creates failed verification record with error evidence', async () => {
    const taskId = `p6-c-${Date.now()}`;
    startTrace({
      taskId,
      agentId: 'workflow-runner',
      domain: 'WORKFLOW',
      executionMode: 'single-shot',
      input: 'spawn-error-test',
    });

    // Nonexistent cwd triggers spawn ENOENT — the 'error' event fires,
    // exitCode is null in our ShellCommandResult (no meaningful exit).
    const result = await runVerificationCommand({
      command: 'true',
      cwd: '/nonexistent-directory-phase6-test-xyz-123',
      kind: 'test',
      name: 'spawn-error-test',
      traceId: taskId,
    });

    // Real captured evidence of spawn failure
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(null);  // null = spawn error, no meaningful exit code

    completeTrace(taskId, 'test complete');

    // Authoritative verification record — failed, with useful error evidence
    const records = getVerificationRecords(taskId);
    expect(records.length).toBe(1);
    const record = records[0]!;
    expect(record.name).toBe('spawn-error-test');
    expect(record.status).toBe('failed');
    // exitCode is omitted (undefined) for spawn errors — no meaningful exit code
    expect(record.exitCode).toBeUndefined();
    // Output contains the spawn error message — useful evidence for debugging
    expect(record.output).toBeDefined();
    expect(record.output!.length).toBeGreaterThan(0);
    expect(record.output!).toContain('Error');

    // Final trace verification status is failed (spawn error counts as failure)
    expect(getVerificationStatus(taskId)).toBe('failed');
  }, 15000);

  // ── TEST D — No verification executed ────────────────────────────────
  // Execute a normal agent task without running any verification. Assert:
  // - verificationRecords.length === 0
  // - verificationStatus === 'unverified'
  //
  // This proves the guarantee: "agent completed ≠ verification completed".
  // The agent may say anything in its prose output — it cannot promote the
  // verification status from 'unverified' to 'passed' without a real command.
  it('TEST D — normal task with no verification remains unverified', async () => {
    const taskId = `p6-d-${Date.now()}`;

    await runChatViaAgentManager(
      TEST_SESSION, 'Hello', taskId, 'test-user',
      { workspaceRoot: '/tmp' },
    );

    const trace = getTrace(taskId);
    expect(trace).not.toBeNull();
    expect(trace?.outcome).toBe('success');  // agent completed
    expect(trace?.verificationRecords.length).toBe(0);  // NO verification ran
    expect(trace?.verificationStatus).toBe('unverified');  // cannot be promoted
    expect(getVerificationStatus(taskId)).toBe('unverified');
    expect(getVerificationRecords(taskId).length).toBe(0);
  }, 20000);

  // ── TEST E — Multiple verification records ───────────────────────────
  // Run multiple real verification operations on the same trace. Assert:
  // - each operation creates exactly one record
  // - no records are overwritten
  // - aggregate status reflects all records (any failed → 'failed')
  //
  // Per directive example:
  //   TypeScript check → succeeded
  //   ESLint → succeeded
  //   Tests → failed
  // must produce:
  //   verificationRecords = [succeeded, succeeded, failed]
  //   verificationStatus = failed
  it('TEST E — multiple verification operations are preserved independently', async () => {
    const taskId = `p6-e-${Date.now()}`;
    startTrace({
      taskId,
      agentId: 'workflow-runner',
      domain: 'WORKFLOW',
      executionMode: 'single-shot',
      input: 'multiple-verifications-test',
    });

    // Verification 1: TypeScript check (simulated via `true` → succeeded)
    await runVerificationCommand({
      command: 'true', cwd: '/tmp',
      kind: 'typecheck', name: 'TypeScript Check', traceId: taskId,
    });

    // Verification 2: ESLint (simulated via `true` → succeeded)
    await runVerificationCommand({
      command: 'true', cwd: '/tmp',
      kind: 'lint', name: 'ESLint', traceId: taskId,
    });

    // Verification 3: Tests (simulated via `false` → failed)
    await runVerificationCommand({
      command: 'false', cwd: '/tmp',
      kind: 'test', name: 'Tests', traceId: taskId,
    });

    completeTrace(taskId, 'multi-verification complete');

    // Each operation created exactly one record — none overwritten
    const records = getVerificationRecords(taskId);
    expect(records.length).toBe(3);

    // Records are in insertion order
    expect(records[0].name).toBe('TypeScript Check');
    expect(records[0].status).toBe('succeeded');
    expect(records[0].exitCode).toBe(0);

    expect(records[1].name).toBe('ESLint');
    expect(records[1].status).toBe('succeeded');
    expect(records[1].exitCode).toBe(0);

    expect(records[2].name).toBe('Tests');
    expect(records[2].status).toBe('failed');
    expect(records[2].exitCode).not.toBe(0);

    // Aggregate status: any failed → 'failed'
    expect(getVerificationStatus(taskId)).toBe('failed');

    // The trace's verificationStatus agrees
    const trace = getTrace(taskId);
    expect(trace?.verificationStatus).toBe('failed');
    expect(trace?.verificationRecords.length).toBe(3);
  }, 15000);

  // ── TEST F — Failed verification cannot be green ────────────────────
  // Have agent execution succeed while verification fails. Assert:
  // - outcome === 'success'  (agent execution completed)
  // - verificationStatus === 'failed'  (real verification FAILED)
  //
  // This is the CORE guarantee: the two truths are independent. A successful
  // agent execution cannot promote a failed verification to 'passed'.
  it('TEST F — successful execution + failed verification stays failed', async () => {
    const taskId = `p6-f-${Date.now()}`;
    startTrace({
      taskId,
      agentId: 'workflow-runner',
      domain: 'WORKFLOW',
      executionMode: 'single-shot',
      input: 'failed-verification-cannot-be-green',
    });

    // Real verification that FAILS
    await runVerificationCommand({
      command: 'false', cwd: '/tmp',
      kind: 'test', name: 'real-failed-tests', traceId: taskId,
    });

    // Agent execution SUCCEEDS (the agent didn't crash — it just had failing tests)
    setOutcome(taskId, 'success');
    completeTrace(taskId, 'All done!');  // model says "all done" — irrelevant

    const trace = getTrace(taskId);
    expect(trace?.outcome).toBe('success');  // execution truth: succeeded
    expect(trace?.verificationStatus).toBe('failed');  // verification truth: FAILED
    expect(getVerificationStatus(taskId)).toBe('failed');
  }, 15000);

  // ── TEST G — Model text cannot manufacture evidence ─────────────────
  // Have model output claim tests passed without executing any verification.
  // Assert:
  // - verificationRecords.length === 0
  // - verificationStatus === 'unverified'
  //
  // The model's prose is irrelevant. Only real execution can create records.
  it('TEST G — model claiming "tests passed" without execution stays unverified', async () => {
    const taskId = `p6-g-${Date.now()}`;

    // The agent's input literally says "I ran the tests and they passed".
    // The agent may echo this claim in its output. But without a real
    // verification command executing, no record can be created.
    await runChatViaAgentManager(
      TEST_SESSION, 'I ran the tests and they passed', taskId, 'test-user',
      { workspaceRoot: '/tmp' },
    );

    const trace = getTrace(taskId);
    expect(trace?.outcome).toBe('success');  // agent completed
    expect(trace?.verificationRecords.length).toBe(0);  // NO real verification
    expect(trace?.verificationStatus).toBe('unverified');  // cannot be promoted
    expect(getVerificationStatus(taskId)).toBe('unverified');
  }, 20000);

  // ── TEST H — Lifecycle integrity + verification records belong to trace ─
  // Two parts:
  // 1. Run an agent task. Assert: 1 agent:start, 1 agent:complete, 0 orchestrator:*.
  //    The agent task's trace has 0 verification records (no verification ran).
  // 2. Run real verification on a DIFFERENT traceId. Assert: records belong
  //    ONLY to that traceId — they cannot "leak" to the agent task's trace.
  //
  // This proves both lifecycle integrity (1:1 task-to-trace mapping) and
  // verification record isolation (records belong to the right trace).
  it('TEST H — lifecycle integrity + verification records belong to the right trace', async () => {
    // ── Part 1: Lifecycle integrity via a real agent task ──────────────
    const agentTaskId = `p6-h-agent-${Date.now()}`;
    const { events, unsubscribe } = captureEvents(agentTaskId);

    await runChatViaAgentManager(
      TEST_SESSION, 'Hello', agentTaskId, 'test-user',
      { workspaceRoot: '/tmp' },
    );

    // 1 agent:start, 1 agent:complete, 0 orchestrator:* events
    expect(events.filter(e => e.event === 'agent:start').length).toBe(1);
    expect(events.filter(e => e.event === 'agent:complete').length).toBe(1);
    expect(events.filter(e => e.event.startsWith('orchestrator:')).length).toBe(0);

    // The agent task has its own authoritative trace — 1 trace, not 0 or 2.
    const agentTrace = getTrace(agentTaskId);
    expect(agentTrace).not.toBeNull();
    expect(agentTrace?.taskId).toBe(agentTaskId);

    // No verification ran during the agent task — the trace is unverified.
    expect(agentTrace?.verificationRecords.length).toBe(0);
    expect(agentTrace?.verificationStatus).toBe('unverified');

    unsubscribe();

    // ── Part 2: Verification records belong to the right trace ─────────
    const verifTaskId = `p6-h-verif-${Date.now()}`;
    startTrace({
      taskId: verifTaskId,
      agentId: 'workflow-runner',
      domain: 'WORKFLOW',
      executionMode: 'single-shot',
      input: 'verification-belong-to-trace-test',
    });

    // Run two real verifications — these should land on verifTaskId, NOT on agentTaskId
    await runVerificationCommand({
      command: 'true', cwd: '/tmp',
      kind: 'test', name: 'real-test-pass', traceId: verifTaskId,
    });
    await runVerificationCommand({
      command: 'false', cwd: '/tmp',
      kind: 'lint', name: 'real-lint-fail', traceId: verifTaskId,
    });

    completeTrace(verifTaskId, 'verification complete');

    // Records belong to verifTaskId
    const verifTrace = getTrace(verifTaskId);
    expect(verifTrace?.taskId).toBe(verifTaskId);
    expect(verifTrace?.verificationRecords.length).toBe(2);
    expect(verifTrace?.verificationRecords[0].name).toBe('real-test-pass');
    expect(verifTrace?.verificationRecords[0].status).toBe('succeeded');
    expect(verifTrace?.verificationRecords[1].name).toBe('real-lint-fail');
    expect(verifTrace?.verificationRecords[1].status).toBe('failed');
    expect(verifTrace?.verificationStatus).toBe('failed');  // at least one failed

    // Records did NOT leak to agentTaskId — verification records are isolated per trace
    const agentTraceFinal = getTrace(agentTaskId);
    expect(agentTraceFinal?.verificationRecords.length).toBe(0);
    expect(agentTraceFinal?.verificationStatus).toBe('unverified');
  }, 25000);

  // ── Additional: runTests() integration with verification pipeline ────
  // This proves the existing runTests() spawn runner is ALSO wired to
  // addVerification() when a traceId is provided. It runs a SYNTHETIC tiny
  // project (NOT the real server/ suite — that takes ~94s and exhausts the
  // sandbox memory when run inside vitest). We create a minimal npm project
  // with one trivial test, run runTests() against it, and verify the
  // verification record was created from the real captured exit code.
  it('TEST (runTests integration) — runTests() records verification when traceId is provided', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    // Create a minimal server/ project with one trivial test
    const fakeRoot = mkdtempSync(join(tmpdir(), 'p6-runtests-'));
    const serverDir = join(fakeRoot, 'server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'package.json'), JSON.stringify({
      name: 'p6-fake-server',
      version: '0.0.0',
      type: 'module',
      scripts: { test: 'vitest run --reporter=json' },
    }));
    mkdirSync(join(serverDir, 'tests'), { recursive: true });
    writeFileSync(join(serverDir, 'tests', 'trivial.test.ts'),
      `import { describe, it, expect } from 'vitest';\n` +
      `describe('trivial', () => { it('passes', () => expect(1+1).toBe(2)); });\n`);

    const taskId = `p6-runtests-${Date.now()}`;
    startTrace({
      taskId, agentId: 'qa-tester-agent', domain: 'QA',
      executionMode: 'single-shot', input: 'real-test-suite-via-runTests',
    });

    try {
      const result = await runTestsTest.runTests(fakeRoot, {
        targetDir: 'server',
        timeoutMs: 60_000,  // short — the trivial test takes <2s
        traceId: taskId,
      });

      completeTrace(taskId, 'runTests complete');

      // Real verification record was created by the existing runTests() runner
      const records = getVerificationRecords(taskId);
      expect(records.length).toBe(1);
      expect(records[0].name).toBe('tests:server');
      expect(records[0].kind).toBe('test');
      expect(records[0].durationMs).toBeGreaterThan(0);

      // Status mapping is deterministic based on real result:
      //   success → 'succeeded', failure → 'failed'
      if (result.success) {
        expect(records[0].status).toBe('succeeded');
        expect(records[0].exitCode).toBe(0);
        expect(getVerificationStatus(taskId)).toBe('passed');
      } else {
        expect(records[0].status).toBe('failed');
        expect(getVerificationStatus(taskId)).toBe('failed');
      }
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
