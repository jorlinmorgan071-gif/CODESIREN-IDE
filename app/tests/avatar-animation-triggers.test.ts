// Tests for the animation trigger system.
//
// Verifies that each trigger:
//   - Installs the correct clip for the requested motion state.
//   - Uses the correct crossfade duration.
//   - Returns a TriggerResult with `changed=true`.
//   - Is idempotent where appropriate (e.g. avatar-switch greeting).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  triggerAvatarSwitch,
  triggerIdleEnter,
  triggerUserTap,
  triggerCelebrate,
  triggerRest,
  triggerVoiceStart,
  triggerVoiceEnd,
  CROSSFADE,
} from '../src/lib/avatar-animation-triggers';
import { createAutoCycleState } from '../src/lib/avatar-auto-cycle';
import { getAvatarPersonality } from '../src/lib/avatar-personality';
import type { LocalVrmaPlayer } from '../src/lib/vrma-player';
import type { AvatarMotionState } from '../src/lib/avatar-motion';
import type { BuiltInAnimationId } from '../src/lib/built-in-animations';

// ── Mock player ──────────────────────────────────────────────────────
class MockPlayer implements Pick<LocalVrmaPlayer,
  | 'installBuiltInClip'
  | 'swapBuiltInClip'
  | 'hasClip'
  | 'getBuiltInClipId'
  | 'setState'
  | 'setStateWithCrossfade'
  | 'update'
> {
  installs: Array<{ state: AvatarMotionState; clipId: string; crossfade: number; activate: boolean }> = [];
  swaps: Array<{ state: AvatarMotionState; clipId: string; crossfade: number }> = [];
  installed = new Map<AvatarMotionState, string>();

  installBuiltInClip(state: AvatarMotionState, _clip: THREE.AnimationClip, clipId: string, options?: { crossfadeSeconds?: number; activate?: boolean }): void {
    this.installed.set(state, clipId);
    this.installs.push({
      state,
      clipId,
      crossfade: options?.crossfadeSeconds ?? 0,
      activate: options?.activate ?? false,
    });
  }
  swapBuiltInClip(state: AvatarMotionState, _clip: THREE.AnimationClip, clipId: string, crossfadeSeconds: number): void {
    this.installed.set(state, clipId);
    this.swaps.push({ state, clipId, crossfade: crossfadeSeconds });
  }
  hasClip(state: AvatarMotionState): boolean {
    return this.installed.has(state);
  }
  getBuiltInClipId(state: AvatarMotionState): string | null {
    return this.installed.get(state) ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setState(_state: AvatarMotionState): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setStateWithCrossfade(_state: AvatarMotionState, _crossfade: number): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_deltaSeconds: number): void { /* noop */ }
}

