// app/src/lib/built-in-animations.ts
//
// Procedural animation library for VRM humanoid avatars.
//
// Instead of converting FBX files to VRMA, this module generates
// THREE.AnimationClip objects directly. Each clip targets the VRM
// humanoid bone names that @pixiv/three-vrm normalises — so a single
// clip retargets cleanly across VRM 0.x and VRM 1.0 models.
//
// Inspiration: the 11 Mixamo FBX files supplied by the user
//   (Waving, Standing Idle, Excited, Macarena Dance, Silly Dancing,
//    Praying, Northern Soul Spin Combo, Looking Behind, Catwalk
//    Idle Twist L/R, Catwalk Idle To Twist R).
//
// Each built-in animation is identified by a stable string id so it
// can be referenced from personality profiles and the auto-cycle
// scheduler without coupling to file paths.

import * as THREE from 'three';

export type BuiltInAnimationId =
  // Idle family (low energy)
  | 'standing-idle'
  | 'catwalk-idle-twist-l'
  | 'catwalk-idle-twist-r'
  | 'catwalk-idle-to-twist-r'
  | 'looking-behind'
  // Social family (medium energy)
  | 'waving'
  | 'praying'
  // High energy
  | 'excited'
  | 'macarena-dance'
  | 'silly-dancing'
  | 'northern-soul-spin-combo';

export interface BuiltInAnimation {
  id: BuiltInAnimationId;
  durationSeconds: number;
  clip: THREE.AnimationClip;
  // Recommended crossfade duration when entering this clip.
  crossfadeSeconds: number;
  // Energy level used by the scheduler to weight idle-time selection.
  energy: 'low' | 'medium' | 'high';
  // Which motion-state slot this clip can sit in (used to wire it to
  // the existing AvatarMotionState machine).
  defaultMotionState:
    | 'idle'
    | 'listening'
    | 'thinking'
    | 'celebrate'
    | 'gesture'
    | 'bored'
    | 'rest'
    | 'wake';
}

// VRM humanoid bone names — these are the canonical names that
// three-vrm exposes on its Humanoid component. We target them by
// track name in the form `<boneName>.position` / `<boneName>.quaternion`.
type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftLowerArm'
  | 'rightLowerArm'
  | 'leftHand'
  | 'rightHand'
  | 'leftUpperLeg'
  | 'rightUpperLeg'
  | 'leftLowerLeg'
  | 'rightLowerLeg'
  | 'leftFoot'
  | 'rightFoot'
  | 'leftToes'
  | 'rightToes';

interface KeyframeVec3 {
  time: number;
  value: [number, number, number];
}

interface KeyframeQuat {
  time: number;
  // [x, y, z, w]
  value: [number, number, number, number];
}

// Helper: build a Quaternion keyframe track.
function quatTrack(
  bone: BoneName,
  keyframes: KeyframeQuat[],
): THREE.VectorKeyframeTrack {
  const times: number[] = [];
  const values: number[] = [];
  for (const kf of keyframes) {
    times.push(kf.time);
    values.push(kf.value[0], kf.value[1], kf.value[2], kf.value[3]);
  }
  // `.quaternion` is the property name three.js AnimationMixer uses
  // for rotation tracks on Object3D nodes.
  return new THREE.VectorKeyframeTrack(
    `${bone}.quaternion`,
    times,
    values,
  );
}

// Helper: build a Vector3 (position) keyframe track.
function posTrack(
  bone: BoneName,
  keyframes: KeyframeVec3[],
): THREE.VectorKeyframeTrack {
  const times: number[] = [];
  const values: number[] = [];
  for (const kf of keyframes) {
    times.push(kf.time);
    values.push(kf.value[0], kf.value[1], kf.value[2]);
  }
  return new THREE.VectorKeyframeTrack(`${bone}.position`, times, values);
}

// Helper: convert Euler degrees to quaternion [x, y, z, w].
function eulerDeg(degX: number, degY: number, degZ: number): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(degX),
      THREE.MathUtils.degToRad(degY),
      THREE.MathUtils.degToRad(degZ),
      'XYZ',
    ),
  );
  return [q.x, q.y, q.z, q.w];
}

// Identity quaternion for "no rotation change" keyframes.
const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];

// ── Clip builders ───────────────────────────────────────────────────

