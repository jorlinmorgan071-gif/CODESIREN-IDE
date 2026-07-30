// tests/unit/loop-guard.test.ts
// P1: LoopGuard — detects and prevents agent tool-call loops.

import { describe, it, expect } from 'vitest';
import { LoopGuard } from '../../src/orchestration/loop-guard.js';

describe('LoopGuard', () => {
  it('allows first call', () => {
    const guard = new LoopGuard();
    expect(guard.check('calc', '{"expr":"2+2"}')).toBeNull();
  });

  it('blocks identical second call', () => {
    const guard = new LoopGuard();
    guard.check('calc', '{"expr":"2+2"}');
    const result = guard.check('calc', '{"expr":"2+2"}');
    expect(result).not.toBeNull();
    expect(result).toContain('identical');
  });

  it('allows different calls', () => {
    const guard = new LoopGuard();
    expect(guard.check('calc', '{"expr":"2+2"}')).toBeNull();
    expect(guard.check('calc', '{"expr":"3+3"}')).toBeNull();
  });

  it('detects ping-pong pattern (A-B-A-B)', () => {
    const guard = new LoopGuard(100, 4, 100);
    guard.check('tool_a', '1');
    guard.check('tool_b', '2');
    guard.check('tool_a', '3');
    const result = guard.check('tool_b', '4');
    expect(result).not.toBeNull();
    expect(result).toContain('Ping-pong');
  });

  it('blocks when poll budget exceeded', () => {
    const guard = new LoopGuard(1000, 100, 3);
    guard.check('t1', 'a1');
    guard.check('t2', 'a2');
    guard.check('t3', 'a3');
    const result = guard.check('t4', 'a4');
    expect(result).not.toBeNull();
    expect(result).toContain('Poll budget');
  });

  it('reset() clears state', () => {
    const guard = new LoopGuard();
    guard.check('calc', '{"expr":"2+2"}');
    guard.reset();
    expect(guard.check('calc', '{"expr":"2+2"}')).toBeNull();
  });
});
