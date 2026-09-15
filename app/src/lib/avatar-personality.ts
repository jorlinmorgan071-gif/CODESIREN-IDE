// app/src/lib/avatar-personality.ts
//
// Per-avatar personality profiles.
//
// Each built-in avatar gets a unique personality fingerprint that drives
// animation selection, blink rhythm, head-sway cadence, and the rate of
// spontaneous micro-expressions. The aim is to make every character
// feel distinct without hard-coding animation timing into the renderer.
//
// Personalities are loaded from `extractAvatarModelId` (the same id used
// by the compatibility profile registry), so they automatically apply
// across FaceView, PIP AvatarOverlay, and InteractionBubble contexts.
//
// Custom (user-uploaded) avatars are supported two ways:
//
//   1. Trait-based inference — when a custom avatar is first loaded, the
//      renderer inspects its VRM capabilities (expression count, humanoid
//      presence, look-at, spring bones) and picks a sensible built-in
//      temperament. A high-expression model with look-at becomes
//      "bubbly"; a stoic low-expression model becomes "stoic"; etc.
//
//   2. User override — `setCustomAvatarPersonalityOverride()` lets the
//      user pin a specific temperament to a custom avatar id. The
//      override is persisted in localStorage so it survives reloads.

import type { BuiltInAnimationId } from './built-in-animations';
import type { AvatarCapabilities } from './avatar-compatibility';

export type AvatarTemperament = 'bubbly' | 'graceful' | 'stoic' | 'balanced';

export interface AvatarPersonality {
  // Stable identifier matching the avatar model id from manifest.json,
  // or `custom-<timestamp>-<hex>` for user-uploaded avatars.
  avatarId: string;
  // Display name shown in personality-aware UI hints (future use).
  displayName: string;
  // Whether this personality was inferred from traits (custom avatar)
  // or shipped as a built-in profile.
  source: 'built-in' | 'inferred' | 'user-override';
  // Temperament description used for idle animation weighting.
  temperament: AvatarTemperament;
  // Pool of idle animations the auto-cycle scheduler picks from.
  // An empty pool falls back to the global idle pool.
  idlePool: BuiltInAnimationId[];
  // Pool of "gesture" animations for celebration / hello moments.
  gesturePool: BuiltInAnimationId[];
  // Pool of "high energy" animations used for celebrate state.
  celebratePool: BuiltInAnimationId[];
  // Pool of "rest" animations when the user has been away.
  restPool: BuiltInAnimationId[];
  // Mean seconds between idle-animation swaps.
  idleSwapMeanSeconds: number;
  // Mean seconds between spontaneous micro-expressions
  // (a quick smile, blink burst, head-tilt, etc.).
  microExpressionMeanSeconds: number;
  // Mean seconds between idle "look around" head turns.
  lookAroundMeanSeconds: number;
  // Average blink rate scale (1 = human baseline ~4s).
  blinkRateScale: number;
  // Whether the avatar tends to maintain eye-contact (true) or
  // break it frequently (false) — affects gaze jitter.
  maintainsEyeContact: boolean;
  // Head-sway speed multiplier (1 = baseline).
  swaySpeed: number;
  // Head-sway amplitude multiplier (1 = baseline).
  swayAmplitude: number;
  // Resting pose preference (which standing idle to use for the very
  // first 'enter' state).
  preferredEnterAnimation: BuiltInAnimationId;
  // Probability [0..1] that the avatar waves on first model-load
  // (used as a friendly greeting).
  greetOnLoadProbability: number;
}

