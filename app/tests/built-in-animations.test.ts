// Tests for the built-in procedural animation library, the personality
// profiles, the anime-expression pulses, and the auto-cycle scheduler.
//
// These are pure-TypeScript tests — they don't load any VRM model. They
// verify that:
//   - Every built-in animation produces a valid THREE.AnimationClip with
//     the expected number of tracks and a finite duration.
//   - Per-avatar personality profiles resolve to non-empty animation
//     pools for every built-in avatar.
//   - Anime expression envelopes ramp up and then back down to zero.
//   - The auto-cycle scheduler installs and swaps built-in clips
//     without throwing, given a mock player.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BUILT_IN_ANIMATIONS_BY_STATE,
  getBuiltInAnimation,
  listBuiltInAnimations,
  type BuiltInAnimationId,
} from '../src/lib/built-in-animations';
import {
  getAvatarPersonality,
  inferTemperamentFromCapabilities,
  listAvatarPersonalities,
  pickRandom,
  sampleExponentialSeconds,
} from '../src/lib/avatar-personality';
import {
  ANIME_EXPRESSIONS,
  ANIME_EXPRESSION_IDS,
  evalExpressionEnvelope,
  pickWeightedExpression,
  type ActiveAnimeExpression,
} from '../src/lib/anime-expressions';
import {
  createAutoCycleState,
  ensureBuiltInForState,
  finalisePersonalityWithCapabilities,
  tickAutoCycle,
  tryIssueGreeting,
  markUserActivity,
  resetForNewModel,
} from '../src/lib/avatar-auto-cycle';
import type { LocalVrmaPlayer } from '../src/lib/vrma-player';
import type { AvatarCompatibilityProfile, AvatarCapabilities } from '../src/lib/avatar-compatibility';
import type { AvatarMotionState } from '../src/lib/avatar-motion';

describe('built-in animation library', () => {
  const allIds = listBuiltInAnimations();

  it('exposes all 11 animations inspired by the user-supplied Mixamo library', () => {
    expect(allIds).toHaveLength(11);
    expect(allIds).toContain('standing-idle');
    expect(allIds).toContain('waving');
    expect(allIds).toContain('macarena-dance');
    expect(allIds).toContain('northern-soul-spin-combo');
  });

  it('every animation produces a non-empty THREE.AnimationClip with finite duration', () => {
    for (const id of allIds) {
      const anim = getBuiltInAnimation(id as BuiltInAnimationId);
      expect(anim.clip.tracks.length).toBeGreaterThan(0);
      expect(anim.clip.duration).toBeGreaterThan(0);
      expect(Number.isFinite(anim.clip.duration)).toBe(true);
      expect(anim.durationSeconds).toBeGreaterThan(0);
      expect(anim.crossfadeSeconds).toBeGreaterThan(0);
    }
  });

  it('every track targets a VRM humanoid bone name with .quaternion or .position', () => {
    const validBoneNames = new Set([
      'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
      'leftShoulder', 'rightShoulder',
      'leftUpperArm', 'rightUpperArm',
      'leftLowerArm', 'rightLowerArm',
      'leftHand', 'rightHand',
      'leftUpperLeg', 'rightUpperLeg',
      'leftLowerLeg', 'rightLowerLeg',
      'leftFoot', 'rightFoot',
      'leftToes', 'rightToes',
    ]);
    for (const id of allIds) {
      const anim = getBuiltInAnimation(id as BuiltInAnimationId);
      for (const track of anim.clip.tracks) {
        const dotIndex = track.name.lastIndexOf('.');
        expect(dotIndex).toBeGreaterThan(0);
        const bone = track.name.substring(0, dotIndex);
        const property = track.name.substring(dotIndex + 1);
        expect(validBoneNames.has(bone)).toBe(true);
        expect(['quaternion', 'position']).toContain(property);
      }
    }
  });

  it('caches clip instances — repeated lookups return the same object', () => {
    const a = getBuiltInAnimation('standing-idle');
    const b = getBuiltInAnimation('standing-idle');
    expect(a).toBe(b);
  });

  it('maps every motion state to at least one animation id', () => {
    for (const state of ['idle', 'gesture', 'celebrate', 'rest', 'wake', 'bored', 'listening', 'thinking', 'speaking', 'enter']) {
      const ids = BUILT_IN_ANIMATIONS_BY_STATE[state];
      expect(ids).toBeDefined();
      expect(ids!.length).toBeGreaterThan(0);
    }
  });
});

