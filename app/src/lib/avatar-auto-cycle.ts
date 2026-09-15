// app/src/lib/avatar-auto-cycle.ts
//
// Auto-cycle scheduler for VRM avatars.
//
// Drives three parallel streams of "liveliness" on top of the existing
// AvatarMotionState machine:
//
//   1. Idle variety   — periodically swaps the clip playing inside the
//                       current state slot, drawing from the avatar's
//                       personality idle pool. Crossfades smoothly.
//
//   2. Anime pulses   — fires short-lived blendshape overlays (double
//                       blink, soft smile, curious head-tilt, …) at
//                       personality-tuned intervals.
//
//   3. Look-around    — when the user has been idle for a while, the
//                       avatar randomly turns its head to look at
//                       different points in the scene, then returns.
//
// All three streams are time-based and shared across the FaceView, PIP
// AvatarOverlay, and InteractionBubble contexts. They never override
// voice / lip-sync or any active motion-state transition requested by
// the AvatarMotionState reducer — they only fill the silent gaps.
//
// The scheduler is a plain stateful object (no React), so each context
// owns its own instance and ticks it from useFrame.

import type { LocalVrmaPlayer } from './vrma-player';
import type { AvatarMotionState } from './avatar-motion';
import {
  BUILT_IN_ANIMATIONS_BY_STATE,
  getBuiltInAnimation,
  type BuiltInAnimationId,
} from './built-in-animations';
import {
  getAvatarPersonality,
  pickRandom,
  sampleExponentialSeconds,
  type AvatarPersonality,
} from './avatar-personality';
import {
  ANIME_EXPRESSIONS,
  evalExpressionEnvelope,
  pickWeightedExpression,
  headGestureToRotationDelta,
  type ActiveAnimeExpression,
  type AnimeExpressionId,
  type AnimeExpressionSample,
} from './anime-expressions';
import type { AvatarCompatibilityProfile } from './avatar-compatibility';
import type { AvatarCapabilities } from './avatar-compatibility';

export interface AutoCycleState {
  avatarId: string | null;
  personality: AvatarPersonality;
  // Currently playing built-in clip per state.
  currentClipPerState: Map<AvatarMotionState, BuiltInAnimationId>;
  // Next scheduled idle swap (epoch ms).
  nextIdleSwapMs: number;
  // Active anime expression (null when none).
  activeExpression: ActiveAnimeExpression | null;
  // Most recent expression id (so we don't repeat consecutively).
  lastExpressionId: string | null;
  // Next scheduled anime expression (epoch ms).
  nextExpressionMs: number;
  // Look-around target (yaw, pitch) in radians, plus with expiry.
  lookAroundTargetYaw: number;
  lookAroundTargetPitch: number;
  lookAroundUntilMs: number;
  nextLookAroundMs: number;
  // Last "user activity" timestamp (for idle detection).
  lastInteractionMs: number;
  // Whether a greet wave has been issued for the current VRM.
  greeted: boolean;
}

export function createAutoCycleState(avatarId: string | null, nowMs: number): AutoCycleState {
  const personality = getAvatarPersonality(avatarId);
  return {
    avatarId,
    personality,
    currentClipPerState: new Map(),
    nextIdleSwapMs: nowMs + sampleExponentialSeconds(personality.idleSwapMeanSeconds) * 1000,
    activeExpression: null,
    lastExpressionId: null,
    nextExpressionMs: nowMs + sampleExponentialSeconds(personality.microExpressionMeanSeconds) * 1000,
    lookAroundTargetYaw: 0,
    lookAroundTargetPitch: 0,
    lookAroundUntilMs: 0,
    nextLookAroundMs: nowMs + sampleExponentialSeconds(personality.lookAroundMeanSeconds) * 1000,
    lastInteractionMs: nowMs,
    greeted: false,
  };
}

// Reset the scheduler when a new VRM loads. Preserves the avatarId-aware
// personality but clears all timers so the new avatar starts fresh.
export function resetForNewModel(state: AutoCycleState, avatarId: string | null, nowMs: number): AutoCycleState {
  const fresh = createAutoCycleState(avatarId, nowMs);
  // Preserve lastExpressionId across model swaps so we don't replay the
  // same micro-expression back-to-back.
  fresh.lastExpressionId = state.lastExpressionId;
  return fresh;
}

// Notify the scheduler of user activity (mouse move, click, voice-started,
// etc.). Resets the idle/look-around timers so the avatar doesn't drift
// off into rest-mode mid-conversation.
export function markUserActivity(state: AutoCycleState, nowMs: number): void {
  state.lastInteractionMs = nowMs;
  // Reschedule the next look-around further out.
  state.nextLookAroundMs = nowMs + sampleExponentialSeconds(state.personality.lookAroundMeanSeconds) * 1000;
}