// A relaxed standing idle with gentle breathing and subtle weight shift.
function buildStandingIdle(): THREE.AnimationClip {
  const duration = 6;
  const t = (s: number) => s;
  const hipsY: KeyframeVec3[] = [
    { time: t(0), value: [0, 0, 0] },
    { time: t(1.5), value: [0, 0.01, 0] },
    { time: t(3), value: [0, 0, 0] },
    { time: t(4.5), value: [0, -0.005, 0] },
    { time: t(6), value: [0, 0, 0] },
  ];
  const spineRot: KeyframeQuat[] = [
    { time: t(0), value: IDENTITY },
    { time: t(1.5), value: eulerDeg(1, 0, 0.5) },
    { time: t(3), value: IDENTITY },
    { time: t(4.5), value: eulerDeg(-1, 0, -0.5) },
    { time: t(6), value: IDENTITY },
  ];
  const headRot: KeyframeQuat[] = [
    { time: t(0), value: IDENTITY },
    { time: t(2), value: eulerDeg(0, 3, 1) },
    { time: t(4), value: eulerDeg(0, -3, -1) },
    { time: t(6), value: IDENTITY },
  ];
  const leftArmRot: KeyframeQuat[] = [
    { time: t(0), value: eulerDeg(0, 0, 5) },
    { time: t(3), value: eulerDeg(0, 0, 7) },
    { time: t(6), value: eulerDeg(0, 0, 5) },
  ];
  const rightArmRot: KeyframeQuat[] = [
    { time: t(0), value: eulerDeg(0, 0, -5) },
    { time: t(3), value: eulerDeg(0, 0, -7) },
    { time: t(6), value: eulerDeg(0, 0, -5) },
  ];
  return new THREE.AnimationClip('standing-idle', duration, [
    posTrack('hips', hipsY),
    quatTrack('spine', spineRot),
    quatTrack('head', headRot),
    quatTrack('leftUpperArm', leftArmRot),
    quatTrack('rightUpperArm', rightArmRot),
  ]);
}

// A catwalk-style idle that twists the hips and shoulders subtly, finishing
// on the right side. Mixamo name: "Catwalk Idle Twist R".
function buildCatwalkIdleTwistR(): THREE.AnimationClip {
  const duration = 5;
  const hipsRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1.25, value: eulerDeg(0, -4, 0) },
    { time: 2.5, value: IDENTITY },
    { time: 3.75, value: eulerDeg(0, 4, 0) },
    { time: 5, value: IDENTITY },
  ];
  const chestRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1.25, value: eulerDeg(0, 4, 0) },
    { time: 2.5, value: IDENTITY },
    { time: 3.75, value: eulerDeg(0, -4, 0) },
    { time: 5, value: IDENTITY },
  ];
  const headRot: KeyframeQuat[] = [
    { time: 0, value: eulerDeg(0, -2, 0) },
    { time: 2.5, value: eulerDeg(0, 5, 2) },
    { time: 5, value: eulerDeg(0, -2, 0) },
  ];
  return new THREE.AnimationClip('catwalk-idle-twist-r', duration, [
    quatTrack('hips', hipsRot),
    quatTrack('upperChest', chestRot),
    quatTrack('head', headRot),
  ]);
}

function buildCatwalkIdleTwistL(): THREE.AnimationClip {
  const duration = 5;
  const hipsRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1.25, value: eulerDeg(0, 4, 0) },
    { time: 2.5, value: IDENTITY },
    { time: 3.75, value: eulerDeg(0, -4, 0) },
    { time: 5, value: IDENTITY },
  ];
  const chestRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1.25, value: eulerDeg(0, -4, 0) },
    { time: 2.5, value: IDENTITY },
    { time: 3.75, value: eulerDeg(0, 4, 0) },
    { time: 5, value: IDENTITY },
  ];
  const headRot: KeyframeQuat[] = [
    { time: 0, value: eulerDeg(0, 2, 0) },
    { time: 2.5, value: eulerDeg(0, -5, -2) },
    { time: 5, value: eulerDeg(0, 2, 0) },
  ];
  return new THREE.AnimationClip('catwalk-idle-twist-l', duration, [
    quatTrack('hips', hipsRot),
    quatTrack('upperChest', chestRot),
    quatTrack('head', headRot),
  ]);
}

