import { describe, expect, it } from 'vitest';
import {
  AVATAR_MOTION_EXPRESSION_TARGETS,
  AVATAR_MOTION_TIMING,
  createAvatarMotionSnapshot,
  getAvatarMotionPose,
  reduceAvatarMotion,
} from '../src/lib/avatar-motion';

describe('Avatar motion state machine', () => {
  it('moves from entry to idle after the defined entrance duration', () => {
    const entering = createAvatarMotionSnapshot(0);
    const idle = reduceAvatarMotion(entering, { type: 'tick', nowMs: AVATAR_MOTION_TIMING.enterMs });
    expect(idle.state).toBe('idle');
  });

  it('follows the idle, bored, rest, tap, wake, idle sequence', () => {
    const idle = reduceAvatarMotion(createAvatarMotionSnapshot(0), { type: 'tick', nowMs: AVATAR_MOTION_TIMING.enterMs });
    const bored = reduceAvatarMotion(idle, { type: 'tick', nowMs: AVATAR_MOTION_TIMING.enterMs + AVATAR_MOTION_TIMING.idleToBoredMs });
    const resting = reduceAvatarMotion(bored, { type: 'tick', nowMs: bored.stateStartedAtMs + AVATAR_MOTION_TIMING.boredToRestMs });
    const waking = reduceAvatarMotion(resting, { type: 'user-tap', nowMs: resting.stateStartedAtMs + 1 });
    const awake = reduceAvatarMotion(waking, { type: 'tick', nowMs: waking.stateStartedAtMs + AVATAR_MOTION_TIMING.wakeMs });

    expect(bored.state).toBe('bored');
    expect(resting.state).toBe('rest');
    expect(waking.state).toBe('wake');
    expect(awake.state).toBe('idle');
  });

  it('prioritizes voice activity and returns to idle when the session ends', () => {
    const initial = createAvatarMotionSnapshot(0);
    const listening = reduceAvatarMotion(initial, { type: 'voice-started', nowMs: 100 });
    const idle = reduceAvatarMotion(listening, { type: 'voice-ended', nowMs: 400 });

    expect(listening.state).toBe('listening');
    expect(idle.state).toBe('idle');
  });

  it('defines subtle expressions and poses for nonverbal states', () => {
    expect(AVATAR_MOTION_EXPRESSION_TARGETS.thinking.relaxed).toBeGreaterThan(0);
    expect(AVATAR_MOTION_EXPRESSION_TARGETS.celebrate.happy).toBeGreaterThan(0.5);
    expect(getAvatarMotionPose('rest', 1).verticalOffset).toBeLessThan(0);
  });
});

