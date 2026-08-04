// tests/unit/findings-ledger.test.ts
// Phase A Section 7: Project Brain — Finding Ledger tests.
//
// Proves (with real file I/O, not mocks):
//   1. Recurrence tracking: same finding across multiple cycles → detectionCount
//      increments + lastSeenAt updates.
//   2. Resolution detection: stop producing a finding → next cycle marks it
//      'resolved' with resolvedAt timestamp.
//   3. Restart persistence: reload from JSONL file → state survives (the core
//      value proposition — findings aren't lost on process restart).
//   4. Query surface: getOpenFindings, getStaleFindings, getRecurringFindings
//      all return correct results.
//   5. Reopen: a resolved finding that reappears gets reopened (status='open').

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __test__ as ledger } from '../../src/orchestration/findings-ledger.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase A Section 7 — Finding Ledger', () => {
  // Clean up before + after each test — the ledger persists to a real file
  beforeEach(() => {
    ledger.clear();
  });

  afterEach(() => {
    ledger.clear();
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 1: Recurrence tracking — same finding across cycles increments count
  // ════════════════════════════════════════════════════════════════════
  it('recurrence tracking: same finding across 3 cycles → detectionCount=3, lastSeenAt updates', () => {
    const finding = {
      type: 'performance:execSync-in-route-handler',
      severity: 'medium' as const,
      filePath: 'src/routes/orchestrator.ts',
      line: 162,
      description: 'execSync blocks the event loop',
    };

    // Cycle 1
    ledger.startCycle();
    ledger.recordFinding(finding);
    ledger.markMissingAsResolved();

    let entries = ledger.getAllFindings();
    expect(entries).toHaveLength(1);
    expect(entries[0].detectionCount).toBe(1);
    expect(entries[0].status).toBe('open');
    const firstSeen = entries[0].firstSeenAt;
    const firstLastSeen = entries[0].lastSeenAt;

    // Cycle 2 (same finding)
    ledger.startCycle();
    ledger.recordFinding(finding);
    ledger.markMissingAsResolved();

    entries = ledger.getAllFindings();
    expect(entries).toHaveLength(1); // still 1 entry (deduped by key)
    expect(entries[0].detectionCount).toBe(2);
    expect(entries[0].lastSeenAt).toBeGreaterThanOrEqual(firstLastSeen);

    // Cycle 3 (same finding)
    ledger.startCycle();
    ledger.recordFinding(finding);
    ledger.markMissingAsResolved();

    entries = ledger.getAllFindings();
    expect(entries).toHaveLength(1);
    expect(entries[0].detectionCount).toBe(3);
    expect(entries[0].firstSeenAt).toBe(firstSeen); // unchanged
    expect(entries[0].status).toBe('open');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 2: Resolution detection — remove finding → next cycle marks resolved
  // ════════════════════════════════════════════════════════════════════
  it('resolution detection: stop producing finding → next cycle marks it resolved', () => {
    const finding = {
      type: 'security:secret',
      severity: 'high' as const,
      filePath: 'src/config.ts',
      line: 5,
      description: 'Hardcoded API key detected',
    };

    // Cycle 1: finding detected
    ledger.startCycle();
    ledger.recordFinding(finding);
    ledger.markMissingAsResolved();

    let entries = ledger.getAllFindings();
    expect(entries[0].status).toBe('open');

    // Cycle 2: finding NOT detected (scanner doesn't find it anymore)
    // startCycle + markMissingAsResolved WITHOUT recordFinding
    ledger.startCycle();
    ledger.markMissingAsResolved();

    entries = ledger.getAllFindings();
    expect(entries[0].status).toBe('resolved');
    expect(entries[0].resolvedAt).toBeDefined();
    expect(entries[0].resolvedAt!).toBeGreaterThanOrEqual(entries[0].firstSeenAt);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 3: Restart persistence — reload from JSONL file → state survives
  // ════════════════════════════════════════════════════════════════════
  it('restart persistence: reload from JSONL file → entries survive', () => {
    const finding1 = {
      type: 'performance:unbounded-select',
      severity: 'medium' as const,
      filePath: 'src/db/queries.ts',
      line: 42,
      description: 'SELECT without LIMIT',
    };
    const finding2 = {
      type: 'security:secret',
      severity: 'high' as const,
      filePath: 'src/auth.ts',
      line: 10,
      description: 'Hardcoded password',
    };

    // Record findings across multiple cycles — BOTH findings must be
    // recorded in EVERY cycle to stay open (markMissingAsResolved resolves
    // anything not seen in the cycle).
    ledger.startCycle();
    ledger.recordFinding(finding1);
    ledger.recordFinding(finding2);
    ledger.markMissingAsResolved();

    // Cycle 2: finding1 detected again (count=2), finding2 also (count=2)
    ledger.startCycle();
    ledger.recordFinding(finding1);
    ledger.recordFinding(finding2);
    ledger.markMissingAsResolved();

    const beforeReload = ledger.getAllFindings();
    expect(beforeReload).toHaveLength(2);
    const f1Before = beforeReload.find((e) => e.type === 'performance:unbounded-select')!;
    expect(f1Before.detectionCount).toBe(2);

    // Verify the file exists on disk
    expect(existsSync(ledger.LEDGER_FILE)).toBe(true);

    // Simulate process restart: clear in-memory state + reload from disk.
    // DO NOT call markMissingAsResolved after reload — the first scan cycle
    // hasn't run yet. The ledger should preserve the last-known state.
    ledger.reloadFromDisk();

    // State should survive
    const afterReload = ledger.getAllFindings();
    expect(afterReload).toHaveLength(2);

    const f1After = afterReload.find((e) => e.type === 'performance:unbounded-select')!;
    expect(f1After.detectionCount).toBe(2); // count survived
    expect(f1After.status).toBe('open'); // status survived
    expect(f1After.firstSeenAt).toBe(f1Before.firstSeenAt); // timestamps survived
    expect(f1After.lastSeenAt).toBe(f1Before.lastSeenAt);

    const f2After = afterReload.find((e) => e.type === 'security:secret')!;
    expect(f2After.detectionCount).toBe(2); // count survived (both cycles)
    expect(f2After.status).toBe('open');

    // Now simulate the first scan cycle after restart: finding1 is detected
    // again (it's still in the codebase), finding2 is NOT (it was fixed).
    // After markMissingAsResolved, finding2 should be marked resolved.
    ledger.startCycle();
    ledger.recordFinding(finding1);
    ledger.markMissingAsResolved();

    const afterFirstCycle = ledger.getAllFindings();
    const f1AfterCycle = afterFirstCycle.find((e) => e.type === 'performance:unbounded-select')!;
    expect(f1AfterCycle.detectionCount).toBe(3); // was 2, now 3
    expect(f1AfterCycle.status).toBe('open');

    const f2AfterCycle = afterFirstCycle.find((e) => e.type === 'security:secret')!;
    expect(f2AfterCycle.status).toBe('resolved'); // not detected → resolved
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 4: Query surface — getOpenFindings, getStaleFindings, getRecurringFindings
  // ════════════════════════════════════════════════════════════════════
  it('query surface: getOpenFindings, getStaleFindings, getRecurringFindings', () => {
    const finding1 = {
      type: 'performance:execSync',
      severity: 'medium' as const,
      filePath: 'src/routes/a.ts',
      line: 1,
      description: 'execSync in route',
    };
    const finding2 = {
      type: 'security:secret',
      severity: 'high' as const,
      filePath: 'src/auth.ts',
      line: 5,
      description: 'Hardcoded token',
    };

    // Record finding1 5 times (recurring) + finding2 1 time
    // Both findings must be recorded in EVERY cycle to stay open —
    // markMissingAsResolved resolves anything not seen in the cycle.
    for (let i = 0; i < 5; i++) {
      ledger.startCycle();
      ledger.recordFinding(finding1);
      ledger.recordFinding(finding2); // record in every cycle to keep it open
      ledger.markMissingAsResolved();
    }

    // getOpenFindings — both should be open
    const open = ledger.getOpenFindings();
    expect(open).toHaveLength(2);

    // getRecurringFindings(3) — only finding1 (count=5, finding2 count=5 too actually)
    // Wait — both have count=5 since both were recorded every cycle. Let's use count=5
    // to get both, and count=6 to get neither.
    const recurring5 = ledger.getRecurringFindings(5);
    expect(recurring5).toHaveLength(2); // both have count=5

    const recurring6 = ledger.getRecurringFindings(6);
    expect(recurring6).toHaveLength(0); // neither has count=6

    // getStaleFindings — nothing is stale (just created, firstSeenAt is now)
    // Use a threshold of 999 days (nothing should be that old)
    const stale = ledger.getStaleFindings(999);
    expect(stale).toHaveLength(0);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 5: Reopen — resolved finding that reappears gets reopened
  // ════════════════════════════════════════════════════════════════════
  it('reopen: resolved finding reappears → status reverts to open', () => {
    const finding = {
      type: 'security:secret',
      severity: 'high' as const,
      filePath: 'src/config.ts',
      line: 3,
      description: 'AWS key detected',
    };

    // Cycle 1: detect
    ledger.startCycle();
    ledger.recordFinding(finding);
    ledger.markMissingAsResolved();
    expect(ledger.getAllFindings()[0].status).toBe('open');

    // Cycle 2: don't detect → resolved
    ledger.startCycle();
    ledger.markMissingAsResolved();
    expect(ledger.getAllFindings()[0].status).toBe('resolved');

    // Cycle 3: detect again → reopen
    ledger.startCycle();
    ledger.recordFinding(finding);
    ledger.markMissingAsResolved();

    const entry = ledger.getAllFindings()[0];
    expect(entry.status).toBe('open');
    expect(entry.detectionCount).toBe(2); // was 1, now 2 (re-detected)
    expect(entry.resolvedAt).toBeUndefined(); // cleared on reopen
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 6: buildKey matches Ghost Mode's dedup key formula
  // ════════════════════════════════════════════════════════════════════
  it('buildKey: matches Ghost Mode type::filePath::line::description formula', () => {
    const key = ledger.buildKey({
      type: 'security:secret',
      filePath: 'src/config.ts',
      line: 10,
      description: 'Hardcoded key',
    });
    expect(key).toBe('security:secret::src/config.ts::10::Hardcoded key');

    // Missing filePath/line → empty strings in the key
    const key2 = ledger.buildKey({
      type: 'dependency-vulnerability',
      description: 'lodash vuln',
    });
    // Key format: type::filePath::line::description
    // With missing filePath + line: 3 separators (::) + 2 empty values = 6 colons
    expect(key2).toBe('dependency-vulnerability::::::lodash vuln');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 7: Multiple findings in one cycle — all tracked independently
  // ════════════════════════════════════════════════════════════════════
  it('multiple findings in one cycle: all tracked independently', () => {
    const findings = [
      { type: 'security:secret', severity: 'high' as const, filePath: 'a.ts', line: 1, description: 'secret 1' },
      { type: 'security:secret', severity: 'medium' as const, filePath: 'b.ts', line: 2, description: 'secret 2' },
      { type: 'performance:execSync', severity: 'medium' as const, filePath: 'c.ts', line: 3, description: 'execSync' },
    ];

    ledger.startCycle();
    for (const f of findings) {
      ledger.recordFinding(f);
    }
    ledger.markMissingAsResolved();

    const entries = ledger.getAllFindings();
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.status === 'open')).toBe(true);
    expect(entries.every((e) => e.detectionCount === 1)).toBe(true);

    // Next cycle: only finding 1 + 3 detected (finding 2 resolved)
    ledger.startCycle();
    ledger.recordFinding(findings[0]);
    ledger.recordFinding(findings[2]);
    ledger.markMissingAsResolved();

    const updated = ledger.getAllFindings();
    const f2 = updated.find((e) => e.description === 'secret 2')!;
    expect(f2.status).toBe('resolved');

    const f1 = updated.find((e) => e.description === 'secret 1')!;
    expect(f1.detectionCount).toBe(2);
    expect(f1.status).toBe('open');
  });
});
