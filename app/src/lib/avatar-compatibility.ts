import type { VRM } from '@pixiv/three-vrm';
import type { AvatarMotionState } from './avatar-motion';
import { LOCAL_VRMA_TARGET_STATES, type LocalVrmaRegistry } from './local-vrma-session';

export const BUILT_IN_AVATAR_PROFILE_IDS = ['default', 'hatsune-miku', 'yinlin', 'marionette'] as const;
export type AvatarProfileId = (typeof BUILT_IN_AVATAR_PROFILE_IDS)[number];
export type AvatarProfileSource = 'exact' | 'default-fallback' | 'unknown-fallback';
export type Vec3 = readonly [number, number, number];

export const SEMANTIC_EXPRESSIONS = [
  'blink', 'happy', 'sad', 'angry', 'surprised', 'relaxed', 'neutral',
  'mouthA', 'mouthI', 'mouthU', 'mouthE', 'mouthO',
] as const;
export type SemanticExpression = (typeof SEMANTIC_EXPRESSIONS)[number];

export interface HumanoidPoseCorrection {
  bone: 'leftUpperArm' | 'rightUpperArm' | 'leftShoulder' | 'rightShoulder' | 'spine';
  rotation: Vec3;
}

export interface AvatarCompatibilityProfile {
  schemaVersion: 1;
  identity: {
    modelId: AvatarProfileId;
    displayName: string;
    modelPaths: readonly string[];
  };
  transform: {
    scale: number;
    positionOffset: Vec3;
    rotationOffset: Vec3;
    humanoidPose: readonly HumanoidPoseCorrection[];
  };
  expressions: {
    aliases: Readonly<Record<SemanticExpression, readonly string[]>>;
    blink: SemanticExpression;
    mouth: Readonly<Record<'A' | 'I' | 'U' | 'E' | 'O', SemanticExpression>>;
    emotions: Readonly<Record<'happy' | 'sad' | 'angry' | 'think' | 'surprised' | 'neutral', SemanticExpression | null>>;
  };
  gaze: {
    mode: 'inherit' | 'enabled' | 'disabled';
    offset: Vec3;
    horizontalScale: number;
    verticalScale: number;
  };
  springBones: {
    enabled: 'inherit' | 'enabled' | 'disabled';
    zeroGravityRepair: {
      enabled: boolean;
      gravityPower: number;
      gravityDirection: Vec3;
      dragForce: number;
      onlyWhenZeroGravity: boolean;
    };
  };
  colliders: {
    enabled: 'inherit' | 'enabled' | 'disabled';
    overrides: readonly { name: string; radius: number }[];
  };
  animation: {
    vrmaCompatibility: 'supported' | 'unknown' | 'unsupported';
    humanoidCompatibility: 'required' | 'optional';
    retargeting: 'standard-vrm-humanoid' | 'unresolved';
    supportedStates: readonly AvatarMotionState[];
    corrections: readonly string[];
  };
  rendering: {
    meshShadows: 'inherit' | 'enabled' | 'disabled';
    blobShadow: boolean;
    renderScale: number;
  };
  unresolved: readonly string[];
}

export interface AvatarProfileValidationIssue {
  path: string;
  message: string;
}

export interface AvatarProfileValidationResult {
  valid: boolean;
  issues: readonly AvatarProfileValidationIssue[];
}

export interface AvatarCapabilities {
  vrmVersion: '0.x' | '1.0' | 'unknown';
  hasHumanoid: boolean;
  expressionManagerAvailable: boolean;
  expressionNames: readonly string[];
  hasLookAt: boolean;
  hasSpringBones: boolean;
  springBoneCount: number;
  colliderCount: number;
  vrmaCompatible: boolean;
  lipSyncCompatible: boolean;
  warnings: readonly string[];
}

export interface ResolvedAvatarCompatibility {
  profile: AvatarCompatibilityProfile;
  source: AvatarProfileSource;
  requestedModelId: string | null;
  avatarUrl: string;
  warnings: readonly string[];
}