// Blend from neutral into the right-twist pose over the first second.
function buildCatwalkIdleToTwistR(): THREE.AnimationClip {
  const duration = 6;
  const hipsRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(0, -3, 0) },
    { time: 3, value: eulerDeg(0, -6, 0.5) },
    { time: 5, value: eulerDeg(0, -2, 0) },
    { time: 6, value: eulerDeg(0, -3, 0) },
  ];
  const chestRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(0, 3, 0) },
    { time: 3, value: eulerDeg(0, 6, -0.5) },
    { time: 5, value: eulerDeg(0, 2, 0) },
    { time: 6, value: eulerDeg(0, 3, 0) },
  ];
  const headRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 2, value: eulerDeg(0, 4, 3) },
    { time: 4, value: eulerDeg(0, -2, 0) },
    { time: 6, value: eulerDeg(0, 0, 0) },
  ];
  const rightArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1.5, value: eulerDeg(0, 0, -8) },
    { time: 3, value: eulerDeg(0, 0, -12) },
    { time: 5, value: eulerDeg(0, 0, -6) },
    { time: 6, value: eulerDeg(0, 0, -8) },
  ];
  return new THREE.AnimationClip('catwalk-idle-to-twist-r', duration, [
    quatTrack('hips', hipsRot),
    quatTrack('upperChest', chestRot),
    quatTrack('head', headRot),
    quatTrack('rightUpperArm', rightArmRot),
  ]);
}

// Looking behind — head + chest rotate to one side as if checking
// over the shoulder, then return. Mixamo name: "Looking Behind".
function buildLookingBehind(): THREE.AnimationClip {
  const duration = 5;
  const chestRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1.25, value: eulerDeg(0, 25, 2) },
    { time: 2.5, value: eulerDeg(0, 30, 1) },
    { time: 3.75, value: eulerDeg(0, 20, 0) },
    { time: 5, value: IDENTITY },
  ];
  const headRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1.25, value: eulerDeg(-5, 35, 5) },
    { time: 2.5, value: eulerDeg(-3, 40, 3) },
    { time: 3.75, value: eulerDeg(-2, 25, 0) },
    { time: 5, value: IDENTITY },
  ];
  const hipsRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1.25, value: eulerDeg(0, 10, 0) },
    { time: 2.5, value: eulerDeg(0, 15, 0) },
    { time: 3.75, value: eulerDeg(0, 8, 0) },
    { time: 5, value: IDENTITY },
  ];
  const leftArmRot: KeyframeQuat[] = [
    { time: 0, value: eulerDeg(0, 0, 5) },
    { time: 2.5, value: eulerDeg(0, 20, 10) },
    { time: 5, value: eulerDeg(0, 0, 5) },
  ];
  return new THREE.AnimationClip('looking-behind', duration, [
    quatTrack('hips', hipsRot),
    quatTrack('upperChest', chestRot),
    quatTrack('head', headRot),
    quatTrack('leftUpperArm', leftArmRot),
  ]);
}

// A friendly waving gesture — right arm raises and pivots, hand waves
// back-and-forth twice, then returns. Mixamo name: "Waving".
function buildWaving(): THREE.AnimationClip {
  const duration = 4;
  const rightUpperArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 0.4, value: eulerDeg(0, -30, -100) },
    { time: 0.8, value: eulerDeg(0, -25, -110) },
    { time: 1.2, value: eulerDeg(0, -35, -95) },
    { time: 1.6, value: eulerDeg(0, -25, -110) },
    { time: 2.0, value: eulerDeg(0, -35, -95) },
    { time: 2.4, value: eulerDeg(0, -25, -110) },
    { time: 3.0, value: eulerDeg(0, -30, -100) },
    { time: 4.0, value: IDENTITY },
  ];
  const rightLowerArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 0.4, value: eulerDeg(-10, 0, 20) },
    { time: 0.8, value: eulerDeg(-30, 0, 0) },
    { time: 1.2, value: eulerDeg(0, 0, 30) },
    { time: 1.6, value: eulerDeg(-30, 0, 0) },
    { time: 2.0, value: eulerDeg(0, 0, 30) },
    { time: 2.4, value: eulerDeg(-30, 0, 0) },
    { time: 3.0, value: eulerDeg(-10, 0, 20) },
    { time: 4.0, value: IDENTITY },
  ];
  const rightShoulderRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 0.4, value: eulerDeg(0, 0, -10) },
    { time: 3.0, value: eulerDeg(0, 0, -10) },
    { time: 4.0, value: IDENTITY },
  ];
  const headRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(0, -5, -3) },
    { time: 2, value: eulerDeg(0, 5, 3) },
    { time: 4, value: IDENTITY },
  ];
  return new THREE.AnimationClip('waving', duration, [
    quatTrack('rightUpperArm', rightUpperArmRot),
    quatTrack('rightLowerArm', rightLowerArmRot),
    quatTrack('rightShoulder', rightShoulderRot),
    quatTrack('head', headRot),
  ]);
}

