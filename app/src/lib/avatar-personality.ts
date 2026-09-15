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

import type { BuiltInAnimationId } from './built-in-animations';

export interface AvatarPersonality {
  // Stable identifier matching the avatar model id from manifest.json.
  avatarId: string;
  // Display name shown in personality-aware UI hints (future use).
  displayName: string;
  // Temperament description used for idle animation weighting.
  temperament: 'bubbly' | 'graceful' | 'stoic' | 'balanced';
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

export function getAvatarPersonality(avatarId: string | null | undefined): AvatarPersonality {
  if (!avatarId) return FALLBACK_PERSONALITY;
  return personalityMap.get(avatarId) ?? FALLBACK_PERSONALITY;
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