export interface AvatarCompatibilityDiagnostics {
  avatarUrl: string;
  requestedModelId: string | null;
  resolvedProfileId: AvatarProfileId;
  profileSource: AvatarProfileSource;
  vrmVersion: AvatarCapabilities['vrmVersion'];
  humanoid: boolean;
  expressionCount: number;
  expressionAliases: Readonly<Partial<Record<SemanticExpression, string>>>;
  gaze: boolean;
  springBoneCount: number;
  colliderCount: number;
  vrmaCompatible: boolean;
  activeAnimation: AvatarMotionState | null;
  currentMotionState: AvatarMotionState;
  vrmaMappings: readonly AvatarMotionState[];
  proceduralFallback: boolean;
  warnings: readonly string[];
}

const LEGACY_EXPRESSION_SEMANTICS: Record<string, SemanticExpression> = {
  aa: 'mouthA', ih: 'mouthI', ou: 'mouthU', ee: 'mouthE', oh: 'mouthO',
  blink: 'blink', happy: 'happy', sad: 'sad', angry: 'angry', surprised: 'surprised', relaxed: 'relaxed', neutral: 'neutral',
};

const STANDARD_ALIASES: Readonly<Record<SemanticExpression, readonly string[]>> = {
  blink: ['blink', 'blinkLeft', 'blinkRight'],
  happy: ['happy', 'joy'],
  sad: ['sad', 'sorrow'],
  angry: ['angry', 'angryFace'],
  surprised: ['surprised', 'surprise'],
  relaxed: ['relaxed', 'neutral'],
  neutral: ['neutral'],
  mouthA: ['aa', 'a'],
  mouthI: ['ih', 'i'],
  mouthU: ['ou', 'u'],
  mouthE: ['ee', 'e'],
  mouthO: ['oh', 'o'],
};

const DEFAULT_SUPPORTED_STATES = [...LOCAL_VRMA_TARGET_STATES] as readonly AvatarMotionState[];
const DEFAULT_POSE: readonly HumanoidPoseCorrection[] = [
  { bone: 'leftUpperArm', rotation: [0, 0, 1.2] },
  { bone: 'rightUpperArm', rotation: [0, 0, -1.2] },
  { bone: 'leftShoulder', rotation: [0, 0, 0.1] },
  { bone: 'rightShoulder', rotation: [0, 0, -0.1] },
  { bone: 'spine', rotation: [0.05, 0, 0] },
];

function createBuiltInProfile(
  modelId: AvatarProfileId,
  displayName: string,
  unresolved: readonly string[],
): AvatarCompatibilityProfile {
  return {
    schemaVersion: 1,
    identity: { modelId, displayName, modelPaths: [`/models/avatars/${modelId}/model.vrm`] },
    // These values preserve the existing engine baseline. No avatar-specific
    // transform is claimed until the model has been measured and reviewed.
    transform: { scale: 1, positionOffset: [0, -1.2, 0], rotationOffset: [0, 0, 0], humanoidPose: DEFAULT_POSE },
    expressions: {
      aliases: STANDARD_ALIASES,
      blink: 'blink',
      mouth: { A: 'mouthA', I: 'mouthI', U: 'mouthU', E: 'mouthE', O: 'mouthO' },
      emotions: { happy: 'happy', sad: 'sad', angry: 'angry', think: 'relaxed', surprised: 'surprised', neutral: 'neutral' },
    },
    gaze: { mode: 'inherit', offset: [0, 0, 0], horizontalScale: 0.5, verticalScale: 0.3 },
    springBones: {
      enabled: 'inherit',
      // Preserves the existing zero-gravity repair; it changes only joints
      // whose source model explicitly sets zero gravity.
      zeroGravityRepair: { enabled: true, gravityPower: 1, gravityDirection: [0, -1, 0], dragForce: 0.5, onlyWhenZeroGravity: true },
    },
    colliders: { enabled: 'inherit', overrides: [] },
    animation: { vrmaCompatibility: 'supported', humanoidCompatibility: 'required', retargeting: 'standard-vrm-humanoid', supportedStates: DEFAULT_SUPPORTED_STATES, corrections: [] },
    rendering: { meshShadows: 'enabled', blobShadow: true, renderScale: 1 },
    unresolved,
  };
}