// Hands clasped in front, gentle rise and fall of the chest as if
// breathing in prayer. Mixamo name: "Praying".
function buildPraying(): THREE.AnimationClip {
  const duration = 6;
  const leftUpperArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(0, 35, 25) },
    { time: 6, value: eulerDeg(0, 35, 25) },
  ];
  const rightUpperArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(0, -35, -25) },
    { time: 6, value: eulerDeg(0, -35, -25) },
  ];
  const leftLowerArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(-70, 10, 50) },
    { time: 6, value: eulerDeg(-70, 10, 50) },
  ];
  const rightLowerArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(-70, -10, -50) },
    { time: 6, value: eulerDeg(-70, -10, -50) },
  ];
  const chestRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1.5, value: eulerDeg(2, 0, 0) },
    { time: 3, value: IDENTITY },
    { time: 4.5, value: eulerDeg(2, 0, 0) },
    { time: 6, value: IDENTITY },
  ];
  const headRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(10, 0, 0) },
    { time: 5, value: eulerDeg(10, 0, 0) },
    { time: 6, value: IDENTITY },
  ];
  return new THREE.AnimationClip('praying', duration, [
    quatTrack('leftUpperArm', leftUpperArmRot),
    quatTrack('rightUpperArm', rightUpperArmRot),
    quatTrack('leftLowerArm', leftLowerArmRot),
    quatTrack('rightLowerArm', rightLowerArmRot),
    quatTrack('upperChest', chestRot),
    quatTrack('head', headRot),
  ]);
}

// Excited — quick arm pumps and small bouncy hops. Mixamo name: "Excited".
function buildExcited(): THREE.AnimationClip {
  const duration = 4;
  const hipsY: KeyframeVec3[] = [];
  const leftUpperArmRot: KeyframeQuat[] = [];
  const rightUpperArmRot: KeyframeQuat[] = [];
  for (let i = 0; i <= duration * 2; i++) {
    const t = i / 2;
    hipsY.push({ time: t, value: [0, Math.abs(Math.sin(t * Math.PI)) * 0.05, 0] });
    leftUpperArmRot.push({ time: t, value: eulerDeg(0, 0, 50 + Math.sin(t * Math.PI * 2) * 30) });
    rightUpperArmRot.push({ time: t, value: eulerDeg(0, 0, -50 - Math.sin(t * Math.PI * 2) * 30) });
  }
  const headRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 0.5, value: eulerDeg(0, 5, 3) },
    { time: 1, value: eulerDeg(0, -5, -3) },
    { time: 1.5, value: eulerDeg(0, 5, 3) },
    { time: 2, value: eulerDeg(0, -5, -3) },
    { time: 2.5, value: eulerDeg(0, 5, 3) },
    { time: 3, value: eulerDeg(0, -5, -3) },
    { time: 4, value: IDENTITY },
  ];
  return new THREE.AnimationClip('excited', duration, [
    posTrack('hips', hipsY),
    quatTrack('leftUpperArm', leftUpperArmRot),
    quatTrack('rightUpperArm', rightUpperArmRot),
    quatTrack('head', headRot),
  ]);
}

// Macarena dance — classic arm-pose sequence.
function buildMacarenaDance(): THREE.AnimationClip {
  const duration = 8;
  // Each pose lasts ~1s, sequence loops once then returns to neutral.
  // Right arm out, left arm out, right to chest, left to chest,
  // right to hip, left to hip, right behind head, left behind head.
  const poseTimes = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const leftArmPoses: [number, number, number][] = [
    [0, 0, 5],
    [0, 0, 5],
    [0, -90, 30],   // left arm out
    [0, -90, 30],
    [-90, 0, 50],   // left hand to chest
    [-90, 0, 50],
    [0, 0, 30],     // left hand to hip
    [0, 0, 30],
  ];
  const rightArmPoses: [number, number, number][] = [
    [0, 0, -5],
    [0, 90, -30],   // right arm out
    [0, 90, -30],
    [-90, 0, -50],  // right hand to chest
    [-90, 0, -50],
    [0, 0, -30],    // right hand to hip
    [0, 0, -30],
    [-120, 0, 10],  // right behind head
  ];
  const leftArmRot: KeyframeQuat[] = poseTimes.map((time, i) => ({
    time,
    value: i < leftArmPoses.length
      ? eulerDeg(...leftArmPoses[i])
      : IDENTITY,
  }));
  const rightArmRot: KeyframeQuat[] = poseTimes.map((time, i) => ({
    time,
    value: i < rightArmPoses.length
      ? eulerDeg(...rightArmPoses[i])
      : IDENTITY,
  }));
  // And also the left behind-head pose at t=7
  leftArmRot[7] = { time: 7, value: eulerDeg(-120, 0, 10) };
  const hipsRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(0, 5, 0) },
    { time: 2, value: eulerDeg(0, -5, 0) },
    { time: 3, value: eulerDeg(0, 5, 0) },
    { time: 4, value: eulerDeg(0, -5, 0) },
    { time: 5, value: eulerDeg(0, 5, 0) },
    { time: 6, value: eulerDeg(0, -5, 0) },
    { time: 7, value: eulerDeg(0, 5, 0) },
    { time: 8, value: IDENTITY },
  ];
  return new THREE.AnimationClip('macarena-dance', duration, [
    quatTrack('leftUpperArm', leftArmRot),
    quatTrack('rightUpperArm', rightArmRot),
    quatTrack('hips', hipsRot),
  ]);
}

