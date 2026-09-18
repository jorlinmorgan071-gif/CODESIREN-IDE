// app/src/lib/avatar-animation-triggers.ts
//
// Animation trigger system — provides explicit, semantic triggers that
// the UI layer can call to drive the avatar's behaviour. This replaces
// the previous "auto-cycle does everything" approach with clear,
// named triggers that match user-visible events:
//
//   triggerAvatarSwitch()   — user picked a different avatar in the picker
//   triggerIdleEnter()      — avatar entered the idle motion state
//   triggerUserTap()        — user clicked on the avatar
//   triggerVoiceStart()     — voice session started (listening)
//   triggerVoiceEnd()       — voice session ended (return to idle)
//   triggerEmotion()        — emotion changed (happy, sad, surprised, etc.)
//
// Each trigger:
//   1. Updates the AutoCycleState (motion state, timers, greeted flag).
//   2. Installs the appropriate built-in clip into the player.
//   3. Activates the clip with a smooth crossfade.
//
// The renderer (FaceView, AvatarOverlay, InteractionBubble) calls these
// triggers in response to user events, and the auto-cycle scheduler
// continues to tick every frame for idle variety + anime expressions.

import type { LocalVrmaPlayer } from './vrma-player';
import type { AvatarMotionState } from './avatar-motion';
import type { AutoCycleState } from './avatar-auto-cycle';
import type { AvatarPersonality } from './avatar-personality';
import {
  getBuiltInAnimation,
  type BuiltInAnimationId,
} from './built-in-animations';
import {
  pickRandom,
  sampleExponentialSeconds,
} from './avatar-personality';

// ── Crossfade durations ──────────────────────────────────────────────
//
// Tuned for fluid motion — long enough to avoid pops, short enough to
// feel responsive. The previous value (0.22s) was too short and made
// every transition feel snappy/jarring.
export const CROSSFADE = {
  // State-to-state transitions (e.g. idle → gesture → idle).
  state: 0.55,
  // Idle variety swaps — same state, different clip. Longer because
  // the avatar is just chilling and the swap should be invisible.
  idleSwap: 0.9,
  // Greeting on avatar switch — short so the wave starts quickly.
  greeting: 0.35,
  // Emotion change — blendshapes only, fast.
  emotion: 0.25,
  // Return to idle from any other state.
  returnToIdle: 0.65,
} as const;

// ── Trigger results ───────────────────────────────────────────────────

export interface TriggerResult {
  /** The motion state the avatar is now in. */
  motionState: AvatarMotionState;
  /** The clip id that was activated (if any). */
  clipId: BuiltInAnimationId | null;
  /** The crossfade duration used (seconds). */
  crossfadeSeconds: number;
  /** Whether the trigger actually changed anything. */
  changed: boolean;
}

const NO_CHANGE: TriggerResult = {
  motionState: 'idle',
  clipId: null,
  crossfadeSeconds: 0,
  changed: false,
};

// ── Helpers ───────────────────────────────────────────────────────────

function pickIdleFromPool(personality: AvatarPersonality, exclude?: BuiltInAnimationId): BuiltInAnimationId {
  const pool = personality.idlePool.length > 0
    ? personality.idlePool
    : (['standing-idle', 'catwalk-idle-twist-l', 'catwalk-idle-twist-r'] as BuiltInAnimationId[]);
  return pickRandom(pool, exclude);
}

function pickGestureFromPool(personality: AvatarPersonality, exclude?: BuiltInAnimationId): BuiltInAnimationId {
  const pool = personality.gesturePool.length > 0
    ? personality.gesturePool
    : (['waving', 'looking-behind'] as BuiltInAnimationId[]);
  return pickRandom(pool, exclude);
}

function pickCelebrateFromPool(personality: AvatarPersonality, exclude?: BuiltInAnimationId): BuiltInAnimationId {
  const pool = personality.celebratePool.length > 0
    ? personality.celebratePool
    : (['excited', 'silly-dancing', 'macarena-dance'] as BuiltInAnimationId[]);
  return pickRandom(pool, exclude);
}

function pickRestFromPool(personality: AvatarPersonality, exclude?: BuiltInAnimationId): BuiltInAnimationId {
  const pool = personality.restPool.length > 0
    ? personality.restPool
    : (['standing-idle', 'praying'] as BuiltInAnimationId[]);
  return pickRandom(pool, exclude);
}

function installAndActivate(
  player: LocalVrmaPlayer,
  state: AutoCycleState,
  motionState: AvatarMotionState,
  clipId: BuiltInAnimationId,
  crossfadeSeconds: number,
): TriggerResult {
  const anim = getBuiltInAnimation(clipId);
  player.installBuiltInClip(motionState, anim.clip, clipId, {
    crossfadeSeconds,
    activate: true,
  });
  state.currentClipPerState.set(motionState, clipId);
  return {
    motionState,
    clipId,
    crossfadeSeconds,
    changed: true,
  };
}

