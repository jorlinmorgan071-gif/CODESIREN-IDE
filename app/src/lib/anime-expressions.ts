// app/src/lib/anime-expressions.ts
//
// Anime-style micro-expression library for VRM avatars.
//
// Anime characters have signature "tells" — double blinks, head tilts,
// sudden surprised eye-widens, soft smiles that fade. This module
// produces short-lived expression overlays (blendshape targets +
// brief head gestures) that the renderer applies on top of the
// base motion state, giving each avatar a lively, anime-like feel.
//
// The scheduler (avatar-auto-cycle.ts) picks expressions randomly
// from a personality-weighted pool and runs them to completion.
// Expressions never override voice/lip-sync — they only fill the
// silent gaps between speech turns.

import type { SemanticExpression } from './avatar-compatibility';

export type AnimeExpressionId =
  | 'double-blink'
  | 'soft-smile'
  | 'curious-tilt'
  | 'surprise-burst'
  | 'thoughtful-frown'
  | 'shy-glance'
  | 'happy-glimmer'
  | 'gentle-nod';

export interface AnimeExpressionPulse {
  id: AnimeExpressionId;
  durationSeconds: number;
  // Blendshape targets — semantic name → peak intensity [0..1].
  blendTargets: Readonly<Partial<Record<SemanticExpression, number>>>;
  // Optional head gesture layered on top of the base motion pose.
  headGesture: 'tilt-left' | 'tilt-right' | 'nod-up' | 'nod-down' | 'shake' | 'none';
  // Whether the expression can interrupt another in-progress expression.
  interruptible: boolean;
  // Relative weight used by the scheduler to bias selection.
  weight: number;
}

export const ANIME_EXPRESSIONS: Record<AnimeExpressionId, AnimeExpressionPulse> = {
  'double-blink': {
    id: 'double-blink',
    durationSeconds: 0.55,
    blendTargets: { blink: 1 },
    headGesture: 'none',
    interruptible: true,
    weight: 1.4,
  },
  'soft-smile': {
    id: 'soft-smile',
    durationSeconds: 2.2,
    blendTargets: { happy: 0.45 },
    headGesture: 'none',
    interruptible: true,
    weight: 1.2,
  },
  'curious-tilt': {
    id: 'curious-tilt',
    durationSeconds: 1.8,
    blendTargets: { surprised: 0.18, relaxed: 0.12 },
    headGesture: 'tilt-right',
    interruptible: true,
    weight: 1.0,
  },
  'surprise-burst': {
    id: 'surprise-burst',
    durationSeconds: 0.9,
    blendTargets: { surprised: 0.85, mouthA: 0.35 },
    headGesture: 'nod-up',
    interruptible: false,
    weight: 0.5,
  },
  'thoughtful-frown': {
    id: 'thoughtful-frown',
    durationSeconds: 2.5,
    blendTargets: { relaxed: 0.35 },
    headGesture: 'nod-down',
    interruptible: true,
    weight: 0.9,
  },
  'shy-glance': {
    id: 'shy-glance',
    durationSeconds: 1.6,
    blendTargets: { happy: 0.2, relaxed: 0.25 },
    headGesture: 'tilt-left',
    interruptible: true,
    weight: 0.8,
  },
  'happy-glimmer': {
    id: 'happy-glimmer',
    durationSeconds: 1.2,
    blendTargets: { happy: 0.7, surprised: 0.2 },
    headGesture: 'none',
    interruptible: true,
    weight: 1.0,
  },
  'gentle-nod': {
    id: 'gentle-nod',
    durationSeconds: 1.4,
    blendTargets: { happy: 0.15 },
    headGesture: 'nod-down',
    interruptible: true,
    weight: 1.0,
  },
};

// All ids sorted for stable iteration.
export const ANIME_EXPRESSION_IDS = Object.keys(ANIME_EXPRESSIONS) as AnimeExpressionId[];