describe('avatar personality profiles', () => {
  it('ships profiles for every built-in avatar', () => {
    const profiles = listAvatarPersonalities();
    const ids = profiles.map((p) => p.avatarId);
    expect(ids).toEqual(expect.arrayContaining(['default', 'hatsune-miku', 'yinlin', 'marionette']));
    expect(profiles.length).toBeGreaterThanOrEqual(4);
  });

  it('each personality has a non-empty idle pool', () => {
    for (const p of listAvatarPersonalities()) {
      expect(p.idlePool.length).toBeGreaterThan(0);
      expect(p.gesturePool.length).toBeGreaterThan(0);
      expect(p.celebratePool.length).toBeGreaterThan(0);
      expect(p.restPool.length).toBeGreaterThan(0);
    }
  });

  it('hatsune-miku is bubbly — faster blink rate and shorter idle swaps than the default avatar', () => {
    const miku = getAvatarPersonality('hatsune-miku');
    const def = getAvatarPersonality('default');
    expect(miku.temperament).toBe('bubbly');
    expect(miku.blinkRateScale).toBeGreaterThan(def.blinkRateScale);
    expect(miku.idleSwapMeanSeconds).toBeLessThan(def.idleSwapMeanSeconds);
    expect(miku.greetOnLoadProbability).toBeGreaterThan(def.greetOnLoadProbability);
  });

  it('marionette is graceful — slower blink rate than default', () => {
    const mar = getAvatarPersonality('marionette');
    const def = getAvatarPersonality('default');
    expect(mar.temperament).toBe('graceful');
    expect(mar.blinkRateScale).toBeLessThan(def.blinkRateScale);
  });

  it('falls back to the default personality for unknown avatar ids', () => {
    const unknown = getAvatarPersonality('some-random-id');
    expect(unknown.avatarId).toBe('some-random-id');
    expect(unknown.temperament).toBe('balanced');
    expect(unknown.source).toBe('inferred');
    expect(getAvatarPersonality(null).avatarId).toBe('default');
  });

  it('pickRandom avoids returning the exclude value when possible', () => {
    const pool = [1, 2, 3, 4] as const;
    for (let i = 0; i < 50; i++) {
      expect(pickRandom(pool, 2)).not.toBe(2);
    }
  });

  it('sampleExponentialSeconds returns a positive finite number', () => {
    for (let i = 0; i < 50; i++) {
      const v = sampleExponentialSeconds(5);
      expect(v).toBeGreaterThan(0);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('infers a bubbly temperament for a fully-featured avatar (look-at + many expressions + spring bones)', () => {
    const caps: AvatarCapabilities = {
      vrmVersion: '1.0',
      hasHumanoid: true,
      expressionManagerAvailable: true,
      expressionNames: ['happy', 'sad', 'angry', 'blink', 'surprised', 'relaxed', 'aa', 'ee', 'ih', 'oh', 'ou', 'neutral', 'lookLeft', 'lookRight'],
      hasLookAt: true,
      hasSpringBones: true,
      springBoneCount: 8,
      colliderCount: 2,
      vrmaCompatible: true,
      lipSyncCompatible: true,
      warnings: [],
    };
    expect(inferTemperamentFromCapabilities(caps)).toBe('bubbly');
  });

  it('infers a stoic temperament for an avatar with no humanoid rig', () => {
    const caps: AvatarCapabilities = {
      vrmVersion: '0.x',
      hasHumanoid: false,
      expressionManagerAvailable: true,
      expressionNames: ['happy', 'sad'],
      hasLookAt: false,
      hasSpringBones: false,
      springBoneCount: 0,
      colliderCount: 0,
      vrmaCompatible: false,
      lipSyncCompatible: false,
      warnings: [],
    };
    expect(inferTemperamentFromCapabilities(caps)).toBe('stoic');
  });

  it('infers a balanced temperament for an avatar with look-at and medium expressions', () => {
    const caps: AvatarCapabilities = {
      vrmVersion: '1.0',
      hasHumanoid: true,
      expressionManagerAvailable: true,
      expressionNames: ['happy', 'sad', 'angry', 'blink', 'aa', 'ee', 'ih'],
      hasLookAt: true,
      hasSpringBones: false,
      springBoneCount: 0,
      colliderCount: 0,
      vrmaCompatible: true,
      lipSyncCompatible: true,
      warnings: [],
    };
    expect(inferTemperamentFromCapabilities(caps)).toBe('balanced');
  });

  it('infers a graceful temperament for an avatar with expressions but no look-at', () => {
    const caps: AvatarCapabilities = {
      vrmVersion: '1.0',
      hasHumanoid: true,
      expressionManagerAvailable: true,
      expressionNames: ['happy', 'sad', 'angry', 'blink', 'aa', 'ee', 'ih', 'oh'],
      hasLookAt: false,
      hasSpringBones: false,
      springBoneCount: 0,
      colliderCount: 0,
      vrmaCompatible: true,
      lipSyncCompatible: true,
      warnings: [],
    };
    expect(inferTemperamentFromCapabilities(caps)).toBe('graceful');
  });

  it('returns a custom-avatar personality with source="inferred" when capabilities are provided', () => {
    const caps: AvatarCapabilities = {
      vrmVersion: '1.0',
      hasHumanoid: true,
      expressionManagerAvailable: true,
      expressionNames: ['happy', 'sad', 'angry', 'blink', 'surprised', 'relaxed', 'aa', 'ee', 'ih', 'oh', 'ou', 'neutral'],
      hasLookAt: true,
      hasSpringBones: true,
      springBoneCount: 4,
      colliderCount: 1,
      vrmaCompatible: true,
      lipSyncCompatible: true,
      warnings: [],
    };
    const p = getAvatarPersonality('custom-1234-abc', { capabilities: caps });
    expect(p.avatarId).toBe('custom-1234-abc');
    expect(p.source).toBe('inferred');
    expect(p.temperament).toBe('bubbly');
  });

  it('returns a balanced personality for a custom avatar before capabilities are detected', () => {
    const p = getAvatarPersonality('custom-1234-abc');
    expect(p.avatarId).toBe('custom-1234-abc');
    expect(p.source).toBe('inferred');
    expect(p.temperament).toBe('balanced');
  });
});

describe('anime expression library', () => {
  it('exports at least 6 distinct expression pulses', () => {
    expect(ANIME_EXPRESSION_IDS.length).toBeGreaterThanOrEqual(6);
  });

  it('every expression has a positive duration and weight', () => {
    for (const id of ANIME_EXPRESSION_IDS) {
      const pulse = ANIME_EXPRESSIONS[id];
      expect(pulse.durationSeconds).toBeGreaterThan(0);
      expect(pulse.weight).toBeGreaterThan(0);
      expect(Object.keys(pulse.blendTargets).length).toBeGreaterThan(0);
    }
  });

  it('pickWeightedExpression always returns a valid id', () => {
    for (let i = 0; i < 50; i++) {
      const id = pickWeightedExpression(new Set());
      expect(ANIME_EXPRESSION_IDS).toContain(id);
    }
  });

  it('envelope ramps up from 0, peaks near 0.5, and returns to 0', () => {
    const active: ActiveAnimeExpression = {
      id: 'soft-smile',
      startedAtMs: 0,
      durationSeconds: 2,
    };
    const startSample = evalExpressionEnvelope(active, 0);
    expect(startSample.envelope).toBe(0);
    expect(startSample.finished).toBe(false);

    const midSample = evalExpressionEnvelope(active, 1000);
    expect(midSample.envelope).toBeGreaterThan(0.9);
    expect(midSample.finished).toBe(false);

    const endSample = evalExpressionEnvelope(active, 2000);
    expect(endSample.envelope).toBe(0);
    expect(endSample.finished).toBe(true);
  });
});

// ── Mock player ─────────────────────────────────────────────────────
//
// We don't need a real THREE.AnimationMixer for these tests — we only
// need to verify that the scheduler calls the right methods on the
// player at the right times.

class MockPlayer implements Pick<LocalVrmaPlayer,
  | 'installBuiltInClip'
  | 'swapBuiltInClip'
  | 'hasClip'
  | 'getBuiltInClipId'
  | 'setState'
  | 'setStateWithCrossfade'
  | 'update'
> {
  installed = new Map<string, string>();
  swaps: Array<{ state: string; clipId: string; crossfade: number }> = [];
  installs: Array<{ state: string; clipId: string; activate: boolean }> = [];

  installBuiltInClip(state: AvatarMotionState, _clip: THREE.AnimationClip, clipId: string, options?: { crossfadeSeconds?: number; activate?: boolean }): void {
    this.installed.set(state, clipId);
    this.installs.push({ state, clipId, activate: options?.activate ?? false });
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

const stubProfile = {
  animation: { vrmaCompatibility: 'supported' as const, humanoidCompatibility: 'optional' as const, retargeting: 'standard-vrm-humanoid' as const, supportedStates: [] as AvatarMotionState[], corrections: [] as string[] },
} as unknown as AvatarCompatibilityProfile;

const stubCapabilities = {
  vrmVersion: '0.x' as const,
  hasHumanoid: true,
  expressionManagerAvailable: true,
  expressionNames: ['happy', 'sad', 'angry', 'blink', 'surprised', 'relaxed', 'aa', 'ee', 'ih', 'oh', 'ou', 'neutral', 'lookLeft', 'lookRight'],
  hasLookAt: true,
  hasSpringBones: true,
  springBoneCount: 8,
  colliderCount: 2,
  vrmaCompatible: true,
  lipSyncCompatible: true,
  warnings: [],
} satisfies AvatarCapabilities;

describe('auto-cycle scheduler', () => {
  it('initialises with a personality matching the avatar id', () => {
    const state = createAutoCycleState('hatsune-miku', 0);
    expect(state.personality.avatarId).toBe('hatsune-miku');
    expect(state.personality.temperament).toBe('bubbly');
  });

  it('ensureBuiltInForState installs a clip only once', () => {
    const player = new MockPlayer();
    const state = createAutoCycleState('default', 0);
    ensureBuiltInForState(state, player as unknown as LocalVrmaPlayer, 'idle');
    ensureBuiltInForState(state, player as unknown as LocalVrmaPlayer, 'idle');
    expect(player.installs.filter((i) => i.state === 'idle')).toHaveLength(1);
  });

  it('tryIssueGreeting fires at most once', () => {
    const player = new MockPlayer();
    const state = createAutoCycleState('default', 0);
    const results = new Set<boolean>();
    for (let i = 0; i < 50; i++) {
      results.add(tryIssueGreeting(state, player as unknown as LocalVrmaPlayer));
    }
    // After the first call, greeted is set to true and subsequent calls return false.
    expect(Array.from(results)).toEqual(expect.arrayContaining([false]));
  });

  it('resetForNewModel preserves lastExpressionId across model swaps', () => {
    const state = createAutoCycleState('default', 0);
    state.lastExpressionId = 'soft-smile';
    const next = resetForNewModel(state, 'hatsune-miku', 1000);
    expect(next.personality.avatarId).toBe('hatsune-miku');
    expect(next.lastExpressionId).toBe('soft-smile');
    expect(next.greeted).toBe(false);
  });

  it('markUserActivity pushes the next look-around later than the current time and updates lastInteractionMs', () => {
    const state = createAutoCycleState('default', 0);
    markUserActivity(state, 5000);
    // nextLookAroundMs is nowMs + random exponential sample, so it must
    // always be strictly greater than the activity timestamp.
    expect(state.nextLookAroundMs).toBeGreaterThan(5000);
    expect(state.lastInteractionMs).toBe(5000);
  });

  it('tickAutoCycle fires an expression when due and returns a non-empty blend', () => {
    const player = new MockPlayer();
    const state = createAutoCycleState('default', 0);
    // Pre-install an idle clip so tick has something to work with.
    ensureBuiltInForState(state, player as unknown as LocalVrmaPlayer, 'idle');
    // Jump the scheduler forward past the next expression time.
    state.nextExpressionMs = 10;
    const result = tickAutoCycle({
      player: player as unknown as LocalVrmaPlayer,
      state,
      currentMotionState: 'idle',
      acceptBuiltInForState: true,
      profile: stubProfile,
      capabilities: stubCapabilities,
      nowMs: 100,
      deltaSeconds: 0.016,
    });
    expect(result.expressionSample).not.toBeNull();
    expect(Object.keys(result.expressionSample!.blend).length).toBeGreaterThan(0);
  });

  it('tickAutoCycle does not fire an expression during speaking', () => {
    const player = new MockPlayer();
    const state = createAutoCycleState('default', 0);
    ensureBuiltInForState(state, player as unknown as LocalVrmaPlayer, 'idle');
    state.nextExpressionMs = 10;
    const result = tickAutoCycle({
      player: player as unknown as LocalVrmaPlayer,
      state,
      currentMotionState: 'speaking',
      acceptBuiltInForState: false,
      profile: stubProfile,
      capabilities: stubCapabilities,
      nowMs: 100,
      deltaSeconds: 0.016,
    });
    expect(result.expressionSample).toBeNull();
  });

  it('finalisePersonalityWithCapabilities re-resolves personality for custom avatars based on traits', () => {
    const state = createAutoCycleState('custom-1234-abc', 0);
    // Before finalisation, custom avatars default to balanced.
    expect(state.personality.temperament).toBe('balanced');
    expect(state.personalityFinalised).toBe(false);

    // Fully-featured caps → bubbly
    finalisePersonalityWithCapabilities(state, 'custom-1234-abc', stubCapabilities);
    expect(state.personality.temperament).toBe('bubbly');
    expect(state.personalityFinalised).toBe(true);

    // Calling again with different caps doesn't override — finalised is final.
    const capsAfter = { ...stubCapabilities, expressionNames: ['happy'], hasLookAt: false, hasSpringBones: false, springBoneCount: 0 };
    finalisePersonalityWithCapabilities(state, 'custom-1234-abc', capsAfter);
    expect(state.personality.temperament).toBe('bubbly');
  });

  it('finalisePersonalityWithCapabilities skips built-in avatars', () => {
    const state = createAutoCycleState('hatsune-miku', 0);
    expect(state.personality.temperament).toBe('bubbly');
    // Pass caps that would have inferred "stoic" if applied.
    const stoicCaps: AvatarCapabilities = {
      ...stubCapabilities,
      hasHumanoid: false,
      expressionNames: ['happy'],
      hasLookAt: false,
      hasSpringBones: false,
      springBoneCount: 0,
    };
    finalisePersonalityWithCapabilities(state, 'hatsune-miku', stoicCaps);
    // Built-in personality is preserved.
    expect(state.personality.temperament).toBe('bubbly');
    expect(state.personalityFinalised).toBe(true);
  });
});