// ── Triggers ──────────────────────────────────────────────────────────

/**
 * Trigger a greeting animation when the user switches to a different
 * avatar in the picker. The greeting is a wave (or the avatar's
 * preferred enter animation), played under the 'gesture' motion state.
 *
 * After the greeting finishes, the auto-cycle scheduler will transition
 * the avatar back to idle.
 *
 * This trigger is IDEMPOTENT — calling it twice in a row for the same
 * avatar id will only fire the greeting once. Pass `force=true` to
 * override this (e.g. for a "wave again" button).
 */
export function triggerAvatarSwitch(
  player: LocalVrmaPlayer,
  state: AutoCycleState,
  options: { force?: boolean } = {},
): TriggerResult {
  if (state.greeted && !options.force) return NO_CHANGE;
  state.greeted = true;

  // Pick the greeting clip — avatar's preferred enter animation, or
  // fall back to 'waving'.
  const greetingId = state.personality.preferredEnterAnimation ?? 'waving';
  return installAndActivate(player, state, 'gesture', greetingId, CROSSFADE.greeting);
}

/**
 * Trigger an idle animation when the avatar enters the idle motion
 * state. Picks a random clip from the personality's idle pool (with
 * a bias against repeating the last one), and activates it with a
 * smooth crossfade.
 *
 * Also resets the idle-variety-swap timer so the next swap happens
 * after a fresh exponential sample (3-12s depending on personality).
 */
export function triggerIdleEnter(
  player: LocalVrmaPlayer,
  state: AutoCycleState,
  nowMs: number,
): TriggerResult {
  const exclude = state.currentClipPerState.get('idle');
  const clipId = pickIdleFromPool(state.personality, exclude);
  // Reschedule the next idle swap.
  state.nextIdleSwapMs = nowMs + sampleExponentialSeconds(state.personality.idleSwapMeanSeconds) * 1000;
  return installAndActivate(player, state, 'idle', clipId, CROSSFADE.returnToIdle);
}

/**
 * Trigger a one-shot gesture (wave, look-behind, etc.) when the user
 * taps on the avatar. Picks a random gesture clip from the personality
 * pool. The avatar returns to idle when the gesture finishes.
 */
export function triggerUserTap(
  player: LocalVrmaPlayer,
  state: AutoCycleState,
  nowMs: number,
): TriggerResult {
  // Mark user activity so the look-around timer reschedules.
  state.lastInteractionMs = nowMs;
  state.nextLookAroundMs = nowMs + sampleExponentialSeconds(state.personality.lookAroundMeanSeconds) * 1000;

  const exclude = state.currentClipPerState.get('gesture');
  const clipId = pickGestureFromPool(state.personality, exclude);
  return installAndActivate(player, state, 'gesture', clipId, CROSSFADE.state);
}

/**
 * Trigger a celebrate animation when the user (or the agent) has cause
 * to celebrate — e.g. a successful build, a completed task, a positive
 * emotion from the chat.
 */
export function triggerCelebrate(
  player: LocalVrmaPlayer,
  state: AutoCycleState,
  nowMs: number,
): TriggerResult {
  state.lastInteractionMs = nowMs;
  const exclude = state.currentClipPerState.get('celebrate');
  const clipId = pickCelebrateFromPool(state.personality, exclude);
  return installAndActivate(player, state, 'celebrate', clipId, CROSSFADE.state);
}

/**
 * Trigger a rest animation when the user has been idle for a long time.
 * Picks from the personality's rest pool (praying, looking-behind, etc.).
 */
export function triggerRest(
  player: LocalVrmaPlayer,
  state: AutoCycleState,
): TriggerResult {
  const exclude = state.currentClipPerState.get('rest');
  const clipId = pickRestFromPool(state.personality, exclude);
  return installAndActivate(player, state, 'rest', clipId, CROSSFADE.state);
}

/**
 * Trigger a voice-start transition. The avatar enters the 'listening'
 * motion state, which uses a calmer idle clip.
 */
export function triggerVoiceStart(
  player: LocalVrmaPlayer,
  state: AutoCycleState,
  nowMs: number,
): TriggerResult {
  state.lastInteractionMs = nowMs;
  // Use an idle clip for listening — the auto-cycle scheduler will
  // continue to swap idles on its timer.
  const exclude = state.currentClipPerState.get('listening');
  const clipId = pickIdleFromPool(state.personality, exclude);
  return installAndActivate(player, state, 'listening', clipId, CROSSFADE.state);
}

/**
 * Trigger a voice-end transition. Returns the avatar to idle.
 */
export function triggerVoiceEnd(
  player: LocalVrmaPlayer,
  state: AutoCycleState,
  nowMs: number,
): TriggerResult {
  state.lastInteractionMs = nowMs;
  return triggerIdleEnter(player, state, nowMs);
}
