// Avatar motion foundation.
// Views own rendering and input; this module owns the deterministic state
// transitions that later VRMA clips will consume.

export type AvatarMotionState =
  | 'enter'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'celebrate'
  | 'gesture'
  | 'bored'
  | 'rest'
  | 'wake';

export interface AvatarMotionSnapshot {
  state: AvatarMotionState;
  stateStartedAtMs: number;
  lastInteractionAtMs: number;
}

export type AvatarMotionEvent =
  | { type: 'model-loaded'; nowMs: number }
  | { type: 'voice-started'; nowMs: number }
  | { type: 'voice-ended'; nowMs: number }
  | { type: 'thinking'; nowMs: number }
  | { type: 'celebrate'; nowMs: number }
  | { type: 'gesture'; nowMs: number }
  | { type: 'user-tap'; nowMs: number }
  | { type: 'tick'; nowMs: number };

export const AVATAR_MOTION_TIMING = {
  enterMs: 1_500,
  wakeMs: 550,
  celebrateMs: 2_800,
  gestureMs: 1_400,
  idleToBoredMs: 90_000,
  boredToRestMs: 35_000,
} as const;

export function createAvatarMotionSnapshot(nowMs: number): AvatarMotionSnapshot {
  return {
    state: 'enter',
    stateStartedAtMs: nowMs,
    lastInteractionAtMs: nowMs,
  };
}

function transition(
  previous: AvatarMotionSnapshot,
  state: AvatarMotionState,
  nowMs: number,
  markInteraction = false,
): AvatarMotionSnapshot {
  if (previous.state === state && !markInteraction) return previous;
  return {
    state,
    stateStartedAtMs: nowMs,
    lastInteractionAtMs: markInteraction ? nowMs : previous.lastInteractionAtMs,
  };
}

export function reduceAvatarMotion(
  previous: AvatarMotionSnapshot,
  event: AvatarMotionEvent,
): AvatarMotionSnapshot {
  const { nowMs } = event;

  switch (event.type) {
    case 'model-loaded':
      return transition(previous, 'enter', nowMs, true);
    case 'voice-started':
      return transition(previous, 'listening', nowMs, true);
    case 'voice-ended':
      return transition(previous, 'idle', nowMs, true);
    case 'thinking':
      return transition(previous, 'thinking', nowMs, true);
    case 'celebrate':
      return transition(previous, 'celebrate', nowMs, true);
    case 'gesture':
      return transition(previous, 'gesture', nowMs, true);
    case 'user-tap':
      return transition(previous, previous.state === 'rest' || previous.state === 'bored' ? 'wake' : 'idle', nowMs, true);
    case 'tick': {
      const stateAge = nowMs - previous.stateStartedAtMs;
      const idleAge = nowMs - previous.lastInteractionAtMs;

      if (previous.state === 'enter' && stateAge >= AVATAR_MOTION_TIMING.enterMs) {
        return transition(previous, 'idle', nowMs);
      }
      if (previous.state === 'wake' && stateAge >= AVATAR_MOTION_TIMING.wakeMs) {
        return transition(previous, 'idle', nowMs);
      }
      if ((previous.state === 'celebrate' && stateAge >= AVATAR_MOTION_TIMING.celebrateMs) || (previous.state === 'gesture' && stateAge >= AVATAR_MOTION_TIMING.gestureMs)) {
        return transition(previous, 'idle', nowMs);
      }
      if (previous.state === 'idle' && idleAge >= AVATAR_MOTION_TIMING.idleToBoredMs) {
        return transition(previous, 'bored', nowMs);
      }
      if (previous.state === 'bored' && stateAge >= AVATAR_MOTION_TIMING.boredToRestMs) {
        return transition(previous, 'rest', nowMs);
      }
      return previous;
    }
  }
}

export const AVATAR_MOTION_EXPRESSION_TARGETS: Record<AvatarMotionState, Record<string, number>> = {
  enter: { relaxed: 0.18 },
  idle: {},
  listening: { relaxed: 0.12 },
  thinking: { relaxed: 0.28 },
  speaking: { happy: 0.08 },
  celebrate: { happy: 0.82 },
  gesture: { happy: 0.22 },
  bored: { sad: 0.1 },
  rest: { relaxed: 0.2 },
  wake: { surprised: 0.16 },
};

export interface AvatarMotionPose {
  verticalOffset: number;
  pitchOffset: number;
  yawOffset: number;
}

export function getAvatarMotionPose(state: AvatarMotionState, elapsedSeconds: number): AvatarMotionPose {
  const breathe = Math.sin(elapsedSeconds * 0.5);
  const sway = Math.sin(elapsedSeconds * 0.3);

  switch (state) {
    case 'enter':
      return { verticalOffset: -0.035 + Math.min(0.035, elapsedSeconds * 0.025), pitchOffset: -0.035, yawOffset: 0.08 };
    case 'listening':
      return { verticalOffset: breathe * 0.012, pitchOffset: 0.018 + sway * 0.006, yawOffset: 0 };
    case 'thinking':
      return { verticalOffset: breathe * 0.01, pitchOffset: -0.012, yawOffset: 0.07 + sway * 0.02 };
    case 'celebrate':
      return { verticalOffset: Math.abs(Math.sin(elapsedSeconds * 4)) * 0.025, pitchOffset: 0, yawOffset: sway * 0.06 };
    case 'gesture':
      return { verticalOffset: breathe * 0.015, pitchOffset: 0, yawOffset: sway * 0.1 };
    case 'bored':
      return { verticalOffset: -0.012 + breathe * 0.006, pitchOffset: -0.03, yawOffset: sway * 0.012 };
    case 'rest':
      return { verticalOffset: -0.02 + breathe * 0.004, pitchOffset: -0.05, yawOffset: 0 };
    case 'wake':
      return { verticalOffset: 0.018, pitchOffset: 0.05, yawOffset: 0 };
    case 'speaking':
    case 'idle':
    default:
      return { verticalOffset: breathe * 0.02, pitchOffset: sway * 0.01, yawOffset: Math.sin(elapsedSeconds * 0.1) * 0.05 };
  }
}