describe('animation triggers', () => {
  describe('CROSSFADE constants', () => {
    it('uses longer durations than the legacy 0.22s default', () => {
      // The whole point of the new trigger system is to make motion
      // fluid. The previous 0.22s default was too short and made
      // every transition feel snappy. All new constants should be
      // strictly greater than 0.22s.
      expect(CROSSFADE.state).toBeGreaterThan(0.22);
      expect(CROSSFADE.idleSwap).toBeGreaterThan(0.22);
      expect(CROSSFADE.greeting).toBeGreaterThan(0.22);
      expect(CROSSFADE.returnToIdle).toBeGreaterThan(0.22);
    });

    it('idle-swap is the longest crossfade (most invisible transition)', () => {
      expect(CROSSFADE.idleSwap).toBeGreaterThan(CROSSFADE.state);
      expect(CROSSFADE.idleSwap).toBeGreaterThan(CROSSFADE.greeting);
    });

    it('greeting is the shortest state-level crossfade (responsive)', () => {
      expect(CROSSFADE.greeting).toBeLessThan(CROSSFADE.state);
      expect(CROSSFADE.greeting).toBeLessThan(CROSSFADE.returnToIdle);
    });
  });

  describe('triggerAvatarSwitch', () => {
    it('fires the greeting on first call and activates the clip', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('default', 1000);
      const result = triggerAvatarSwitch(player as unknown as LocalVrmaPlayer, state);

      expect(result.changed).toBe(true);
      expect(result.motionState).toBe('gesture');
      expect(result.clipId).toBe(state.personality.preferredEnterAnimation);
      expect(result.crossfadeSeconds).toBe(CROSSFADE.greeting);
      // The install call must have activate=true (so the clip starts
      // playing immediately, not just pre-installed).
      const install = player.installs.find((i) => i.state === 'gesture');
      expect(install?.activate).toBe(true);
    });

    it('is idempotent — second call without force does nothing', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('default', 1000);
      const first = triggerAvatarSwitch(player as unknown as LocalVrmaPlayer, state);
      const second = triggerAvatarSwitch(player as unknown as LocalVrmaPlayer, state);

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
    });

    it('force=true fires the greeting again even if already greeted', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('default', 1000);
      triggerAvatarSwitch(player as unknown as LocalVrmaPlayer, state);
      const again = triggerAvatarSwitch(
        player as unknown as LocalVrmaPlayer,
        state,
        { force: true },
      );

      expect(again.changed).toBe(true);
      expect(again.clipId).toBe(state.personality.preferredEnterAnimation);
    });

    it('uses the personality\'s preferredEnterAnimation as the greeting clip', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('hatsune-miku', 1000);
      const result = triggerAvatarSwitch(player as unknown as LocalVrmaPlayer, state);
      const miku = getAvatarPersonality('hatsune-miku');
      expect(result.clipId).toBe(miku.preferredEnterAnimation);
    });
  });

  describe('triggerIdleEnter', () => {
    it('installs an idle clip with the returnToIdle crossfade', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('default', 1000);
      const result = triggerIdleEnter(player as unknown as LocalVrmaPlayer, state, 2000);

      expect(result.changed).toBe(true);
      expect(result.motionState).toBe('idle');
      expect(result.crossfadeSeconds).toBe(CROSSFADE.returnToIdle);
      // The clip must be from the personality's idle pool.
      const idlePool = state.personality.idlePool;
      expect(idlePool).toContain(result.clipId as BuiltInAnimationId);
    });

    it('reschedules the next idle swap to nowMs + exponential sample', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('default', 1000);
      triggerIdleEnter(player as unknown as LocalVrmaPlayer, state, 5000);
      // nextIdleSwapMs should be in the future, after the current time.
      expect(state.nextIdleSwapMs).toBeGreaterThan(5000);
    });
  });

  describe('triggerUserTap', () => {
    it('installs a gesture clip with the state crossfade', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('default', 1000);
      const result = triggerUserTap(player as unknown as LocalVrmaPlayer, state, 2000);

      expect(result.changed).toBe(true);
      expect(result.motionState).toBe('gesture');
      expect(result.crossfadeSeconds).toBe(CROSSFADE.state);
      const gesturePool = state.personality.gesturePool;
      expect(gesturePool).toContain(result.clipId as BuiltInAnimationId);
    });

    it('marks user activity so the look-around timer reschedules', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('default', 1000);
      const originalLookAround = state.nextLookAroundMs;
      triggerUserTap(player as unknown as LocalVrmaPlayer, state, 5000);
      expect(state.lastInteractionMs).toBe(5000);
      // The next look-around should be pushed past the activity timestamp.
      expect(state.nextLookAroundMs).toBeGreaterThan(5000);
      // (It should also be different from the original, since the
      // exponential sample is re-drawn.)
      expect(state.nextLookAroundMs).not.toBe(originalLookAround);
    });
  });

  describe('triggerCelebrate', () => {
    it('installs a celebrate clip from the personality pool', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('hatsune-miku', 1000);
      const result = triggerCelebrate(player as unknown as LocalVrmaPlayer, state, 2000);

      expect(result.changed).toBe(true);
      expect(result.motionState).toBe('celebrate');
      expect(result.crossfadeSeconds).toBe(CROSSFADE.state);
      const celebratePool = state.personality.celebratePool;
      expect(celebratePool).toContain(result.clipId as BuiltInAnimationId);
    });
  });

  describe('triggerRest', () => {
    it('installs a rest clip from the personality pool', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('marionette', 1000);
      const result = triggerRest(player as unknown as LocalVrmaPlayer, state);

      expect(result.changed).toBe(true);
      expect(result.motionState).toBe('rest');
      expect(result.crossfadeSeconds).toBe(CROSSFADE.state);
      const restPool = state.personality.restPool;
      expect(restPool).toContain(result.clipId as BuiltInAnimationId);
    });
  });

  describe('triggerVoiceStart / triggerVoiceEnd', () => {
    it('triggerVoiceStart installs an idle clip under the listening state', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('default', 1000);
      const result = triggerVoiceStart(player as unknown as LocalVrmaPlayer, state, 2000);

      expect(result.changed).toBe(true);
      expect(result.motionState).toBe('listening');
      expect(result.crossfadeSeconds).toBe(CROSSFADE.state);
    });

    it('triggerVoiceEnd returns the avatar to idle', () => {
      const player = new MockPlayer();
      const state = createAutoCycleState('default', 1000);
      const result = triggerVoiceEnd(player as unknown as LocalVrmaPlayer, state, 2000);

      expect(result.changed).toBe(true);
      expect(result.motionState).toBe('idle');
      expect(result.crossfadeSeconds).toBe(CROSSFADE.returnToIdle);
    });
  });

  describe('trigger crossfade durations are > 0.4s for fluid motion', () => {
    // The user explicitly asked for "fluid motion". A transition
    // shorter than 0.4s tends to look like a snap rather than a blend.
    it('state-to-state transitions are >= 0.4s', () => {
      expect(CROSSFADE.state).toBeGreaterThanOrEqual(0.4);
      expect(CROSSFADE.returnToIdle).toBeGreaterThanOrEqual(0.4);
    });

    it('idle swaps are >= 0.6s (very fluid)', () => {
      expect(CROSSFADE.idleSwap).toBeGreaterThanOrEqual(0.6);
    });
  });
});