interface TickContext {
  player: LocalVrmaPlayer | null;
  state: AutoCycleState;
  // Current motion state from the AvatarMotionState reducer.
  currentMotionState: AvatarMotionState;
  // Whether the avatar can accept built-in clips for the current state.
  // (False during voice/speaking because lip-sync + voice gesture own the body.)
  acceptBuiltInForState: boolean;
  profile: AvatarCompatibilityProfile;
  capabilities: AvatarCapabilities;
  nowMs: number;
  deltaSeconds: number;
}

export interface AutoCycleTickResult {
  // If an anime expression is active, this is its current sample.
  expressionSample: AnimeExpressionSample | null;
  // Head rotation deltas (radians) to apply on top of the base motion pose.
  headYawDelta: number;
  headPitchDelta: number;
  headRollDelta: number;
  // Suggested blink-rate multiplier (drives the blink timer in the renderer).
  blinkRateScale: number;
  // Whether the scheduler swapped the active clip this tick.
  swappedClip: boolean;
}

const IDLE_STATES: ReadonlySet<AvatarMotionState> = new Set([
  'idle', 'bored', 'rest', 'listening', 'thinking', 'wake', 'enter',
]);

// Decide whether built-in clips are appropriate for the current motion state.
// During speaking we always defer to procedural lip-sync + gesture.
function shouldAcceptBuiltInForState(state: AvatarMotionState): boolean {
  return state !== 'speaking';
}

// Map a motion state to the personality pool it should draw from.
function poolForState(state: AvatarMotionState, p: AvatarPersonality): BuiltInAnimationId[] {
  switch (state) {
    case 'celebrate':
      return p.celebratePool.length > 0 ? p.celebratePool : (BUILT_IN_ANIMATIONS_BY_STATE.celebrate ?? []);
    case 'gesture':
      return p.gesturePool.length > 0 ? p.gesturePool : (BUILT_IN_ANIMATIONS_BY_STATE.gesture ?? []);
    case 'rest':
    case 'bored':
      return p.restPool.length > 0 ? p.restPool : (BUILT_IN_ANIMATIONS_BY_STATE.rest ?? []);
    case 'wake':
    case 'enter':
      return [p.preferredEnterAnimation];
    case 'idle':
    case 'listening':
    case 'thinking':
    default:
      return p.idlePool.length > 0 ? p.idlePool : (BUILT_IN_ANIMATIONS_BY_STATE.idle ?? []);
  }
}

/**
 * Install the initial built-in clip for a state if none is installed yet.
 * Called when the motion state changes (so a clip is always ready before
 * the player's setState() triggers a fade-in).
 */
export function ensureBuiltInForState(
  state: AutoCycleState,
  player: LocalVrmaPlayer,
  motionState: AvatarMotionState,
): void {
  if (!shouldAcceptBuiltInForState(motionState)) return;
  if (player.getBuiltInClipId(motionState)) return;
  const pool = poolForState(motionState, state.personality);
  if (pool.length === 0) return;
  const id = pool[0];
  const anim = getBuiltInAnimation(id);
  player.installBuiltInClip(motionState, anim.clip, id, { activate: false });
  state.currentClipPerState.set(motionState, id);
}

/**
 * Trigger a one-shot greeting animation on first VRM load. Returns true
 * if a greeting was issued, false if the personality chose not to greet
 * or a greeting was already issued.
 */
export function tryIssueGreeting(
  state: AutoCycleState,
  player: LocalVrmaPlayer,
): boolean {
  if (state.greeted) return false;
  state.greeted = true;
  if (Math.random() > state.personality.greetOnLoadProbability) return false;
  const greetingId = state.personality.preferredEnterAnimation;
  const anim = getBuiltInAnimation(greetingId);
  // Install under the 'gesture' state slot so the existing reducer flow
  // can naturally return to 'idle' afterwards.
  player.installBuiltInClip('gesture', anim.clip, greetingId, { activate: false });
  state.currentClipPerState.set('gesture', greetingId);
  return true;
}

/**
 * Main tick. Drives idle-variety swaps, anime-expression pulses, and
 * look-around head turns. Must be called every frame from useFrame.
 */
