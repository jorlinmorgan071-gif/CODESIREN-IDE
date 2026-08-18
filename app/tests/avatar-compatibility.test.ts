import { describe, expect, it } from 'vitest';
import type { VRM } from '@pixiv/three-vrm';
import {
  AvatarCompatibilityProfileRegistry,
  BUILT_IN_AVATAR_PROFILES,
  createAvatarCompatibilityDiagnostics,
  detectAvatarCapabilities,
  isAnimationStateCompatible,
  resolveAvatarCompatibility,
  resolveExpressionAliases,
  resolveSemanticExpressionValues,
  validateAvatarCompatibilityProfile,
  type AvatarCapabilities,
  type AvatarCompatibilityProfile,
  type AvatarProfileId,
} from '../src/lib/avatar-compatibility';

function profileFor(modelId: AvatarProfileId): AvatarCompatibilityProfile {
  const profile = BUILT_IN_AVATAR_PROFILES.find((candidate) => candidate.identity.modelId === modelId);
  if (!profile) throw new Error(`Missing built-in profile fixture for ${modelId}`);
  return structuredClone(profile);
}

function capabilities(overrides: Partial<AvatarCapabilities> = {}): AvatarCapabilities {
  return {
    vrmVersion: '0.x',
    hasHumanoid: true,
    expressionManagerAvailable: true,
    expressionNames: [],
    hasLookAt: true,
    hasSpringBones: true,
    springBoneCount: 1,
    colliderCount: 0,
    vrmaCompatible: true,
    lipSyncCompatible: true,
    warnings: [],
    ...overrides,
  };
}

