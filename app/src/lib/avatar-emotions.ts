// app/src/lib/avatar-emotions.ts
//
// VRM Emotion System — emotion → blendshape mapping.
//
// Extracted from app/src/pages/FaceView.tsx (task 04 — split god files).
// Reimplementation of AIRI's emotion→blendshape mapping in plain TypeScript.
// VRM blendshapes use standardized names: happy, sad, angry, surprised,
// relaxed, neutral. Each emotion maps to a set of blendshape values with
// lerp/easing transitions applied in VRMModel's animation loop.

import type { SemanticExpression } from '@/lib/avatar-compatibility';

// ── Emotion IDs ─────────────────────────────────────────────────────────
//
// The set of emotions the avatar can express. 'think' is a CHIMERA-specific
// addition (maps to relaxed + slight mouth open) for the "agent is thinking"
// state during agent turns.

export type EmotionId = 'happy' | 'sad' | 'angry' | 'think' | 'surprised' | 'neutral';

// ── Emotion → blendshape presets ────────────────────────────────────────
//
// Each emotion maps to a partial set of semantic blendshape values (0..1).
// Unspecified blendshapes default to 0. VRMModel's animation loop lerps
// toward these values each frame for smooth transitions.

export const EMOTION_BLENDSHAPES: Record<EmotionId, Partial<Record<SemanticExpression, number>>> = {
  happy:     { happy: 0.7, mouthA: 0.2 },
  sad:       { sad: 0.7, mouthO: 0.15 },
  angry:     { angry: 0.7, mouthE: 0.3 },
  think:     { relaxed: 0.3, mouthO: 0.1 },
  surprised: { surprised: 0.8, mouthA: 0.3 },
  neutral:   {},
};