export function tickAutoCycle(ctx: TickContext): AutoCycleTickResult {
  const { state, player, currentMotionState, nowMs } = ctx;
  const result: AutoCycleTickResult = {
    expressionSample: null,
    headYawDelta: 0,
    headPitchDelta: 0,
    headRollDelta: 0,
    blinkRateScale: state.personality.blinkRateScale,
    swappedClip: false,
  };

  // ── Idle-variety swap ────────────────────────────────────────────────
  if (
    player &&
    IDLE_STATES.has(currentMotionState) &&
    nowMs >= state.nextIdleSwapMs &&
    ctx.acceptBuiltInForState
  ) {
    const pool = poolForState(currentMotionState, state.personality);
    if (pool.length > 1) {
      const current = state.currentClipPerState.get(currentMotionState);
      const nextId = pickRandom(pool, current);
      if (nextId !== current) {
        const anim = getBuiltInAnimation(nextId);
        player.swapBuiltInClip(currentMotionState, anim.clip, nextId, anim.crossfadeSeconds);
        state.currentClipPerState.set(currentMotionState, nextId);
        result.swappedClip = true;
      }
    }
    state.nextIdleSwapMs = nowMs + sampleExponentialSeconds(state.personality.idleSwapMeanSeconds) * 1000;
  }

  // ── Anime-expression pulse ───────────────────────────────────────────
  // First, evaluate an already-active expression (if any) so its sample
  // is returned on the same tick it was triggered.
  if (state.activeExpression) {
    const sample = evalExpressionEnvelope(state.activeExpression, nowMs);
    result.expressionSample = sample;
    const rot = headGestureToRotationDelta(sample.headGesture, sample.envelope);
    result.headPitchDelta += rot.pitch;
    result.headYawDelta += rot.yaw;
    result.headRollDelta += rot.roll;
    if (sample.finished) {
      state.lastExpressionId = state.activeExpression.id;
      state.activeExpression = null;
      state.nextExpressionMs = nowMs + sampleExponentialSeconds(state.personality.microExpressionMeanSeconds) * 1000;
    }
  }

  if (!state.activeExpression && nowMs >= state.nextExpressionMs) {
    // Trigger a new expression. Suppress during speaking — let lip-sync own the face.
    if (currentMotionState !== 'speaking') {
      const exclude = state.lastExpressionId
        ? new Set<string>([state.lastExpressionId])
        : new Set<string>();
      const id = pickWeightedExpression(exclude as ReadonlySet<AnimeExpressionId>);
      const pulse = ANIME_EXPRESSIONS[id];
      // Shorten the duration slightly during listening / thinking so the
      // expression doesn't fight the conversation cadence.
      const durationScale =
        currentMotionState === 'listening' ? 0.7 :
        currentMotionState === 'thinking' ? 0.85 :
        1.0;
      state.activeExpression = {
        id,
        startedAtMs: nowMs,
        durationSeconds: pulse.durationSeconds * durationScale,
      };
      // Evaluate the freshly-triggered expression this same tick so the
      // renderer sees a non-null sample immediately.
      const sample = evalExpressionEnvelope(state.activeExpression, nowMs);
      result.expressionSample = sample;
      const rot = headGestureToRotationDelta(sample.headGesture, sample.envelope);
      result.headPitchDelta += rot.pitch;
      result.headYawDelta += rot.yaw;
      result.headRollDelta += rot.roll;
    }
    // Always reschedule (even if we skipped this slot) so we don't spin.
    state.nextExpressionMs = nowMs + sampleExponentialSeconds(state.personality.microExpressionMeanSeconds) * 1000;
  }

  // ── Look-around (head turn) ─────────────────────────────────────────
  // Only fires when the user has been idle for a few seconds. Pick a
  // random yaw/pitch, hold for ~1.5s, then return.
  const idleFor = nowMs - state.lastInteractionMs;
  if (idleFor > 4000 && nowMs >= state.nextLookAroundMs) {
    const yaw = (Math.random() - 0.5) * 0.6;  // ±0.3 rad ~ ±17°
    const pitch = (Math.random() - 0.5) * 0.2; // ±0.1 rad ~ ±6°
    state.lookAroundTargetYaw = yaw;
    state.lookAroundTargetPitch = pitch;
    state.lookAroundUntilMs = nowMs + 1200 + Math.random() * 600;
    state.nextLookAroundMs = state.lookAroundUntilMs + sampleExponentialSeconds(state.personality.lookAroundMeanSeconds) * 1000;
  }
  // Apply the look-around target as a smooth delta while it's active.
  if (nowMs < state.lookAroundUntilMs) {
    const remaining = (state.lookAroundUntilMs - nowMs) / 1500;
    const intensity = Math.max(0, Math.min(1, remaining)) * 0.6;
    result.headYawDelta += state.lookAroundTargetYaw * intensity;
    result.headPitchDelta += state.lookAroundTargetPitch * intensity;
  }

  return result;
}

/**
 * Manually trigger a gesture (used for click-on-avatar interaction).
 * Returns true if the gesture was issued.
 */
export function triggerGesture(
  state: AutoCycleState,
  player: LocalVrmaPlayer,
  gestureId: BuiltInAnimationId,
): boolean {
  const anim = getBuiltInAnimation(gestureId);
  player.installBuiltInClip('gesture', anim.clip, gestureId, {
    crossfadeSeconds: anim.crossfadeSeconds,
    activate: true,
  });
  state.currentClipPerState.set('gesture', gestureId);
  markUserActivity(state, Date.now());
  return true;
}
