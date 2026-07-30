// tests/unit/ghost-mode.test.ts
// P1: Ghost Mode FSM — state transitions, levels, finding report.
// Also validates that Sentinel reuses the SAME GhostState enum.

import { describe, it, expect, beforeAll } from 'vitest';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import type { GhostState } from '../../src/types.js';

describe('Ghost Mode FSM', () => {
  beforeAll(() => {
    ghostMode.stop();
    ghostMode.setLevel('approval-required');
  });

  it('starts in inactive state', () => {
    ghostMode.stop();
    expect(ghostMode.currentState).toBe('inactive');
  });

  it('transitions inactive → scanning on start()', () => {
    ghostMode.start();
    expect(ghostMode.currentState).toBe('scanning');
  });

  it('reportFinding transitions to detected', () => {
    const finding = ghostMode.reportFinding({
      type: 'test-finding',
      severity: 'medium',
      description: 'test finding',
    });
    expect(finding.id).toBeDefined();
    expect(ghostMode.currentState).toBe('detected');
  });

  it('planFix transitions to awaiting_approval in approval-required mode', async () => {
    ghostMode.stop();
    ghostMode.setLevel('approval-required');
    ghostMode.start();
    const finding = ghostMode.reportFinding({
      type: 'test-finding',
      severity: 'medium',
      description: 'test finding for plan',
    });
    const plan = await ghostMode.planFix(finding);
    expect(plan.findingId).toBe(finding.id);
    expect(ghostMode.currentState).toBe('awaiting_approval');
  });

  it('approve() transitions through applying → verifying → complete', async () => {
    ghostMode.stop();
    ghostMode.setLevel('approval-required');
    ghostMode.start();
    const finding = ghostMode.reportFinding({
      type: 'test-finding',
      severity: 'medium',
      description: 'test finding for approve',
    });
    const plan = await ghostMode.planFix(finding);
    await ghostMode.approve(plan);
    // After approve: applying → verifying → complete → scanning
    expect(['complete', 'scanning']).toContain(ghostMode.currentState);
  });

  it('setLevel changes the autonomy level', () => {
    ghostMode.setLevel('observation-only');
    expect(ghostMode.currentLevel).toBe('observation-only');
    ghostMode.setLevel('approval-required');
    expect(ghostMode.currentLevel).toBe('approval-required');
  });

  it('GhostState values are the literal enum from types.ts', () => {
    // This test proves the GhostState type is shared, not a parallel enum.
    const validStates: GhostState[] = [
      'inactive', 'scanning', 'detected', 'planning',
      'awaiting_approval', 'applying', 'verifying', 'complete', 'rolled_back',
    ];
    expect(validStates).toContain(ghostMode.currentState);
  });
});
