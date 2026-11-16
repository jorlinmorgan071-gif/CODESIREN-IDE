// app/src/components/avatar/VRMModel.tsx
//
// VRM Model Component — extracted from app/src/pages/FaceView.tsx (task 04).
//
// Loads a VRM model via @pixiv/three-vrm's GLTFLoader plugin, applies
// expression + lip sync + eye tracking + auto-cycle animation in the
// useFrame loop. This is the 3D avatar renderer that FaceView mounts
// inside a <Canvas>.
//
// WHY IT'S SEPARATE
// FaceView.tsx was 1664 lines. The VRMModel component alone was ~400 lines
// of dense three.js + VRM + wlipsync code — pulling it out lets FaceView
// focus on UI/state (voice session, emotion, avatar picker) and lets
// VRMModel focus on the render loop.

import { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { useVRMLoader } from '@/hooks/useVRMLoader';
import { createWLipSyncNode, type WLipSyncAudioNode, type Profile } from 'wlipsync';
import {
  AVATAR_MOTION_EXPRESSION_TARGETS,
  createAvatarMotionSnapshot,
  getAvatarMotionPose,
  reduceAvatarMotion,
} from '@/lib/avatar-motion';
import {
  getLocalVrmaRegistryEntries,
  type LocalVrmaRegistry,
  LOCAL_VRMA_TARGET_STATES,
} from '@/lib/local-vrma-session';
import { LocalVrmaPlayer, shouldUseProceduralMotion } from '@/lib/vrma-player';
import {
  detectAvatarCapabilities,
  extractAvatarModelId,
  isAnimationStateCompatible,
  resolveExpressionAliases,
  resolveSemanticExpressionValues,
  type SemanticExpression,
} from '@/lib/avatar-compatibility';
import { applyAvatarPresentationPose, getAvatarGazeTarget } from '@/lib/avatar-compatibility-runtime';
import { useAvatarCompatibility } from '@/hooks/useAvatarCompatibility';
import {
  useAvatarDiagnosticsSnapshot,
  type AvatarDiagnosticsRuntimeState,
  type AvatarDiagnosticsViewSnapshot,
} from '@/hooks/useAvatarDiagnosticsSnapshot';
import { canAttachLipSyncNode } from '@/lib/runtime-coordination';
import {
  createAutoCycleState,
  ensureBuiltInForState,
  finalisePersonalityWithCapabilities,
  resetForNewModel,
  tickAutoCycle,
  tryIssueGreeting,
  type AutoCycleState,
} from '@/lib/avatar-auto-cycle';
import { triggerAvatarSwitch, triggerIdleEnter } from '@/lib/avatar-animation-triggers';
import type { EmotionId } from '@/lib/avatar-emotions';
import { EMOTION_BLENDSHAPES } from '@/lib/avatar-emotions';

// ── Props ───────────────────────────────────────────────────────────────

interface VRMModelProps {
  amplitude: number;
  visemeHint: string;
  isActive: boolean;
  currentEmotion: EmotionId;
  audioSource: AudioNode | null;
  audioContext: AudioContext | null;
  avatarUrl: string;
  animationRegistry: LocalVrmaRegistry;
  onLoaded?: () => void;
  onAnimationError?: (message: string) => void;
  diagnosticsOpen: boolean;
  diagnosticsRefreshToken: number;
  onDiagnosticsSnapshot: (snapshot: AvatarDiagnosticsViewSnapshot) => void;
}

// ── Blob shadow texture (generated once, reused) ────────────────────────
// Creates a radial gradient on a canvas: opaque black center → transparent edge.
// This gives the soft, realistic "contact shadow" look without real shadow mapping.

const blobShadowCanvas = document.createElement('canvas');
blobShadowCanvas.width = 128;
blobShadowCanvas.height = 128;
const blobCtx = blobShadowCanvas.getContext('2d')!;
const blobGradient = blobCtx.createRadialGradient(64, 64, 0, 64, 64, 60);
blobGradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
blobGradient.addColorStop(0.4, 'rgba(0, 0, 0, 0.6)');
blobGradient.addColorStop(0.8, 'rgba(0, 0, 0, 0.15)');
blobGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
blobCtx.fillStyle = blobGradient;
blobCtx.fillRect(0, 0, 128, 128);
const blobShadowTexture = new THREE.CanvasTexture(blobShadowCanvas);

// ── VRMModel component ───────────────────────────────────────────────────

export function VRMModel({ amplitude, isActive, currentEmotion, audioSource, audioContext, avatarUrl, animationRegistry, onLoaded, onAnimationError, diagnosticsOpen, diagnosticsRefreshToken, onDiagnosticsSnapshot }: VRMModelProps) {
  const vrmRef = useRef<VRM | null>(null);
  const blinkTimerRef = useRef(0);
  const blinkPhaseRef = useRef<'open' | 'closing' | 'opening'>('open');
  const blinkValueRef = useRef(0);
  const currentBlendValues = useRef<Record<string, number>>({});
  const targetBlendValues = useRef<Record<string, number>>({});
  const lookAtTarget = useRef(new THREE.Object3D());
  const lipSyncNodeRef = useRef<WLipSyncAudioNode | null>(null);
  const [lipSyncProfile, setLipSyncProfile] = useState<Profile | null>(null);
  const motionRef = useRef(createAvatarMotionSnapshot(0));
  const vrmaPlayerRef = useRef<LocalVrmaPlayer | null>(null);
  const diagnosticsRuntimeRef = useRef<AvatarDiagnosticsRuntimeState>({ currentMotionState: 'idle', activeAnimation: null, proceduralFallback: true });
  const autoCycleRef = useRef<AutoCycleState | null>(null);
  const compatibility = useAvatarCompatibility(avatarUrl);

  // Shared VRM loading + disposal + orientation + shadow setup
  const { gltf, vrm, groupRef } = useVRMLoader(avatarUrl, compatibility, 'face', onLoaded);
  const capabilities = useMemo(() => detectAvatarCapabilities(vrm), [vrm]);
  const expressionAliases = useMemo(
    () => resolveExpressionAliases(compatibility.profile, capabilities),
    [capabilities, compatibility.profile],
  );
  const getDiagnosticsRuntimeState = useCallback(() => diagnosticsRuntimeRef.current, []);
  const { snapshot: diagnosticsSnapshot } = useAvatarDiagnosticsSnapshot({
    context: 'face',
    compatibility,
    capabilities,
    animationRegistry,
    getRuntimeState: getDiagnosticsRuntimeState,
    isOpen: diagnosticsOpen,
    refreshToken: diagnosticsRefreshToken,
  });

  useEffect(() => {
    if (diagnosticsSnapshot) onDiagnosticsSnapshot(diagnosticsSnapshot);
  }, [diagnosticsSnapshot, onDiagnosticsSnapshot]);

  // Keep vrmRef in sync for useFrame
  useEffect(() => {
    vrmRef.current = vrm ?? null;
    currentBlendValues.current = {};
    targetBlendValues.current = {};
    blinkValueRef.current = 0;
    blinkTimerRef.current = 0;
    blinkPhaseRef.current = 'open';
    vrmaPlayerRef.current?.dispose();
    vrmaPlayerRef.current = vrm ? new LocalVrmaPlayer(vrm) : null;
    if (vrm) {
      motionRef.current = reduceAvatarMotion(motionRef.current, { type: 'model-loaded', nowMs: Date.now() });
      const modelId = extractAvatarModelId(avatarUrl);
      const nowMs = Date.now();
      autoCycleRef.current = autoCycleRef.current
        ? resetForNewModel(autoCycleRef.current, modelId, nowMs)
        : createAutoCycleState(modelId, nowMs);
      const player = vrmaPlayerRef.current;
      if (player && autoCycleRef.current) {
        ensureBuiltInForState(autoCycleRef.current, player, 'idle');
        ensureBuiltInForState(autoCycleRef.current, player, 'enter');
        ensureBuiltInForState(autoCycleRef.current, player, 'gesture');
        ensureBuiltInForState(autoCycleRef.current, player, 'rest');
        ensureBuiltInForState(autoCycleRef.current, player, 'bored');
        ensureBuiltInForState(autoCycleRef.current, player, 'listening');
        ensureBuiltInForState(autoCycleRef.current, player, 'thinking');
        ensureBuiltInForState(autoCycleRef.current, player, 'celebrate');
        ensureBuiltInForState(autoCycleRef.current, player, 'wake');
        triggerAvatarSwitch(player, autoCycleRef.current);
        triggerIdleEnter(player, autoCycleRef.current, nowMs);
        tryIssueGreeting(autoCycleRef.current, player);
      }
    }
    if (vrm?.expressionManager) {
      const expressions = vrm.expressionManager.expressions;
      console.log(`[face] VRM loaded with ${expressions.length} expressions:`,
        expressions.map(e => e.expressionName).join(', '));
    }
    return () => {
      vrmaPlayerRef.current?.dispose();
      vrmaPlayerRef.current = null;
    };
  }, [vrm, avatarUrl]);

  useEffect(() => {
    const player = vrmaPlayerRef.current;
    if (!player) return;
    let cancelled = false;
    const compatibleSessions = getLocalVrmaRegistryEntries(animationRegistry).filter((session) =>
      isAnimationStateCompatible(compatibility.profile, capabilities, session.targetState),
    );
    player.sync(compatibleSessions).catch((err) => {
      if (!cancelled) {
        const detail = err instanceof Error ? err.message : 'Unknown animation loading error.';
        onAnimationError?.(`Local animation could not load: ${detail}`);
      }
    });
    return () => { cancelled = true; };
  }, [animationRegistry, capabilities, compatibility.profile, vrm, onAnimationError]);

  useEffect(() => {
    const cycle = autoCycleRef.current;
    if (!cycle) return;
    finalisePersonalityWithCapabilities(cycle, extractAvatarModelId(avatarUrl), capabilities);
  }, [capabilities, avatarUrl]);

  useEffect(() => {
    motionRef.current = reduceAvatarMotion(motionRef.current, {
      type: isActive ? 'voice-started' : 'voice-ended',
      nowMs: Date.now(),
    });
  }, [isActive]);

  useEffect(() => {
    if (currentEmotion === 'think') {
      motionRef.current = reduceAvatarMotion(motionRef.current, { type: 'thinking', nowMs: Date.now() });
    } else if (currentEmotion === 'happy') {
      motionRef.current = reduceAvatarMotion(motionRef.current, { type: 'celebrate', nowMs: Date.now() });
    }
  }, [currentEmotion]);

  // Load wlipsync profile (async, non-blocking)
  useEffect(() => {
    let cancelled = false;
    fetch('/models/lip-sync-profile.json')
      .then(res => res.json() as Promise<Profile>)
      .then(profile => {
        if (cancelled) return;
        setLipSyncProfile(profile);
        console.log('[face] wlipsync profile loaded:', profile.mfccs?.length, 'phonemes');
      })
      .catch(err => console.warn('[face] Failed to load lip-sync profile:', err));
    return () => { cancelled = true; };
  }, []);

  // Create/connect lip sync node when audio source changes
  useEffect(() => {
    if (!canAttachLipSyncNode(audioSource, audioContext, lipSyncProfile) || !audioContext || !lipSyncProfile) return;
    if (lipSyncNodeRef.current) {
      try { audioSource.disconnect(lipSyncNodeRef.current); } catch { /* disconnect may fail */ }
      lipSyncNodeRef.current = null;
    }

    let cancelled = false;
    let connectedNode: WLipSyncAudioNode | null = null;
    let logInterval: ReturnType<typeof setInterval> | null = null;

    createWLipSyncNode(audioContext, lipSyncProfile)
      .then(node => {
        if (cancelled) return;
        connectedNode = node;
        lipSyncNodeRef.current = node;
        audioSource.connect(node);
        console.log('[face] wlipsync node created and connected to audio source');

        logInterval = setInterval(() => {
          const lsNode = lipSyncNodeRef.current;
          if (!lsNode || !lsNode.weights) return;
          const w = lsNode.weights;
          const vol = lsNode.volume || 0;
          const vowelStr = Object.entries(w)
            .filter(([key]) => ['A', 'E', 'I', 'O', 'U'].includes(key))
            .map(([k, v]) => `${k}=${(v as number).toFixed(3)}`)
            .join(' ');
          const silenceTag = vol <= 0.05 ? ' [SILENCE→blendshapes decaying]' : '';
          console.log(`[face] lip sync: ${vowelStr} vol=${vol.toFixed(3)}${silenceTag}`);
        }, 200);

      })
      .catch(err => console.warn('[face] Failed to create wlipsync node:', err));

    return () => {
      cancelled = true;
      if (logInterval) clearInterval(logInterval);
      if (connectedNode) {
        try { audioSource.disconnect(connectedNode); } catch { /* disconnect may fail */ }
        if (lipSyncNodeRef.current === connectedNode) lipSyncNodeRef.current = null;
      }
    };
  }, [audioSource, audioContext, lipSyncProfile]);

  // Animation loop — drives expressions, blink, breathing, lip sync, eye tracking
  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm || !groupRef.current) return;

    const t = state.clock.elapsedTime;
    const nowMs = t * 1000;
    motionRef.current = reduceAvatarMotion(motionRef.current, { type: 'tick', nowMs });
    const motion = motionRef.current;
    const elapsedSeconds = Math.max(0, (nowMs - motion.stateStartedAtMs) / 1000);
    const player = vrmaPlayerRef.current;
    const requestedState = isActive && amplitude > 0.05 ? 'speaking' : motion.state;
    const animationSupported = isAnimationStateCompatible(compatibility.profile, capabilities, requestedState);
    const loadedStates = new Set(LOCAL_VRMA_TARGET_STATES.filter((targetState) =>
      player?.hasClip(targetState) && isAnimationStateCompatible(compatibility.profile, capabilities, targetState),
    ));
    player?.setState(animationSupported ? requestedState : 'idle');
    const proceduralFallback = !player || !animationSupported || shouldUseProceduralMotion(requestedState, loadedStates);
    const pose = proceduralFallback
      ? getAvatarMotionPose(requestedState, elapsedSeconds)
      : { verticalOffset: 0, pitchOffset: 0, yawOffset: 0 };
    diagnosticsRuntimeRef.current = {
      currentMotionState: requestedState,
      activeAnimation: proceduralFallback ? null : requestedState,
      proceduralFallback,
    };

    const autoCycle = autoCycleRef.current;
    let headYawDelta = 0;
    let headPitchDelta = 0;
    let headRollDelta = 0;
    let blinkRateScale = 1;
    let expressionBlend: Readonly<Partial<Record<SemanticExpression, number>>> = {};
    if (autoCycle && player) {
      const cycleResult = tickAutoCycle({
        player,
        state: autoCycle,
        currentMotionState: requestedState,
        acceptBuiltInForState: requestedState !== 'speaking',
        profile: compatibility.profile,
        capabilities,
        nowMs,
        deltaSeconds: delta,
      });
      headYawDelta = cycleResult.headYawDelta;
      headPitchDelta = cycleResult.headPitchDelta;
      headRollDelta = cycleResult.headRollDelta;
      blinkRateScale = cycleResult.blinkRateScale;
      if (cycleResult.expressionSample) {
        expressionBlend = cycleResult.expressionSample.blend;
      }
    }

    player?.update(delta);
    vrm.update(delta);

    const compositedPose = {
      verticalOffset: pose.verticalOffset,
      pitchOffset: pose.pitchOffset + headPitchDelta,
      yawOffset: pose.yawOffset + headYawDelta,
    };
    applyAvatarPresentationPose(groupRef.current, compositedPose, compatibility.profile);
    if (headRollDelta !== 0) {
      groupRef.current.rotation.z += headRollDelta;
    }

    const [gazeX, gazeY, gazeZ] = getAvatarGazeTarget(state.mouse.x, state.mouse.y, compatibility.profile);
    lookAtTarget.current.position.set(gazeX, gazeY, gazeZ);
    if (vrm.lookAt && compatibility.profile.gaze.mode !== 'disabled') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vrm.lookAt as any).target = lookAtTarget.current;
    }

    const blinkIntervalMultiplier = 1 / Math.max(0.1, blinkRateScale);
    blinkTimerRef.current -= delta * 1000;
    if (blinkPhaseRef.current === 'open' && blinkTimerRef.current <= 0) {
      blinkPhaseRef.current = 'closing';
      blinkTimerRef.current = 80;
    } else if (blinkPhaseRef.current === 'closing') {
      blinkValueRef.current = Math.min(1, blinkValueRef.current + delta * 12);
      if (blinkValueRef.current >= 1) {
        blinkPhaseRef.current = 'opening';
        blinkTimerRef.current = 200;
      }
    } else if (blinkPhaseRef.current === 'opening') {
      blinkValueRef.current = Math.max(0, blinkValueRef.current - delta * 5);
      if (blinkValueRef.current <= 0) {
        blinkPhaseRef.current = 'open';
        blinkTimerRef.current = (3000 + Math.random() * 3000) * blinkIntervalMultiplier;
      }
    }

    const expr = vrm.expressionManager;
    if (expr) {
      targetBlendValues.current = {
        ...resolveSemanticExpressionValues(AVATAR_MOTION_EXPRESSION_TARGETS[motion.state], expressionAliases),
        ...resolveSemanticExpressionValues(EMOTION_BLENDSHAPES[currentEmotion], expressionAliases),
        ...resolveSemanticExpressionValues(expressionBlend, expressionAliases),
      };

      const blinkExpression = expressionAliases[compatibility.profile.expressions.blink];
      if (blinkExpression) targetBlendValues.current[blinkExpression] = blinkValueRef.current;

      const lipSyncNode = lipSyncNodeRef.current;
      const SILENCE_THRESHOLD = 0.05;
      if (lipSyncNode && lipSyncNode.weights && lipSyncNode.volume > SILENCE_THRESHOLD) {
        const weights = lipSyncNode.weights;
        const volume = lipSyncNode.volume;

        for (const vowel of ['A', 'E', 'I', 'O', 'U'] as const) {
          const semantic = compatibility.profile.expressions.mouth[vowel];
          const blendshape = expressionAliases[semantic];
          if (!blendshape) continue;
          const weight = weights[vowel] ?? 0;
          const scaled = Math.min(1, weight * volume * 1.5);
          if (scaled > 0.01) {
            targetBlendValues.current[blendshape] = Math.max(
              targetBlendValues.current[blendshape] ?? 0,
              scaled
            );
          }
        }
      } else {
        const mouthAExpression = expressionAliases[compatibility.profile.expressions.mouth.A];
        if (!lipSyncNode && mouthAExpression && amplitude > 0.01) {
          targetBlendValues.current[mouthAExpression] = Math.max(targetBlendValues.current[mouthAExpression] ?? 0, amplitude * 0.7);
        }
      }

      const allKeys = new Set([...Object.keys(currentBlendValues.current), ...Object.keys(targetBlendValues.current)]);
      for (const key of allKeys) {
        const current = currentBlendValues.current[key] ?? 0;
        const target = targetBlendValues.current[key] ?? 0;
        const lerpSpeed = 8;
        const newVal = current + (target - current) * Math.min(1, delta * lerpSpeed);
        currentBlendValues.current[key] = newVal;
        expr.setValue(key, newVal);
      }

      expr.update();
    }
  });

  return (
    <group
      ref={groupRef}
      onClick={() => {
        motionRef.current = reduceAvatarMotion(motionRef.current, { type: 'user-tap', nowMs: Date.now() });
      }}
    >
      <primitive
        object={gltf.scene}
        scale={compatibility.profile.transform.scale}
        position={compatibility.profile.transform.positionOffset}
        rotation={compatibility.profile.transform.rotationOffset}
      />
      {compatibility.profile.rendering.blobShadow && <mesh position={[0, -1.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.6, 32]} />
        <meshBasicMaterial
          transparent
          opacity={0.5}
          depthWrite={false}
          side={THREE.DoubleSide}
          map={blobShadowTexture}
        />
      </mesh>}
    </group>
  );
}
