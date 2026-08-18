// app/src/components/avatar/AvatarOverlay.tsx
// Phase B: PIP/Floating avatar overlay — draggable, position-persisted.
//
// Renders a small <Canvas> with the VRMModel component (reusing all existing
// expression/lip-sync/breathing/blink/shadow logic). Uses motion.div for
// 2D drag with viewport bounds. Position + visibility persisted via the
// avatar settings API.

import { useState, useEffect, useRef, useMemo, useCallback, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { useVRMLoader } from '@/hooks/useVRMLoader';
import { motion } from 'motion/react';
import { X, GripHorizontal, Info } from 'lucide-react';
import { createWLipSyncNode, type WLipSyncAudioNode, type Profile } from 'wlipsync';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { wsClient } from '@/lib/ws';
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
  isAnimationStateCompatible,
  resolveExpressionAliases,
  resolveSemanticExpressionValues,
  type SemanticExpression,
} from '@/lib/avatar-compatibility';
import { applyAvatarPresentationPose, getAvatarGazeTarget } from '@/lib/avatar-compatibility-runtime';
import { useAvatarCompatibility } from '@/hooks/useAvatarCompatibility';
import { useAvatarDiagnosticsSnapshot, type AvatarDiagnosticsRuntimeState, type AvatarDiagnosticsViewSnapshot } from '@/hooks/useAvatarDiagnosticsSnapshot';
import { AvatarDiagnosticsSheetHost } from './AvatarDiagnosticsSheetHost';
import { AvatarRuntimeErrorBoundary } from './AvatarRuntimeErrorBoundary';
import { canAttachLipSyncNode } from '@/lib/runtime-coordination';

type EmotionId = 'happy' | 'sad' | 'angry' | 'think' | 'surprised' | 'neutral';

const EMOTION_BLENDSHAPES: Record<EmotionId, Partial<Record<SemanticExpression, number>>> = {
  happy:     { happy: 0.8 },
  sad:       { sad: 0.7 },
  angry:     { angry: 0.8 },
  think:     { relaxed: 0.3, surprised: 0.2 },
  surprised: { surprised: 0.9 },
  neutral:   {},
};

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

interface PipVRMModelProps {
  avatarUrl: string;
  currentEmotion: EmotionId;
  isActive: boolean;
  audioSource: AudioNode | null;
  audioContext: AudioContext | null;
  animationRegistry: LocalVrmaRegistry;
  diagnosticsOpen: boolean;
  diagnosticsRefreshToken: number;
  onDiagnosticsSnapshot: (snapshot: AvatarDiagnosticsViewSnapshot) => void;
}

function PipVRMModel({ avatarUrl, currentEmotion, isActive, audioSource, audioContext, animationRegistry, diagnosticsOpen, diagnosticsRefreshToken, onDiagnosticsSnapshot }: PipVRMModelProps) {
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
  const compatibility = useAvatarCompatibility(avatarUrl);

  // Shared VRM loading + disposal + orientation + shadow setup
  const { gltf, vrm, groupRef } = useVRMLoader(avatarUrl, compatibility, 'pip');
  const capabilities = useMemo(() => detectAvatarCapabilities(vrm), [vrm]);
  const expressionAliases = useMemo(
    () => resolveExpressionAliases(compatibility.profile, capabilities),
    [capabilities, compatibility.profile],
  );
  const getDiagnosticsRuntimeState = useCallback(() => diagnosticsRuntimeRef.current, []);
  const { snapshot: diagnosticsSnapshot } = useAvatarDiagnosticsSnapshot({
    context: 'pip',
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
    }
    return () => {
      vrmaPlayerRef.current?.dispose();
      vrmaPlayerRef.current = null;
    };
  }, [vrm]);

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
        console.warn(`[pip] Local animation could not load: ${detail}`);
      }
    });
    return () => { cancelled = true; };
  }, [animationRegistry, capabilities, compatibility.profile, vrm]);

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

  // Create/connect lip sync node when audio source changes
  useEffect(() => {
    if (!canAttachLipSyncNode(audioSource, audioContext, lipSyncProfile) || !audioContext || !lipSyncProfile) return;
    if (lipSyncNodeRef.current) {
      try { audioSource.disconnect(lipSyncNodeRef.current); } catch { /* disconnect may fail */ }
      lipSyncNodeRef.current = null;
    }
    let cancelled = false;
    let connectedNode: WLipSyncAudioNode | null = null;
    createWLipSyncNode(audioContext, lipSyncProfile)
      .then(node => {
        if (cancelled) return;
        connectedNode = node;
        lipSyncNodeRef.current = node;
        audioSource.connect(node);
      })
      .catch(() => { /* wlipsync init failed */ });
    return () => {
      cancelled = true;
      if (connectedNode) {
        try { audioSource.disconnect(connectedNode); } catch { /* disconnect may fail */ }
        if (lipSyncNodeRef.current === connectedNode) lipSyncNodeRef.current = null;
      }
    };
  }, [audioSource, audioContext, lipSyncProfile]);

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

    player?.update(delta);
    vrm.update(delta);

    applyAvatarPresentationPose(groupRef.current, pose, compatibility.profile);

    const [gazeX, gazeY, gazeZ] = getAvatarGazeTarget(state.mouse.x, state.mouse.y, compatibility.profile);
    lookAtTarget.current.position.set(gazeX, gazeY, gazeZ);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (vrm.lookAt && compatibility.profile.gaze.mode !== 'disabled') (vrm.lookAt as any).target = lookAtTarget.current;

    blinkTimerRef.current -= delta * 1000;
    if (blinkPhaseRef.current === 'open' && blinkTimerRef.current <= 0) {
      blinkPhaseRef.current = 'closing'; blinkTimerRef.current = 80;
    } else if (blinkPhaseRef.current === 'closing') {
      blinkValueRef.current = Math.min(1, blinkValueRef.current + delta * 12);
      if (blinkValueRef.current >= 1) { blinkPhaseRef.current = 'opening'; blinkTimerRef.current = 200; }
    } else if (blinkPhaseRef.current === 'opening') {
      blinkValueRef.current = Math.max(0, blinkValueRef.current - delta * 5);
      if (blinkValueRef.current <= 0) { blinkPhaseRef.current = 'open'; blinkTimerRef.current = 3000 + Math.random() * 3000; }
    }

    const expr = vrm.expressionManager;
    if (expr) {
      targetBlendValues.current = {
        ...resolveSemanticExpressionValues(AVATAR_MOTION_EXPRESSION_TARGETS[motionSnapshot.state], expressionAliases),
        ...resolveSemanticExpressionValues(EMOTION_BLENDSHAPES[currentEmotion], expressionAliases),
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
      {compatibility.profile.rendering.blobShadow && <mesh position={[0, -1.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.6, 32]} />
        <meshBasicMaterial transparent opacity={0.5} depthWrite={false} side={THREE.DoubleSide} map={blobShadowTexture} />
      </mesh>}
    </group>
  );
}