// Pick a weighted random expression id (skipping the optional exclude list).
export function pickWeightedExpression(
  excludeIds: ReadonlySet<AnimeExpressionId> = new Set(),
): AnimeExpressionId {
  const candidates = ANIME_EXPRESSION_IDS.filter((id) => !excludeIds.has(id));
  const pool = candidates.length > 0 ? candidates : ANIME_EXPRESSION_IDS;
  const totalWeight = pool.reduce((sum, id) => sum + ANIME_EXPRESSIONS[id].weight, 0);
  let roll = Math.random() * totalWeight;
  for (const id of pool) {
    roll -= ANIME_EXPRESSIONS[id].weight;
    if (roll <= 0) return id;
  }
  return pool[pool.length - 1];
}

// ── Envelope helpers ─────────────────────────────────────────────────
//
// Each expression has a peak intensity (defined above) and a smooth
// attack + release envelope so the blendshapes don't pop in or out.
// The renderer queries `evalExpressionEnvelope` each frame and adds
// the result to its target blendshape values.

export interface ActiveAnimeExpression {
  id: AnimeExpressionId;
  startedAtMs: number;
  // Resolved duration — allows the scheduler to shorten or extend.
  durationSeconds: number;
}

export interface AnimeExpressionSample {
  // Per-semantic additive intensity [0..1].
  blend: Readonly<Partial<Record<SemanticExpression, number>>>;
  // Head gesture overlay (already converted to a signed rotation).
  headGesture: AnimeExpressionPulse['headGesture'];
  // 0..1 envelope value at the queried time.
  envelope: number;
  // True once the expression has fully released.
  finished: boolean;
}

// Compute an attack-sustain-release envelope in [0..1].
// 20% attack ramp-up, 60% sustain at peak, 20% release ramp-down.
function envelopeFor(progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 0;
  if (progress < 0.2) {
    // Ease-out cubic attack
    const t = progress / 0.2;
    return 1 - Math.pow(1 - t, 3);
  }
  if (progress > 0.8) {
    // Ease-in cubic release
    const t = (1 - progress) / 0.2;
    return 1 - Math.pow(1 - t, 3);
  }
  return 1;
}

export function evalExpressionEnvelope(
  active: ActiveAnimeExpression,
  nowMs: number,
): AnimeExpressionSample {
  const elapsed = Math.max(0, (nowMs - active.startedAtMs) / 1000);
  const progress = elapsed / active.durationSeconds;
  const envelope = envelopeFor(progress);
  const pulse = ANIME_EXPRESSIONS[active.id];
  const blend: Partial<Record<SemanticExpression, number>> = {};
  for (const [key, peak] of Object.entries(pulse.blendTargets)) {
    if (typeof peak === 'number') {
      blend[key as SemanticExpression] = peak * envelope;
    }
  }
  return {
    blend,
    headGesture: pulse.headGesture,
    envelope,
    finished: progress >= 1,
  };
}

// Convert a head-gesture label into a head-pitch/yaw/roll delta.
// Returned values are radians; small magnitudes so they layer on top
// of the base procedural pose without fighting it.
export function headGestureToRotationDelta(
  gesture: AnimeExpressionPulse['headGesture'],
  envelope: number,
): { pitch: number; yaw: number; roll: number } {
  const intensity = envelope * 0.18; // ~10° peak
  switch (gesture) {
    case 'tilt-left':
      return { pitch: 0, yaw: 0, roll: intensity };
    case 'tilt-right':
      return { pitch: 0, yaw: 0, roll: -intensity };
    case 'nod-up':
      return { pitch: -intensity * 0.7, yaw: 0, roll: 0 };
    case 'nod-down':
      return { pitch: intensity * 0.7, yaw: 0, roll: 0 };
    case 'shake':
      // Single side-to-side at peak envelope
      return { pitch: 0, yaw: intensity, roll: 0 };
    case 'none':
    default:
      return { pitch: 0, yaw: 0, roll: 0 };
  }
}