describe('Avatar Compatibility Profile System', () => {
  it('registers, resolves, replaces, and safely falls back for unknown model identities', () => {
    const defaultProfile = profileFor('default');
    const mikuProfile = profileFor('hatsune-miku');
    const registry = new AvatarCompatibilityProfileRegistry([defaultProfile]);

    expect(resolveAvatarCompatibility('/models/avatars/hatsune-miku/model.vrm', registry)).toMatchObject({
      source: 'unknown-fallback',
      requestedModelId: 'hatsune-miku',
      profile: { identity: { modelId: 'default' } },
    });

    registry.register(mikuProfile);
    expect(resolveAvatarCompatibility('/models/avatars/hatsune-miku/model.vrm', registry)).toMatchObject({
      source: 'exact',
      profile: { identity: { modelId: 'hatsune-miku' } },
    });
    expect(() => registry.register(mikuProfile)).toThrow('already registered');

    registry.replace({ ...mikuProfile, rendering: { ...mikuProfile.rendering, renderScale: 1.25 } });
    expect(registry.get('hatsune-miku')?.rendering.renderScale).toBe(1.25);

    expect(resolveAvatarCompatibility('/models/avatars/unmeasured/model.vrm', registry)).toMatchObject({
      source: 'unknown-fallback',
      requestedModelId: 'unmeasured',
      profile: { identity: { modelId: 'default' } },
    });
    expect(resolveAvatarCompatibility('blob:session-only-vrm', registry)).toMatchObject({
      source: 'default-fallback',
      requestedModelId: null,
      profile: { identity: { modelId: 'default' } },
    });
  });

  it('accepts a complete valid profile and identifies missing, invalid, and non-finite values', () => {
    expect(validateAvatarCompatibilityProfile(profileFor('default'))).toMatchObject({ valid: true, issues: [] });

    const invalid = profileFor('yinlin');
    invalid.identity.displayName = '  ';
    invalid.identity.modelPaths = [];
    invalid.transform.scale = 0;
    invalid.transform.positionOffset = [0, Number.NaN, 0];
    invalid.expressions.aliases.blink = [''];
    invalid.gaze.horizontalScale = Number.POSITIVE_INFINITY;
    invalid.springBones.zeroGravityRepair.dragForce = -1;
    invalid.colliders.overrides = [{ name: '', radius: 0 }];
    invalid.animation.supportedStates = ['idle', 'not-a-motion-state' as never];

    const validation = validateAvatarCompatibilityProfile(invalid);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      'identity.displayName',
      'identity.modelPaths',
      'transform.scale',
      'transform.positionOffset',
      'expressions.aliases.blink',
      'gaze',
      'springBones.zeroGravityRepair',
      'colliders.overrides',
      'animation.supportedStates',
    ]));

    const incomplete = { schemaVersion: 1 } as AvatarCompatibilityProfile;
    expect(validateAvatarCompatibilityProfile(incomplete).issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      'identity.modelId',
      'transform.scale',
      'expressions.aliases.mouthA',
    ]));
  });

  it('resolves semantic expression aliases and drops unavailable model expressions safely', () => {
    const profile = profileFor('default');
    const aliases = resolveExpressionAliases(profile, capabilities({
      expressionNames: ['blinkLeft', 'joy', 'a', 'ee', 'oh'],
    }));

    expect(aliases).toMatchObject({ blink: 'blinkLeft', happy: 'joy', mouthA: 'a', mouthE: 'ee', mouthO: 'oh' });
    expect(aliases.mouthI).toBeUndefined();
    expect(resolveSemanticExpressionValues({ happy: 0.35, aa: 0.8, ih: 0.5 }, aliases)).toEqual({ joy: 0.35, a: 0.8 });
  });

  it('detects humanoid, expressions, gaze, spring bones, colliders, lip-sync, and VRMA compatibility from a loaded model', () => {
    const vrm = {
      humanoid: {},
      meta: { metaVersion: '1' },
      expressionManager: { expressions: [{ expressionName: 'aa' }, { presetName: 'blink' }] },
      lookAt: {},
      springBoneManager: {
        joints: new Set([{}, {}]),
        colliderGroups: new Set([{}]),
        colliders: new Set([{}, {}]),
      },
    } as unknown as VRM;

    const detected = detectAvatarCapabilities(vrm);
    expect(detected).toMatchObject({
      vrmVersion: '1.0',
      hasHumanoid: true,
      expressionManagerAvailable: true,
      expressionNames: ['aa', 'blink'],
      hasLookAt: true,
      hasSpringBones: true,
      springBoneCount: 2,
      colliderCount: 3,
      vrmaCompatible: true,
      lipSyncCompatible: true,
      warnings: [],
    });
    expect(detectAvatarCapabilities(null)).toMatchObject({ hasHumanoid: false, vrmaCompatible: false });
  });

  it('resolves each built-in avatar in a switch sequence and uses a procedural VRMA fallback when humanoid support is absent', () => {
    const sequence: readonly [string, AvatarProfileId][] = [
      ['/models/avatars/default/model.vrm', 'default'],
      ['/models/avatars/hatsune-miku/model.vrm', 'hatsune-miku'],
      ['/models/avatars/yinlin/model.vrm', 'yinlin'],
      ['/models/avatars/marionette/model.vrm', 'marionette'],
    ];

    for (const [url, expectedId] of sequence) {
      const resolved = resolveAvatarCompatibility(url);
      expect(resolved.source).toBe('exact');
      expect(resolved.profile.identity.modelId).toBe(expectedId);
      expect(isAnimationStateCompatible(resolved.profile, capabilities(), 'speaking')).toBe(true);
    }

    const fallback = resolveAvatarCompatibility('/models/avatars/unknown/model.vrm');
    expect(fallback).toMatchObject({ source: 'unknown-fallback', profile: { identity: { modelId: 'default' } } });
    expect(isAnimationStateCompatible(fallback.profile, capabilities({ hasHumanoid: false, vrmaCompatible: false }), 'speaking')).toBe(false);
  });

  it('produces a diagnostics-only compatibility contract for every built-in profile and the safe fallback without rendering a diagnostics panel', () => {
    const diagnosticCapabilities = capabilities({
      expressionNames: ['blink', 'aa'],
      springBoneCount: 4,
      colliderCount: 2,
    });
    for (const profileId of ['default', 'hatsune-miku', 'yinlin', 'marionette'] as const) {
      const diagnostics = createAvatarCompatibilityDiagnostics(
        resolveAvatarCompatibility(`/models/avatars/${profileId}/model.vrm`),
        diagnosticCapabilities,
        'speaking',
        'speaking',
        { speaking: { url: 'blob:speaking', fileName: 'speaking.vrma', sizeBytes: 123, targetState: 'speaking' } },
        false,
      );
      expect(diagnostics).toMatchObject({
        resolvedProfileId: profileId,
        profileSource: 'exact',
        expressionCount: 2,
        springBoneCount: 4,
        colliderCount: 2,
        currentMotionState: 'speaking',
        activeAnimation: 'speaking',
        vrmaMappings: ['speaking'],
        proceduralFallback: false,
      });
    }

    const fallbackDiagnostics = createAvatarCompatibilityDiagnostics(
      resolveAvatarCompatibility('blob:session-only-vrm'),
      capabilities({ hasHumanoid: false, vrmaCompatible: false, expressionNames: [], hasLookAt: false, springBoneCount: 0, colliderCount: 0 }),
      'idle',
      null,
      {},
      true,
    );
    expect(fallbackDiagnostics).toMatchObject({
      resolvedProfileId: 'default',
      profileSource: 'default-fallback',
      humanoid: false,
      gaze: false,
      springBoneCount: 0,
      colliderCount: 0,
      vrmaCompatible: false,
      activeAnimation: null,
      proceduralFallback: true,
    });
  });
});