// Silly dancing — wobbly, loose arms with hip sways and head bobs.
function buildSillyDancing(): THREE.AnimationClip {
  const duration = 6;
  const sampleCount = 13;
  const hipsRot: KeyframeQuat[] = [];
  const chestRot: KeyframeQuat[] = [];
  const headRot: KeyframeQuat[] = [];
  const leftArmRot: KeyframeQuat[] = [];
  const rightArmRot: KeyframeQuat[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const t = (i / (sampleCount - 1)) * duration;
    const phase = (t / duration) * Math.PI * 4;
    hipsRot.push({ time: t, value: eulerDeg(0, Math.sin(phase) * 8, Math.sin(phase * 0.5) * 3) });
    chestRot.push({ time: t, value: eulerDeg(Math.sin(phase * 0.7) * 4, -Math.sin(phase) * 6, 0) });
    headRot.push({ time: t, value: eulerDeg(Math.sin(phase * 1.3) * 5, Math.cos(phase * 0.9) * 10, Math.sin(phase * 0.6) * 4) });
    // Loose arms flopping around
    leftArmRot.push({ time: t, value: eulerDeg(Math.sin(phase * 1.1) * 25, Math.cos(phase * 0.8) * 15, 30 + Math.sin(phase) * 40) });
    rightArmRot.push({ time: t, value: eulerDeg(Math.sin(phase * 1.1 + 1) * 25, Math.cos(phase * 0.8 + 1) * 15, -30 - Math.sin(phase + 0.5) * 40) });
  }
  return new THREE.AnimationClip('silly-dancing', duration, [
    quatTrack('hips', hipsRot),
    quatTrack('upperChest', chestRot),
    quatTrack('head', headRot),
    quatTrack('leftUpperArm', leftArmRot),
    quatTrack('rightUpperArm', rightArmRot),
  ]);
}

// Northern Soul Spin Combo — a full 360° spin with arm sweep.
function buildNorthernSoulSpinCombo(): THREE.AnimationClip {
  const duration = 4;
  const hipsRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(0, 90, 0) },
    { time: 2, value: eulerDeg(0, 180, 0) },
    { time: 3, value: eulerDeg(0, 270, 0) },
    { time: 4, value: eulerDeg(0, 360, 0) },
  ];
  const leftUpperArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 0.5, value: eulerDeg(0, 0, 90) },
    { time: 2, value: eulerDeg(0, 0, 100) },
    { time: 3.5, value: eulerDeg(0, 0, 60) },
    { time: 4, value: IDENTITY },
  ];
  const rightUpperArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 0.5, value: eulerDeg(0, 0, -90) },
    { time: 2, value: eulerDeg(0, 0, -100) },
    { time: 3.5, value: eulerDeg(0, 0, -60) },
    { time: 4, value: IDENTITY },
  ];
  const leftLowerArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(-40, 0, 0) },
    { time: 3, value: eulerDeg(-40, 0, 0) },
    { time: 4, value: IDENTITY },
  ];
  const rightLowerArmRot: KeyframeQuat[] = [
    { time: 0, value: IDENTITY },
    { time: 1, value: eulerDeg(-40, 0, 0) },
    { time: 3, value: eulerDeg(-40, 0, 0) },
    { time: 4, value: IDENTITY },
  ];
  return new THREE.AnimationClip('northern-soul-spin-combo', duration, [
    quatTrack('hips', hipsRot),
    quatTrack('leftUpperArm', leftUpperArmRot),
    quatTrack('rightUpperArm', rightUpperArmRot),
    quatTrack('leftLowerArm', leftLowerArmRot),
    quatTrack('rightLowerArm', rightLowerArmRot),
  ]);
}