export const BUILT_IN_AVATAR_PROFILES: readonly AvatarCompatibilityProfile[] = [
  createBuiltInProfile('default', 'Default Avatar', ['No model-specific transform override is measured; inherited engine baseline is in use.']),
  createBuiltInProfile('hatsune-miku', 'Hatsune Miku', ['No measured Miku-specific transform, gaze, collider, or retarget correction is stored; inherited engine baseline is in use.']),
  createBuiltInProfile('yinlin', 'Yinlin', ['No measured Yinlin-specific transform, gaze, collider, or retarget correction is stored; inherited engine baseline is in use.']),
  createBuiltInProfile('marionette', 'Marionette', ['No measured Marionette-specific transform, gaze, collider, or retarget correction is stored; inherited engine baseline is in use.']),
];

const ALL_MOTION_STATES: readonly AvatarMotionState[] = [
  'enter', 'idle', 'listening', 'thinking', 'speaking', 'celebrate', 'gesture', 'bored', 'rest', 'wake',
];

function isFiniteVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

export function validateAvatarCompatibilityProfile(profile: AvatarCompatibilityProfile): AvatarProfileValidationResult {
  const issues: AvatarProfileValidationIssue[] = [];
  if (profile.schemaVersion !== 1) issues.push({ path: 'schemaVersion', message: 'Only schema version 1 is supported.' });
  if (!profile.identity?.modelId) issues.push({ path: 'identity.modelId', message: 'A model identifier is required.' });
  if (!profile.identity?.displayName?.trim()) issues.push({ path: 'identity.displayName', message: 'A display name is required.' });
  if (!Array.isArray(profile.identity?.modelPaths) || profile.identity.modelPaths.length === 0) issues.push({ path: 'identity.modelPaths', message: 'At least one model path is required.' });
  if (!Number.isFinite(profile.transform?.scale) || profile.transform.scale <= 0) issues.push({ path: 'transform.scale', message: 'Scale must be a finite number greater than zero.' });
  if (!isFiniteVec3(profile.transform?.positionOffset)) issues.push({ path: 'transform.positionOffset', message: 'Position offset must contain three finite numbers.' });
  if (!isFiniteVec3(profile.transform?.rotationOffset)) issues.push({ path: 'transform.rotationOffset', message: 'Rotation offset must contain three finite numbers.' });
  for (const semantic of SEMANTIC_EXPRESSIONS) {
    const aliases = profile.expressions?.aliases?.[semantic];
    if (!Array.isArray(aliases) || aliases.length === 0 || aliases.some((alias) => !alias.trim())) {
      issues.push({ path: `expressions.aliases.${semantic}`, message: 'Each semantic expression needs at least one non-empty candidate alias.' });
    }
  }
  if (!Number.isFinite(profile.gaze?.horizontalScale) || !Number.isFinite(profile.gaze?.verticalScale)) issues.push({ path: 'gaze', message: 'Gaze scales must be finite numbers.' });
  if (!isFiniteVec3(profile.gaze?.offset)) issues.push({ path: 'gaze.offset', message: 'Gaze offset must contain three finite numbers.' });
  const repair = profile.springBones?.zeroGravityRepair;
  if (!repair || !Number.isFinite(repair.gravityPower) || repair.gravityPower < 0 || !Number.isFinite(repair.dragForce) || repair.dragForce < 0 || !isFiniteVec3(repair.gravityDirection)) {
    issues.push({ path: 'springBones.zeroGravityRepair', message: 'Spring-bone gravity, direction, and drag values must be valid non-negative numeric values.' });
  }
  for (const collider of profile.colliders?.overrides ?? []) {
    if (!collider.name.trim() || !Number.isFinite(collider.radius) || collider.radius <= 0) issues.push({ path: 'colliders.overrides', message: 'Collider overrides need a name and a radius greater than zero.' });
  }
  for (const state of profile.animation?.supportedStates ?? []) {
    if (!ALL_MOTION_STATES.includes(state)) issues.push({ path: 'animation.supportedStates', message: `Unsupported motion state: ${state}.` });
  }
  return { valid: issues.length === 0, issues };
}

export class AvatarCompatibilityProfileRegistry {
  private readonly profiles = new Map<AvatarProfileId, AvatarCompatibilityProfile>();

  constructor(initialProfiles: readonly AvatarCompatibilityProfile[] = BUILT_IN_AVATAR_PROFILES) {
    for (const profile of initialProfiles) this.register(profile);
  }