const BUILT_IN_PERSONALITIES: AvatarPersonality[] = [
  {
    avatarId: 'hatsune-miku',
    displayName: 'Hatsune Miku',
    source: 'built-in',
    temperament: 'bubbly',
    idlePool: ['catwalk-idle-twist-l', 'catwalk-idle-twist-r', 'standing-idle', 'catwalk-idle-to-twist-r'],
    gesturePool: ['waving', 'excited'],
    celebratePool: ['excited', 'silly-dancing', 'macarena-dance'],
    restPool: ['standing-idle', 'looking-behind'],
    idleSwapMeanSeconds: 8,
    microExpressionMeanSeconds: 4,
    lookAroundMeanSeconds: 6,
    blinkRateScale: 1.25, // slightly more frequent blinks (curious)
    maintainsEyeContact: true,
    swaySpeed: 1.15,
    swayAmplitude: 1.1,
    preferredEnterAnimation: 'waving',
    greetOnLoadProbability: 0.85,
  },
  {
    avatarId: 'marionette',
    displayName: 'Marionette',
    source: 'built-in',
    temperament: 'graceful',
    idlePool: ['catwalk-idle-to-twist-r', 'catwalk-idle-twist-r', 'standing-idle'],
    gesturePool: ['looking-behind', 'waving'],
    celebratePool: ['macarena-dance', 'northern-soul-spin-combo'],
    restPool: ['praying', 'standing-idle'],
    idleSwapMeanSeconds: 12,
    microExpressionMeanSeconds: 7,
    lookAroundMeanSeconds: 9,
    blinkRateScale: 0.8, // slower, deliberate blinks
    maintainsEyeContact: false,
    swaySpeed: 0.85,
    swayAmplitude: 0.9,
    preferredEnterAnimation: 'standing-idle',
    greetOnLoadProbability: 0.3,
  },
  {
    avatarId: 'yinlin',
    displayName: 'Yinlin',
    source: 'built-in',
    temperament: 'stoic',
    idlePool: ['standing-idle', 'catwalk-idle-twist-l'],
    gesturePool: ['waving', 'looking-behind'],
    celebratePool: ['excited', 'northern-soul-spin-combo'],
    restPool: ['praying', 'standing-idle'],
    idleSwapMeanSeconds: 14,
    microExpressionMeanSeconds: 9,
    lookAroundMeanSeconds: 11,
    blinkRateScale: 0.9,
    maintainsEyeContact: true,
    swaySpeed: 0.8,
    swayAmplitude: 0.7,
    preferredEnterAnimation: 'standing-idle',
    greetOnLoadProbability: 0.15,
  },
  {
    avatarId: 'default',
    displayName: 'Default Avatar',
    source: 'built-in',
    temperament: 'balanced',
    idlePool: ['standing-idle', 'catwalk-idle-twist-l', 'catwalk-idle-twist-r'],
    gesturePool: ['waving', 'looking-behind'],
    celebratePool: ['excited', 'silly-dancing', 'macarena-dance'],
    restPool: ['standing-idle', 'praying'],
    idleSwapMeanSeconds: 10,
    microExpressionMeanSeconds: 6,
    lookAroundMeanSeconds: 8,
    blinkRateScale: 1.0,
    maintainsEyeContact: true,
    swaySpeed: 1.0,
    swayAmplitude: 1.0,
    preferredEnterAnimation: 'waving',
    greetOnLoadProbability: 0.5,
  },
];

const personalityMap = new Map<string, AvatarPersonality>(
  BUILT_IN_PERSONALITIES.map((p) => [p.avatarId, p]),
);

const FALLBACK_PERSONALITY: AvatarPersonality = BUILT_IN_PERSONALITIES.find((p) => p.avatarId === 'default')!;

// ── Custom avatar personality overrides ────────────────────────────────
//
// User-overridable temperament for custom avatars. Stored per-avatar-id
// in localStorage so the choice survives reloads. The key includes the
// custom avatar id so different uploads can have different overrides.

const CUSTOM_OVERRIDE_KEY_PREFIX = 'codesiren-personality-override:';

function loadCustomOverride(avatarId: string): AvatarTemperament | null {
  try {
    const raw = localStorage.getItem(CUSTOM_OVERRIDE_KEY_PREFIX + avatarId);
    if (raw === 'bubbly' || raw === 'graceful' || raw === 'stoic' || raw === 'balanced') {
      return raw;
    }
  } catch {
    // localStorage may be unavailable (SSR / privacy mode).
  }
  return null;
}

function saveCustomOverride(avatarId: string, temperament: AvatarTemperament): void {
  try {
    localStorage.setItem(CUSTOM_OVERRIDE_KEY_PREFIX + avatarId, temperament);
  } catch {
    // Silently ignore — the override just won't persist.
  }
}

/**
 * Build a personality for a custom avatar by cloning the built-in profile
 * for the requested temperament and stamping the avatar id + display
 * name. The four temperaments cover the meaningful axes of variation
 * (animation cadence, blink rate, greet probability) without forcing
 * the user to hand-author every field.
 */