// ── Registry ────────────────────────────────────────────────────────

const builders: Record<BuiltInAnimationId, () => THREE.AnimationClip> = {
  'standing-idle': buildStandingIdle,
  'catwalk-idle-twist-l': buildCatwalkIdleTwistL,
  'catwalk-idle-twist-r': buildCatwalkIdleTwistR,
  'catwalk-idle-to-twist-r': buildCatwalkIdleToTwistR,
  'looking-behind': buildLookingBehind,
  'waving': buildWaving,
  'praying': buildPraying,
  'excited': buildExcited,
  'macarena-dance': buildMacarenaDance,
  'silly-dancing': buildSillyDancing,
  'northern-soul-spin-combo': buildNorthernSoulSpinCombo,
};

const METADATA: Record<BuiltInAnimationId, Omit<BuiltInAnimation, 'id' | 'clip'>> = {
  'standing-idle': { durationSeconds: 6, crossfadeSeconds: 0.5, energy: 'low', defaultMotionState: 'idle' },
  'catwalk-idle-twist-l': { durationSeconds: 5, crossfadeSeconds: 0.55, energy: 'low', defaultMotionState: 'idle' },
  'catwalk-idle-twist-r': { durationSeconds: 5, crossfadeSeconds: 0.55, energy: 'low', defaultMotionState: 'idle' },
  'catwalk-idle-to-twist-r': { durationSeconds: 6, crossfadeSeconds: 0.6, energy: 'low', defaultMotionState: 'idle' },
  'looking-behind': { durationSeconds: 5, crossfadeSeconds: 0.6, energy: 'low', defaultMotionState: 'gesture' },
  'waving': { durationSeconds: 4, crossfadeSeconds: 0.45, energy: 'medium', defaultMotionState: 'gesture' },
  'praying': { durationSeconds: 6, crossfadeSeconds: 0.7, energy: 'medium', defaultMotionState: 'rest' },
  'excited': { durationSeconds: 4, crossfadeSeconds: 0.35, energy: 'high', defaultMotionState: 'celebrate' },
  'macarena-dance': { durationSeconds: 8, crossfadeSeconds: 0.5, energy: 'high', defaultMotionState: 'celebrate' },
  'silly-dancing': { durationSeconds: 6, crossfadeSeconds: 0.5, energy: 'high', defaultMotionState: 'celebrate' },
  'northern-soul-spin-combo': { durationSeconds: 4, crossfadeSeconds: 0.4, energy: 'high', defaultMotionState: 'gesture' },
};

const cache = new Map<BuiltInAnimationId, BuiltInAnimation>();

export function getBuiltInAnimation(id: BuiltInAnimationId): BuiltInAnimation {
  const cached = cache.get(id);
  if (cached) return cached;
  const clip = builders[id]();
  const meta = METADATA[id];
  const result: BuiltInAnimation = {
    id,
    clip,
    durationSeconds: meta.durationSeconds,
    crossfadeSeconds: meta.crossfadeSeconds,
    energy: meta.energy,
    defaultMotionState: meta.defaultMotionState,
  };
  cache.set(id, result);
  return result;
}

export function listBuiltInAnimations(): BuiltInAnimationId[] {
  return Object.keys(builders) as BuiltInAnimationId[];
}

// Convenience: build a clip keyed by the standard AvatarMotionState slots.
// The auto-cycle scheduler uses these to pick varied idles per state.
export const BUILT_IN_ANIMATIONS_BY_STATE: Partial<Record<string, BuiltInAnimationId[]>> = {
  idle: ['standing-idle', 'catwalk-idle-twist-l', 'catwalk-idle-twist-r', 'catwalk-idle-to-twist-r'],
  gesture: ['waving', 'looking-behind'],
  celebrate: ['excited', 'silly-dancing', 'macarena-dance', 'northern-soul-spin-combo'],
  rest: ['praying', 'standing-idle'],
  wake: ['waving', 'standing-idle'],
  bored: ['looking-behind', 'standing-idle'],
  listening: ['standing-idle', 'catwalk-idle-twist-l'],
  thinking: ['standing-idle'],
  speaking: ['standing-idle'],
  enter: ['standing-idle'],
};