  register(profile: AvatarCompatibilityProfile): void {
    const validation = validateAvatarCompatibilityProfile(profile);
    if (!validation.valid) throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' '));
    if (this.profiles.has(profile.identity.modelId)) throw new Error(`A compatibility profile is already registered for ${profile.identity.modelId}.`);
    this.profiles.set(profile.identity.modelId, profile);
  }

  replace(profile: AvatarCompatibilityProfile): void {
    const validation = validateAvatarCompatibilityProfile(profile);
    if (!validation.valid) throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' '));
    this.profiles.set(profile.identity.modelId, profile);
  }

  get(modelId: string | null | undefined): AvatarCompatibilityProfile | undefined {
    return modelId ? this.profiles.get(modelId as AvatarProfileId) : undefined;
  }

  list(): readonly AvatarCompatibilityProfile[] {
    return [...this.profiles.values()];
  }
}

export const avatarCompatibilityProfiles = new AvatarCompatibilityProfileRegistry();

export function extractAvatarModelId(avatarUrl: string): string | null {
  // Built-in avatars: /models/avatars/<id>/model.vrm
  const builtInMatch = avatarUrl.match(/\/models\/avatars\/([^/]+)\/model\.vrm(?:$|[?#])/);
  if (builtInMatch && builtInMatch[1] !== 'custom') return builtInMatch[1];

  // Custom avatars: /models/avatars/custom/<custom-id>/model.vrm
  // We return the full `custom-<timestamp>-<hex>` id so downstream
  // callers can recognise it as a custom avatar (it starts with `custom-`).
  const customMatch = avatarUrl.match(/\/models\/avatars\/custom\/([^/]+)\/model\.vrm(?:$|[?#])/);
  if (customMatch) return customMatch[1];

  return null;
}

/**
 * Returns true if the given avatar id (as returned by {@link extractAvatarModelId})
 * refers to a user-uploaded custom avatar rather than a built-in one.
 */
export function isCustomAvatarModelId(modelId: string | null | undefined): boolean {
  return Boolean(modelId && modelId.startsWith('custom-'));
}

export function resolveAvatarCompatibility(avatarUrl: string, registry = avatarCompatibilityProfiles): ResolvedAvatarCompatibility {
  const requestedModelId = extractAvatarModelId(avatarUrl);
  const exact = registry.get(requestedModelId);
  if (exact) return { profile: exact, source: 'exact', requestedModelId, avatarUrl, warnings: [...exact.unresolved] };
  const fallback = registry.get('default');
  if (!fallback) throw new Error('The default compatibility profile is not registered.');
  const source: AvatarProfileSource = requestedModelId ? 'unknown-fallback' : 'default-fallback';
  const warning = requestedModelId
    ? `No exact compatibility profile exists for '${requestedModelId}'. The safe Default Avatar profile is active.`
    : 'Avatar identity could not be inferred from its URL. The safe Default Avatar profile is active.';
  return { profile: fallback, source, requestedModelId, avatarUrl, warnings: [warning, ...fallback.unresolved] };
}

export function detectAvatarCapabilities(vrm: VRM | null | undefined): AvatarCapabilities {
  if (!vrm) {
    return { vrmVersion: 'unknown', hasHumanoid: false, expressionManagerAvailable: false, expressionNames: [], hasLookAt: false, hasSpringBones: false, springBoneCount: 0, colliderCount: 0, vrmaCompatible: false, lipSyncCompatible: false, warnings: ['VRM capabilities are unavailable until the model loads.'] };
  }
  const expressionNames = (vrm.expressionManager?.expressions ?? []).map((expression) => {
    const raw = expression as { expressionName?: string; presetName?: string; name?: string };
    return raw.expressionName ?? raw.presetName ?? raw.name ?? 'unknown';
  });
  const springBoneManager = (vrm as unknown as { springBoneManager?: { joints?: Iterable<unknown>; colliderGroups?: Iterable<unknown>; colliders?: Iterable<unknown> } }).springBoneManager;
  const springBoneCount = springBoneManager?.joints ? Array.from(springBoneManager.joints).length : 0;
  const colliderCount = (springBoneManager?.colliderGroups ? Array.from(springBoneManager.colliderGroups).length : 0) + (springBoneManager?.colliders ? Array.from(springBoneManager.colliders).length : 0);
  const meta = vrm.meta as { metaVersion?: string; licenseUrl?: string } | undefined;
  const versionValue = meta?.metaVersion ?? meta?.licenseUrl ?? '';
  const vrmVersion: AvatarCapabilities['vrmVersion'] = String(versionValue) === '1' || String(versionValue) === '1.0' ? '1.0' : versionValue ? '0.x' : 'unknown';
  const expressions = new Set(expressionNames.map((name) => name.toLowerCase()));
  const lipSyncCompatible = ['aa', 'ih', 'ou', 'ee', 'oh'].some((name) => expressions.has(name));
  const warnings: string[] = [];
  if (!vrm.humanoid) warnings.push('Humanoid rig is unavailable; VRMA retargeting will use procedural fallback.');
  if (!vrm.expressionManager) warnings.push('Expression manager is unavailable; semantic expression writes are disabled.');
  if (!vrm.lookAt) warnings.push('Look-at is unavailable; gaze is disabled safely.');
  if (!springBoneCount) warnings.push('No spring-bone joints were detected.');
  return { vrmVersion, hasHumanoid: !!vrm.humanoid, expressionManagerAvailable: !!vrm.expressionManager, expressionNames, hasLookAt: !!vrm.lookAt, hasSpringBones: springBoneCount > 0, springBoneCount, colliderCount, vrmaCompatible: !!vrm.humanoid, lipSyncCompatible, warnings };
}

export function resolveExpressionAliases(profile: AvatarCompatibilityProfile, capabilities: AvatarCapabilities): Readonly<Partial<Record<SemanticExpression, string>>> {
  const available = new Map(capabilities.expressionNames.map((name) => [name.toLowerCase(), name]));
  const resolved: Partial<Record<SemanticExpression, string>> = {};
  for (const semantic of SEMANTIC_EXPRESSIONS) {
    const matched = profile.expressions.aliases[semantic].map((candidate) => available.get(candidate.toLowerCase())).find(Boolean);
    if (matched) resolved[semantic] = matched;
  }
  return resolved;
}

export function resolveSemanticExpressionValues(
  values: Readonly<Partial<Record<string, number>>>,
  aliases: Readonly<Partial<Record<SemanticExpression, string>>>,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'number') continue;
    const semantic = (SEMANTIC_EXPRESSIONS as readonly string[]).includes(key)
      ? key as SemanticExpression
      : LEGACY_EXPRESSION_SEMANTICS[key];
    const actual = semantic ? aliases[semantic] : undefined;
    if (actual) resolved[actual] = Math.max(resolved[actual] ?? 0, value);
  }
  return resolved;
}

export function isAnimationStateCompatible(profile: AvatarCompatibilityProfile, capabilities: AvatarCapabilities, state: AvatarMotionState): boolean {
  return profile.animation.vrmaCompatibility === 'supported'
    && profile.animation.supportedStates.includes(state)
    && (profile.animation.humanoidCompatibility !== 'required' || capabilities.hasHumanoid);
}

export function createAvatarCompatibilityDiagnostics(
  compatibility: ResolvedAvatarCompatibility,
  capabilities: AvatarCapabilities,
  currentMotionState: AvatarMotionState,
  activeAnimation: AvatarMotionState | null,
  animationRegistry: LocalVrmaRegistry,
  proceduralFallback: boolean,
): AvatarCompatibilityDiagnostics {
  const aliases = resolveExpressionAliases(compatibility.profile, capabilities);
  return {
    avatarUrl: compatibility.avatarUrl,
    requestedModelId: compatibility.requestedModelId,
    resolvedProfileId: compatibility.profile.identity.modelId,
    profileSource: compatibility.source,
    vrmVersion: capabilities.vrmVersion,
    humanoid: capabilities.hasHumanoid,
    expressionCount: capabilities.expressionNames.length,
    expressionAliases: aliases,
    gaze: capabilities.hasLookAt && compatibility.profile.gaze.mode !== 'disabled',
    springBoneCount: capabilities.springBoneCount,
    colliderCount: capabilities.colliderCount,
    vrmaCompatible: capabilities.vrmaCompatible && compatibility.profile.animation.vrmaCompatibility === 'supported',
    activeAnimation,
    currentMotionState,
    vrmaMappings: Object.keys(animationRegistry) as AvatarMotionState[],
    proceduralFallback,
    warnings: [...compatibility.warnings, ...capabilities.warnings],
  };
}