function buildCustomAvatarPersonality(
  avatarId: string,
  displayName: string,
  temperament: AvatarTemperament,
  source: AvatarPersonality['source'],
): AvatarPersonality {
  const template = BUILT_IN_PERSONALITIES.find((p) => p.temperament === temperament) ?? FALLBACK_PERSONALITY;
  return {
    ...template,
    avatarId,
    displayName: displayName || 'Custom Avatar',
    source,
  };
}

/**
 * Infer a temperament from a custom avatar's detected capabilities.
 *
 *   - Has look-at + many expressions + spring bones  → bubbly
 *   - Has look-at + medium expressions               → balanced
 *   - Has expressions but no look-at                 → graceful
 *   - Few expressions / no humanoid                  → stoic
 *
 * This is intentionally a coarse heuristic — the user can always
 * override it with {@link setCustomAvatarPersonalityOverride}.
 */
export function inferTemperamentFromCapabilities(caps: AvatarCapabilities): AvatarTemperament {
  if (!caps.hasHumanoid || caps.expressionNames.length < 4) return 'stoic';
  if (caps.hasLookAt && caps.expressionNames.length >= 12 && caps.hasSpringBones) return 'bubbly';
  if (caps.hasLookAt && caps.expressionNames.length >= 6) return 'balanced';
  return 'graceful';
}

/**
 * Set (or change) the personality override for a custom avatar.
 * Persists to localStorage so it survives reloads.
 *
 * Returns the resolved personality so the caller can immediately use it.
 */
export function setCustomAvatarPersonalityOverride(
  avatarId: string,
  displayName: string,
  temperament: AvatarTemperament,
): AvatarPersonality {
  saveCustomOverride(avatarId, temperament);
  return buildCustomAvatarPersonality(avatarId, displayName, temperament, 'user-override');
}

/**
 * Resolve the personality for a given avatar id.
 *
 * Resolution order:
 *   1. Built-in profile (if the id matches one of the shipped avatars)
 *   2. User override (if the user previously picked a temperament for
 *      this custom avatar id)
 *   3. Inferred from capabilities (passed in by the caller — if null,
 *      falls back to the default profile)
 */
export function getAvatarPersonality(
  avatarId: string | null | undefined,
  options: {
    displayName?: string;
    capabilities?: AvatarCapabilities | null;
  } = {},
): AvatarPersonality {
  if (!avatarId) return FALLBACK_PERSONALITY;
  const builtIn = personalityMap.get(avatarId);
  if (builtIn) return builtIn;

  // Custom avatar — check for a user-set override first.
  const override = loadCustomOverride(avatarId);
  if (override) {
    return buildCustomAvatarPersonality(avatarId, options.displayName ?? 'Custom Avatar', override, 'user-override');
  }

  // Fall back to capability inference — or the default profile if the
  // caller hasn't passed capabilities yet (e.g. on first load before
  // the VRM has finished parsing).
  if (options.capabilities) {
    const inferred = inferTemperamentFromCapabilities(options.capabilities);
    return buildCustomAvatarPersonality(avatarId, options.displayName ?? 'Custom Avatar', inferred, 'inferred');
  }

  // Last resort — use the balanced default. This happens briefly on the
  // very first render before capabilities are detected; the personality
  // will be re-resolved with capabilities once the VRM finishes loading.
  return buildCustomAvatarPersonality(avatarId, options.displayName ?? 'Custom Avatar', 'balanced', 'inferred');
}

export function listAvatarPersonalities(): AvatarPersonality[] {
  return [...BUILT_IN_PERSONALITIES];
}

// Tiny helper used by the auto-cycle scheduler to draw from a pool
// with a slight bias against repeating the last pick.
export function pickRandom<T>(pool: readonly T[], exclude?: T): T {
  if (pool.length === 0) {
    throw new Error('pickRandom: pool is empty');
  }
  if (pool.length === 1) return pool[0];
  let candidate = pool[Math.floor(Math.random() * pool.length)];
  let attempts = 0;
  while (exclude !== undefined && candidate === exclude && attempts < 4) {
    candidate = pool[Math.floor(Math.random() * pool.length)];
    attempts++;
  }
  return candidate;
}

// Sample an exponentially distributed waiting time (seconds) around a mean.
// Used to add natural-looking variance to idle swaps and micro-expressions.
export function sampleExponentialSeconds(meanSeconds: number): number {
  // -ln(u) / lambda, lambda = 1 / mean
  const u = Math.max(1e-6, Math.random());
  return -Math.log(u) * meanSeconds;
}
