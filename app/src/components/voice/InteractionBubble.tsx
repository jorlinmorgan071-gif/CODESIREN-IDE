// app/src/components/voice/InteractionBubble.tsx
// Phase B: Screen Intelligence Section B — unified circular bubble UI.
//
// Wires together existing infrastructure:
//   - motion.div drag + position persistence (from AvatarOverlay pattern)
//   - AnalyserNode waveform ring (from SensoryFeedbackOverlay pattern)
//   - VoiceSessionContext (captions, amplitude, isActive, toggleMute, endVoiceSession)
//   - Screen share (from Home.tsx handleScreenShare pattern)
//   - Sensory feedback (ScreenEdgeGlow, ConfirmationChime already in Home)
//
// Three modes: idle, voice-call, screen-share. Video-call is honestly disabled.
// Expand/collapse toggle switches between 120×120 bubble and 300×400 full PIP.

import { useState, useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { motion } from 'motion/react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useApp } from '@/store/AppContext';
import { themes } from '@/store/themes';
import { Mic, MicOff, PhoneOff, Monitor, Video, Maximize2, Minimize2, X, Info } from 'lucide-react';
import { getToken } from '@/lib/auth';
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
  LOCAL_VRMA_TARGET_STATES,
  type LocalVrmaRegistry,
} from '@/lib/local-vrma-session';
import { LocalVrmaPlayer, shouldUseProceduralMotion } from '@/lib/vrma-player';
import { useLocalVrmaRegistry } from '@/store/LocalVrmaRegistryContext';
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
import { useAvatarDiagnosticsSnapshot, type AvatarDiagnosticsRuntimeState, type AvatarDiagnosticsViewSnapshot } from '@/hooks/useAvatarDiagnosticsSnapshot';
import { AvatarDiagnosticsSheetHost } from '@/components/avatar/AvatarDiagnosticsSheetHost';
import { AvatarRuntimeErrorBoundary } from '@/components/avatar/AvatarRuntimeErrorBoundary';
import { canAttachLipSyncNode, LatestOperationGate } from '@/lib/runtime-coordination';
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

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

export type BubbleMode = 'idle' | 'voice-call' | 'screen-share';