interface AvatarOverlayProps {
  avatarUrl: string;
  position: { x: number; y: number };
  onClose: () => void;
  onDragEnd: (pos: { x: number; y: number }) => void;
}

export function AvatarOverlay({ avatarUrl, position, onClose, onDragEnd }: AvatarOverlayProps) {
  const { currentAudioSource, audioContext, isActive } = useVoiceSession();
  const { animationRegistry } = useLocalVrmaRegistry();
  const [currentEmotion] = useState<EmotionId>('neutral');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsRefreshToken, setDiagnosticsRefreshToken] = useState(0);
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<AvatarDiagnosticsViewSnapshot | null>(null);
  const visibleDiagnosticsSnapshot = diagnosticsSnapshot?.diagnostics.avatarUrl === avatarUrl ? diagnosticsSnapshot : null;

  useEffect(() => {
    const offAgentChunk = wsClient.on('voice:agent-chunk' as never, () => {});
    const offAgentResponse = wsClient.on('voice:agent-response' as never, () => {});
    return () => { offAgentChunk(); offAgentResponse(); };
  }, []);

  const constraintsRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div ref={constraintsRef} className="fixed inset-0 pointer-events-none" />
      <motion.div
        data-testid="pip-overlay"
        drag
        dragConstraints={constraintsRef}
        dragMomentum={false}
        dragElastic={0}
        initial={{ x: position.x, y: position.y }}
        onDragEnd={(_, info) => {
          onDragEnd({
            x: position.x + info.offset.x,
            y: position.y + info.offset.y,
          });
        }}
        className="fixed z-50 pointer-events-auto"
        style={{
          width: 300, height: 400,
          borderRadius: '12px', overflow: 'hidden',
          backgroundColor: 'rgba(7, 7, 11, 0.85)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(238, 28, 28, 0.2)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
        }}
      >
        <div className="flex items-center justify-between px-2 py-1.5 cursor-grab active:cursor-grabbing"
          style={{ borderBottom: '1px solid rgba(238, 28, 28, 0.15)' }}>
          <div className="flex items-center gap-1.5">
            <GripHorizontal className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} />
            <span className="text-[10px] font-medium" style={{ color: 'var(--steel-silver)' }}>Avatar PIP</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Open avatar diagnostics"
              aria-label="Open avatar diagnostics"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); setDiagnosticsOpen(true); }}
              className="p-0.5 rounded hover:bg-white/10 transition-colors"
            >
              <Info className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
            </button>
            <button onClick={onClose} className="p-0.5 rounded hover:bg-white/10 transition-colors">
              <X className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
            </button>
          </div>
        </div>
        <Canvas camera={{ position: [0, 0, 3], fov: 45 }} gl={{ antialias: true, alpha: true }}
          style={{ width: '100%', height: 'calc(100% - 28px)' }}>
          <ambientLight intensity={0.6} />
          <directionalLight position={[0, 2, 3]} intensity={1.2} color="#FFFFFF" />
          <directionalLight position={[-2, 1, 2]} intensity={0.4} color="#FFFFFF" />
          <Suspense fallback={null}>
            <AvatarRuntimeErrorBoundary avatarIdentity={avatarUrl}>
              <PipVRMModel avatarUrl={avatarUrl} currentEmotion={currentEmotion} isActive={isActive}
                audioSource={currentAudioSource} audioContext={audioContext} animationRegistry={animationRegistry}
                diagnosticsOpen={diagnosticsOpen} diagnosticsRefreshToken={diagnosticsRefreshToken} onDiagnosticsSnapshot={setDiagnosticsSnapshot} />
            </AvatarRuntimeErrorBoundary>
          </Suspense>
          <OrbitControls enablePan={false} enableZoom={true} minDistance={1.5} maxDistance={6} />
        </Canvas>
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