// ── Waveform Ring (3D circular amplitude visualization) ──────────────────
function WaveformRing({ analyser, accentColor }: { analyser: AnalyserNode | null; accentColor: string }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    if (analyser) {
      dataArrayRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    }
  }, [analyser]);

  useFrame(() => {
    if (!analyser || !dataArrayRef.current || !ringRef.current) return;
    analyser.getByteFrequencyData(dataArrayRef.current as Uint8Array<ArrayBuffer>);

    // Average the low-frequency bins for overall amplitude
    let sum = 0;
    const bins = Math.min(16, dataArrayRef.current.length);
    for (let i = 0; i < bins; i++) sum += dataArrayRef.current[i];
    const amplitude = (sum / bins) / 255;

    // Scale the ring with amplitude
    const scale = 1 + amplitude * 0.3;
    ringRef.current.scale.setScalar(scale);
    // Adjust opacity
    const mat = ringRef.current.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.3 + amplitude * 0.5;
  });

  const color = new THREE.Color(accentColor);

  return (
    <group>
      {/* Inner solid circle (avatar background) */}
      <mesh ref={meshRef}>
        <circleGeometry args={[0.9, 32]} />
        <meshBasicMaterial color={0x07070b} transparent opacity={0.9} />
      </mesh>
      {/* Amplitude-reactive ring */}
      <mesh ref={ringRef} position={[0, 0, 0.01]}>
        <ringGeometry args={[0.95, 1.0, 64]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

// ── Blob shadow texture (generated once, reused) ────────────────────────
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

// ── VRM Bubble Content — FULL VRM model (face + body + all features) ─────
// This is a complete copy of FaceView's VRMModel, adapted for the bubble:
//   - Full VRM model (face, body, hair, clothes — everything)
//   - Lip sync via wlipsync (MFCC vowel analysis)
//   - Expressions (happy, sad, angry, think, surprised, neutral)
//   - Eye tracking (cursor → lookAt)
//   - Breathing (sine-wave bob + rotation)
//   - Blink (randomized 3-6s)
//   - Blob shadow (radial gradient at feet)
//   - Leak-free switching (VRMUtils.deepDispose)
//   - All driven by the same VoiceSessionContext audio source
function VRMBubbleContent({
  avatarUrl,
  animationRegistry,
  diagnosticsOpen,
  diagnosticsRefreshToken,
  onDiagnosticsSnapshot,
}: {
  avatarUrl: string;
  animationRegistry: LocalVrmaRegistry;
  diagnosticsOpen: boolean;
  diagnosticsRefreshToken: number;
  onDiagnosticsSnapshot: (snapshot: AvatarDiagnosticsViewSnapshot) => void;
}) {
  const { currentAudioSource, audioContext, isActive } = useVoiceSession();
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
  const { gltf, vrm, groupRef } = useVRMLoader(avatarUrl, compatibility, 'bubble');
  const capabilities = useMemo(() => detectAvatarCapabilities(vrm), [vrm]);
  const expressionAliases = useMemo(
    () => resolveExpressionAliases(compatibility.profile, capabilities),
    [capabilities, compatibility.profile],
  );
  const getDiagnosticsRuntimeState = useCallback(() => diagnosticsRuntimeRef.current, []);
  const { snapshot: diagnosticsSnapshot } = useAvatarDiagnosticsSnapshot({
    context: 'bubble',
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
      // Initialise the auto-cycle scheduler for this avatar.
      const modelId = extractAvatarModelId(avatarUrl);
      autoCycleRef.current = autoCycleRef.current
        ? resetForNewModel(autoCycleRef.current, modelId, Date.now())
        : createAutoCycleState(modelId, Date.now());
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
        triggerIdleEnter(player, autoCycleRef.current, Date.now());
        tryIssueGreeting(autoCycleRef.current, player);
      }
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
        console.warn(`[bubble] Local animation could not load: ${detail}`);
      }
    });
    return () => { cancelled = true; };
  }, [animationRegistry, capabilities, compatibility.profile, vrm]);

  // Once a custom avatar's capabilities have been detected, re-resolve its
  // personality against the trait-based inference. Built-in avatars skip
  // this (their personality is shipped in code). Runs once per model load.
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

  // Load wlipsync profile (async, non-blocking) — context-specific
  useEffect(() => {
    let cancelled = false;
    fetch('/models/lip-sync-profile.json')
      .then(res => res.json() as Promise<Profile>)
      .then(profile => { if (!cancelled) setLipSyncProfile(profile); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Connect lip sync to audio source
  useEffect(() => {
    if (!canAttachLipSyncNode(currentAudioSource, audioContext, lipSyncProfile) || !audioContext || !lipSyncProfile) return;
    if (lipSyncNodeRef.current) {
      try { currentAudioSource.disconnect(lipSyncNodeRef.current); } catch { /* */ }
      lipSyncNodeRef.current = null;
    }
    let cancelled = false;
    let connectedNode: WLipSyncAudioNode | null = null;
    createWLipSyncNode(audioContext, lipSyncProfile)
      .then(node => {
        if (cancelled) return;
        connectedNode = node;
        lipSyncNodeRef.current = node;
        currentAudioSource.connect(node);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (connectedNode) {
        try { currentAudioSource.disconnect(connectedNode); } catch { /* */ }
        if (lipSyncNodeRef.current === connectedNode) lipSyncNodeRef.current = null;
      }
    };
  }, [currentAudioSource, audioContext, lipSyncProfile]);

  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm || !groupRef.current) return;
    // useFrame supplies the frame delta in seconds. Do not re-read the clock.
    const t = state.clock.elapsedTime;
    const nowMs = t * 1000;
    motionRef.current = reduceAvatarMotion(motionRef.current, { type: 'tick', nowMs });
    const motionSnapshot = motionRef.current;
    const elapsedSeconds = Math.max(0, (nowMs - motionSnapshot.stateStartedAtMs) / 1000);
    const player = vrmaPlayerRef.current;
    const requestedState = motionSnapshot.state;
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

    // Tick the auto-cycle scheduler for idle variety + anime micro-expressions.
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

    // Eye tracking
    const [gazeX, gazeY, gazeZ] = getAvatarGazeTarget(state.mouse.x, state.mouse.y, compatibility.profile);
    lookAtTarget.current.position.set(gazeX, gazeY, gazeZ);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (vrm.lookAt && compatibility.profile.gaze.mode !== 'disabled') (vrm.lookAt as any).target = lookAtTarget.current;

    // Blink (personality-scaled)
    const blinkIntervalMultiplier = 1 / Math.max(0.1, blinkRateScale);
    blinkTimerRef.current -= delta * 1000;
    if (blinkPhaseRef.current === 'open' && blinkTimerRef.current <= 0) {
      blinkPhaseRef.current = 'closing'; blinkTimerRef.current = 80;
    } else if (blinkPhaseRef.current === 'closing') {
      blinkValueRef.current = Math.min(1, blinkValueRef.current + delta * 12);
      if (blinkValueRef.current >= 1) { blinkPhaseRef.current = 'opening'; blinkTimerRef.current = 200; }
    } else if (blinkPhaseRef.current === 'opening') {
      blinkValueRef.current = Math.max(0, blinkValueRef.current - delta * 5);
      if (blinkValueRef.current <= 0) {
        blinkPhaseRef.current = 'open';
        blinkTimerRef.current = (3000 + Math.random() * 3000) * blinkIntervalMultiplier;
      }
    }

    // Expressions + lip sync
    const expr = vrm.expressionManager;
    if (expr) {
      targetBlendValues.current = {
        ...resolveSemanticExpressionValues(
          AVATAR_MOTION_EXPRESSION_TARGETS[motionSnapshot.state],
          expressionAliases,
        ),
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
            targetBlendValues.current[blendshape] = Math.max(targetBlendValues.current[blendshape] ?? 0, scaled);
          }
        }
      }

      const allKeys = new Set([...Object.keys(currentBlendValues.current), ...Object.keys(targetBlendValues.current)]);
      for (const key of allKeys) {
        const current = currentBlendValues.current[key] ?? 0;
        const target = targetBlendValues.current[key] ?? 0;
        const newVal = current + (target - current) * Math.min(1, delta * 8);
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
      {/* Blob shadow at feet */}
      {compatibility.profile.rendering.blobShadow && <mesh position={[0, -1.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.6, 32]} />
        <meshBasicMaterial transparent opacity={0.5} depthWrite={false} side={THREE.DoubleSide} map={blobShadowTexture} />
      </mesh>}
    </group>
  );
}

// ── Bars Visualization — frequency bars in a circle ──────────────────────
function BarsVisualization({ analyser, accentColor }: { analyser: AnalyserNode | null; accentColor: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const dataRef = useRef<Uint8Array | null>(null);
  const barsRef = useRef<THREE.Mesh[]>([]);

  useEffect(() => {
    if (analyser) dataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  }, [analyser]);

  useFrame(() => {
    if (!analyser || !dataRef.current || !groupRef.current) return;
    analyser.getByteFrequencyData(dataRef.current as Uint8Array<ArrayBuffer>);
    const barCount = Math.min(24, dataRef.current.length);
    for (let i = 0; i < barCount; i++) {
      const bar = barsRef.current[i];
      if (!bar) continue;
      const value = dataRef.current[i] / 255;
      const scale = 0.3 + value * 0.7;
      bar.scale.y = scale;
      (bar.material as THREE.MeshBasicMaterial).opacity = 0.2 + value * 0.6;
    }
    groupRef.current.rotation.z = Date.now() * 0.0003;
  });

  const color = new THREE.Color(accentColor);
  const barCount = 24;

  return (
    <group ref={groupRef}>
      {Array.from({ length: barCount }).map((_, i) => {
        const angle = (i / barCount) * Math.PI * 2;
        const radius = 0.8;
        return (
          <mesh
            key={i}
            ref={(el) => { if (el) barsRef.current[i] = el; }}
            position={[Math.cos(angle) * radius, Math.sin(angle) * radius, 0]}
            scale={[1, 0.3, 1]}
          >
            <boxGeometry args={[0.05, 0.3, 0.05]} />
            <meshBasicMaterial color={color} transparent opacity={0.3} />
          </mesh>
        );
      })}
    </group>
  );
}

// ── Pulse Visualization — pulsing solid orb ──────────────────────────────
function PulseVisualization({ analyser, accentColor }: { analyser: AnalyserNode | null; accentColor: string }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const dataRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    if (analyser) dataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  }, [analyser]);

  useFrame((state) => {
    if (!meshRef.current) return;
    let amplitude = 0;
    if (analyser && dataRef.current) {
      analyser.getByteFrequencyData(dataRef.current as Uint8Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += dataRef.current[i];
      amplitude = (sum / 16) / 255;
    }
    const breathe = 1 + Math.sin(state.clock.elapsedTime * 2) * 0.05;
    const pulse = 1 + amplitude * 0.4;
    meshRef.current.scale.setScalar(breathe * pulse);
    (meshRef.current.material as THREE.MeshBasicMaterial).opacity = 0.4 + amplitude * 0.4;
  });

  const color = new THREE.Color(accentColor);
  return (
    <mesh ref={meshRef}>
      <circleGeometry args={[0.85, 32]} />
      <meshBasicMaterial color={color} transparent opacity={0.4} />
    </mesh>
  );
}

// ── Orb Visualization — glowing gradient orb ────────────────────────────
function OrbVisualization({ analyser, accentColor }: { analyser: AnalyserNode | null; accentColor: string }) {
  const innerRef = useRef<THREE.Mesh>(null);
  const outerRef = useRef<THREE.Mesh>(null);
  const dataRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    if (analyser) dataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  }, [analyser]);

  useFrame((state) => {
    let amplitude = 0;
    if (analyser && dataRef.current) {
      analyser.getByteFrequencyData(dataRef.current as Uint8Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += dataRef.current[i];
      amplitude = (sum / 16) / 255;
    }
    const t = state.clock.elapsedTime;
    if (innerRef.current) {
      innerRef.current.scale.setScalar(1 + amplitude * 0.3);
      (innerRef.current.material as THREE.MeshBasicMaterial).opacity = 0.6 + amplitude * 0.3;
    }
    if (outerRef.current) {
      outerRef.current.scale.setScalar(1 + Math.sin(t * 1.5) * 0.08 + amplitude * 0.2);
      (outerRef.current.material as THREE.MeshBasicMaterial).opacity = 0.15 + amplitude * 0.2;
    }
  });

  const color = new THREE.Color(accentColor);
  return (
    <group>
      <mesh ref={outerRef}>
        <circleGeometry args={[0.95, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.15} />
      </mesh>
      <mesh ref={innerRef} position={[0, 0, 0.01]}>
        <circleGeometry args={[0.6, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

// ── Bubble Visualization Switcher ────────────────────────────────────────
function BubbleVisualization({
  visual, analyser, accentColor, avatarUrl, animationRegistry, diagnosticsOpen, diagnosticsRefreshToken, onDiagnosticsSnapshot,
}: {
  visual: string;
  analyser: AnalyserNode | null;
  accentColor: string;
  avatarUrl: string;
  animationRegistry: LocalVrmaRegistry;
  diagnosticsOpen: boolean;
  diagnosticsRefreshToken: number;
  onDiagnosticsSnapshot: (snapshot: AvatarDiagnosticsViewSnapshot) => void;
}) {
  if (visual === 'vrm' && avatarUrl) {
    return (
      <Suspense fallback={<PulseVisualization analyser={analyser} accentColor={accentColor} />}>
        <AvatarRuntimeErrorBoundary avatarIdentity={avatarUrl}>
          <VRMBubbleContent avatarUrl={avatarUrl} animationRegistry={animationRegistry} diagnosticsOpen={diagnosticsOpen} diagnosticsRefreshToken={diagnosticsRefreshToken} onDiagnosticsSnapshot={onDiagnosticsSnapshot} />
        </AvatarRuntimeErrorBoundary>
      </Suspense>
    );
  }
  if (visual === 'bars') return <BarsVisualization analyser={analyser} accentColor={accentColor} />;
  if (visual === 'pulse') return <PulseVisualization analyser={analyser} accentColor={accentColor} />;
  if (visual === 'orb') return <OrbVisualization analyser={analyser} accentColor={accentColor} />;
  return <WaveformRing analyser={analyser} accentColor={accentColor} />;
}

// ── BubbleCaption (reads existing VoiceSessionContext captions) ──────────
interface BubbleCaptionProps {
  captions: { user: string; agent: string };
  settings: {
    captionFont: string;
    captionSize: string;
    captionShadow: string;
    captionBg: string;
    captionAnimation: string;
    highContrast: boolean;
    bubbleShape: string;
    bubbleVisual: string;
    bubbleAnimation: string;
    showVRM: boolean;
    bubbleAvatarId: string;
    bubbleSize: string;
  };
}

function BubbleCaption({ captions, settings }: BubbleCaptionProps) {
  if (!captions.user && !captions.agent) return null;
  const fontSize = { xs: '9px', sm: '11px', md: '13px', lg: '16px' }[settings.captionSize as string] ?? '11px';
  return (
    <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 max-w-[250px] space-y-1">
      {captions.user && (
        <div
          key={`user-${captions.user.length}`}
          className={`caption-font-${settings.captionFont} caption-shadow-${settings.captionShadow} caption-bg-${settings.captionBg} caption-anim-${settings.captionAnimation} ${settings.highContrast ? 'caption-high-contrast' : ''}`}
          style={{ fontSize, padding: '4px 8px', borderRadius: '4px', color: settings.highContrast ? '#fff' : 'var(--bright-silver)' }}
        >
          <span style={{ fontSize: '0.8em', opacity: 0.6 }}>You: </span>
          {captions.user.slice(0, 150)}
        </div>
      )}
      {captions.agent && (
        <div
          key={`agent-${captions.agent.length}`}
          className={`caption-font-${settings.captionFont} caption-shadow-${settings.captionShadow} caption-bg-${settings.captionBg} caption-anim-${settings.captionAnimation} ${settings.highContrast ? 'caption-high-contrast' : ''}`}
          style={{ fontSize, padding: '4px 8px', borderRadius: '4px', color: settings.highContrast ? '#fff' : 'var(--bright-silver)' }}
        >
          <span style={{ fontSize: '0.8em', opacity: 0.6 }}>AI: </span>
          {captions.agent.slice(0, 150)}
        </div>
      )}
    </div>
  );
}

// ── Main InteractionBubble component ─────────────────────────────────────
export function InteractionBubble({ onClose }: { onClose?: () => void }) {
  const {
    isActive, isMuted, captions, analyser,
    toggleMute, endVoiceSession, toggleVoiceSession,
  } = useVoiceSession();
  const { animationRegistry } = useLocalVrmaRegistry();
  const { state } = useApp();
  const accentColor = themes[state.currentTheme]?.colors.accent ?? '#EE1C1C';

  const [mode, setMode] = useState<BubbleMode>('idle');
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState({ x: 100, y: 100 });
  const didDragRef = useRef(false);
  const modeOperationGateRef = useRef(new LatestOperationGate());
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsRefreshToken, setDiagnosticsRefreshToken] = useState(0);
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<AvatarDiagnosticsViewSnapshot | null>(null);

  // Phase B: Bubble accessibility settings
  const [bubbleSettings, setBubbleSettings] = useState({
    captionFont: 'inter',
    captionSize: 'sm',
    captionShadow: 'medium',
    captionBg: 'blur',
    captionAnimation: 'fade',
    highContrast: false,
    bubbleShape: 'circle',
    bubbleVisual: 'ring',
    bubbleAnimation: 'breathe',
    showVRM: false,
    bubbleAvatarId: 'default',
    bubbleSize: 'md',
  });

  // Fetch settings on mount
  useEffect(() => {
    const token = getToken() ?? '';
    fetch(`${API_BASE}/bubble/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { if (data.settings) setBubbleSettings(data.settings); })
      .catch(() => {});
  }, []);

  // Listen for live settings changes from the settings panel
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) setBubbleSettings(detail);
    };
    window.addEventListener('code-siren:bubble-settings-changed', handler);
    return () => window.removeEventListener('code-siren:bubble-settings-changed', handler);
  }, []);

  // Sync mode with isActive (voice session)
  useEffect(() => {
    if (isActive && mode === 'idle') {
      setMode('voice-call');
    }
    if (!isActive && mode === 'voice-call') {
      setMode('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // ── Mode switching: end previous mode before starting new ──────────────
  const switchMode = useCallback(async (newMode: BubbleMode) => {
    const token = modeOperationGateRef.current.begin();
    const isCurrent = () => modeOperationGateRef.current.isCurrent(token);
    // End current mode's resources
    if (mode === 'voice-call' && isActive && newMode !== 'voice-call') {
      await endVoiceSession();
    }
    if (!isCurrent()) return;

    // Start new mode
    if (newMode === 'voice-call' && !isActive) {
      await toggleVoiceSession();
    }
    if (!isCurrent()) return;

    if (newMode === 'screen-share') {
      // Trigger screen share (same pattern as Home.tsx)
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 1 },
          audio: false,
        });
        if (!isCurrent()) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        await new Promise(r => requestAnimationFrame(() => r(null)));
        if (!isCurrent()) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(video, 0, 0);
        const dataUri = canvas.toDataURL('image/png');
        stream.getTracks().forEach(t => t.stop());

        // Send to vision endpoint
        const token = getToken() ?? '';
        const res = await fetch(`${API_BASE}/orchestrator/vision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            image: dataUri,
            prompt: 'Explain what is on screen. If there is an error message, explain what it means and how to fix it.',
          }),
        });
        const data = await res.json() as { analysis: string };
        if (!isCurrent()) return;
        window.dispatchEvent(new CustomEvent('code-siren:vision-result', {
          detail: { analysis: data.analysis },
        }));
        if (!state.inlineAIVisible) {
          window.dispatchEvent(new CustomEvent('code-siren:open-inline-ai'));
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') return;
        console.error('[bubble] screen share failed:', err);
      }
      // Return to idle after screen share (it's a one-shot, not a session)
      if (isCurrent()) setMode('idle');
      return;
    }

    if (isCurrent()) setMode(newMode);
  }, [mode, isActive, endVoiceSession, toggleVoiceSession, state.inlineAIVisible]);

  // ── Handle end ─────────────────────────────────────────────────────────
  const handleEnd = useCallback(async () => {
    modeOperationGateRef.current.invalidate();
    if (isActive) await endVoiceSession();
    setMode('idle');
    if (onClose) onClose();
  }, [isActive, endVoiceSession, onClose]);

  useEffect(() => {
    const operationGate = modeOperationGateRef.current;
    return () => { operationGate.invalidate(); };
  }, []);

  // ── Persist position ───────────────────────────────────────────────────
  const handleDragEnd = useCallback(async (pos: { x: number; y: number }) => {
    setPosition(pos);
    try {
      const token = getToken() ?? '';
      await fetch(`${API_BASE}/avatar/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pipPosition: pos }),
      });
    } catch { /* persistence failure — position still updates locally */ }
  }, []);

  // Fetch persisted position on mount
  useEffect(() => {
    const token = getToken() ?? '';
    fetch(`${API_BASE}/avatar/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (data.settings?.pipPosition) setPosition(data.settings.pipPosition);
      })
      .catch(() => {});
  }, []);

  const bubbleSizeMap = { sm: 80, md: 120, lg: 160 };
  const size = expanded ? 300 : (bubbleSizeMap[bubbleSettings.bubbleSize as keyof typeof bubbleSizeMap] ?? 120);
  const height = expanded ? 400 : (bubbleSizeMap[bubbleSettings.bubbleSize as keyof typeof bubbleSizeMap] ?? 120);
  const borderRadius = expanded ? 12 : (bubbleSettings.bubbleShape === 'circle' ? '50%' : bubbleSettings.bubbleShape === 'rounded' ? 24 : bubbleSettings.bubbleShape === 'squircle' ? '35%' : 12);
  const bubbleAvatarUrl = bubbleSettings.bubbleAvatarId === 'default'
    ? '/models/avatars/default/model.vrm'
    : `/models/avatars/${bubbleSettings.bubbleAvatarId}/model.vrm`;
  const visibleDiagnosticsSnapshot = diagnosticsSnapshot?.diagnostics.avatarUrl === bubbleAvatarUrl ? diagnosticsSnapshot : null;

  return (
    <>
      {/* Constraints ref for drag bounds */}
      <div className="fixed inset-0 pointer-events-none" ref={() => {}} />

          <motion.div
            data-testid="interaction-bubble"
            drag
            dragMomentum={false}
            dragElastic={0}
            initial={{ x: position.x, y: position.y }}
            onDragStart={() => {
              didDragRef.current = true;
            }}
            onDragEnd={(_, info) => {
              handleDragEnd({
                x: position.x + info.offset.x,
                y: position.y + info.offset.y,
              });
              window.setTimeout(() => {
                didDragRef.current = false;
              }, 0);
            }}
            className="fixed z-50 pointer-events-auto"
            style={{ width: size, height }}
          >
            <div
              className={`relative w-full h-full overflow-hidden flex flex-col bubble-style-${bubbleSettings.bubbleAnimation}`}
              style={{
                borderRadius,
                backgroundColor: bubbleSettings.bubbleVisual === 'vrm' ? 'transparent' : 'rgba(7, 7, 11, 0.9)',
                border: `1px solid ${accentColor}40`,
                boxShadow: `0 12px 40px rgba(0,0,0,0.6), 0 4px 12px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05), 0 0 24px ${accentColor}20`,
                backdropFilter: 'blur(12px)',
              }}
            >
              {/* Click on bubble body opens accessibility settings */}
              <div
                className="absolute inset-0 z-10 cursor-pointer"
                onClick={() => {
                  if (didDragRef.current) return;
                  window.dispatchEvent(new CustomEvent('code-siren:open-bubble-settings'));
                }}
                title="Click to open bubble settings"
              />
              {/* Visualization canvas — fills the bubble */}
              <div className="flex-1 relative" style={{ minHeight: 0 }}>
                <Canvas
                  camera={{ position: [0, 0, 3], fov: 35 }}
                  gl={{ antialias: true, alpha: true }}
                  style={{ width: '100%', height: '100%' }}
                >
                  <ambientLight intensity={0.3} />
                  <pointLight position={[0, 2, 3]} intensity={1} color={accentColor} />
                  <pointLight position={[0, -2, 1]} intensity={0.5} color="#0088FF" />
                  <BubbleVisualization
                    visual={bubbleSettings.bubbleVisual}
                    analyser={analyser}
                    accentColor={accentColor}
                    avatarUrl={bubbleAvatarUrl}
                    animationRegistry={animationRegistry}
                    diagnosticsOpen={diagnosticsOpen}
                    diagnosticsRefreshToken={diagnosticsRefreshToken}
                    onDiagnosticsSnapshot={setDiagnosticsSnapshot}
                  />
                </Canvas>

                {/* Mode indicator text in center */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-[9px] font-medium" style={{ color: 'var(--muted-silver)' }}>
                    {mode === 'voice-call' ? '● LIVE' : mode === 'screen-share' ? '📷 SHARE' : 'IDLE'}
                  </span>
                </div>
              </div>

              {/* Control bar */}
              <div className="flex items-center justify-between px-2 py-1.5 shrink-0"
                style={{ borderTop: `1px solid ${accentColor}15` }}
              >
                {/* Left: mode buttons */}
                <div className="flex items-center gap-1">
                  <button
                    data-testid="bubble-mode-voice"
                    onClick={() => switchMode('voice-call')}
                    className="p-1 rounded transition-colors hover:bg-white/10"
                    style={{ color: mode === 'voice-call' ? accentColor : 'var(--steel-silver)' }}
                    title="Voice call"
                  >
                    <Mic className="w-3 h-3" />
                  </button>
                  <button
                    data-testid="bubble-mode-screen"
                    onClick={() => switchMode('screen-share')}
                    className="p-1 rounded transition-colors hover:bg-white/10"
                    style={{ color: mode === 'screen-share' ? accentColor : 'var(--steel-silver)' }}
                    title="Screen share"
                  >
                    <Monitor className="w-3 h-3" />
                  </button>
                  <button
                    data-testid="bubble-mode-video"
                    disabled
                    className="p-1 rounded opacity-40 cursor-not-allowed"
                    style={{ color: 'var(--muted-silver)' }}
                    title="Coming soon — not yet functional"
                  >
                    <Video className="w-3 h-3" />
                  </button>
                </div>

                {/* Right: action buttons */}
                <div className="flex items-center gap-1">
                  {mode === 'voice-call' && (
                    <button
                      data-testid="bubble-mute"
                      onClick={toggleMute}
                      className="p-1 rounded transition-colors hover:bg-white/10"
                      style={{ color: isMuted ? accentColor : 'var(--steel-silver)' }}
                      title={isMuted ? 'Unmute' : 'Mute'}
                    >
                      {isMuted ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
                    </button>
                  )}
                  {mode !== 'idle' && (
                    <button
                      data-testid="bubble-end"
                      onClick={handleEnd}
                      className="p-1 rounded transition-colors hover:bg-white/10"
                      style={{ color: accentColor }}
                      title="End session"
                    >
                      <PhoneOff className="w-3 h-3" />
                    </button>
                  )}
                  {expanded && (
                    <button
                      type="button"
                      title="Open avatar diagnostics"
                      aria-label="Open avatar diagnostics"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); setDiagnosticsOpen(true); }}
                      className="p-1 rounded transition-colors hover:bg-white/10"
                      style={{ color: 'var(--steel-silver)' }}
                    >
                      <Info className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    onClick={() => setExpanded(!expanded)}
                    className="p-1 rounded transition-colors hover:bg-white/10"
                    style={{ color: 'var(--steel-silver)' }}
                    title={expanded ? 'Minimize' : 'Expand'}
                  >
                    {expanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={() => { handleEnd(); }}
                    className="p-1 rounded transition-colors hover:bg-white/10"
                    style={{ color: 'var(--muted-silver)' }}
                    title="Close"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {/* Live captions */}
              <BubbleCaption captions={captions} settings={bubbleSettings} />
            </div>
          </motion.div>
      <AvatarDiagnosticsSheetHost
        open={diagnosticsOpen}
        variant="sheet"
        snapshot={visibleDiagnosticsSnapshot}
        onOpenChange={setDiagnosticsOpen}
        onRefresh={() => setDiagnosticsRefreshToken((token) => token + 1)}
      />
    </>
  );
}
