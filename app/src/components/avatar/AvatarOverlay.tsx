// app/src/components/avatar/AvatarOverlay.tsx
// Phase B: PIP/Floating avatar overlay — draggable, position-persisted.
//
// Renders a small <Canvas> with the VRMModel component (reusing all existing
// expression/lip-sync/breathing/blink/shadow logic). Uses motion.div for
// 2D drag with viewport bounds. Position + visibility persisted via the
// avatar settings API.

import { useState, useEffect, useRef, Suspense, Component, type ReactNode } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import { motion } from 'motion/react';
import { X, GripHorizontal } from 'lucide-react';
import { createWLipSyncNode, type WLipSyncAudioNode, type Profile } from 'wlipsync';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { wsClient } from '@/lib/ws';

type EmotionId = 'happy' | 'sad' | 'angry' | 'think' | 'surprised' | 'neutral';

const EMOTION_BLENDSHAPES: Record<EmotionId, Record<string, number>> = {
  happy:     { happy: 0.8 },
  sad:       { sad: 0.7 },
  angry:     { angry: 0.8 },
  think:     { relaxed: 0.3, surprised: 0.2 },
  surprised: { surprised: 0.9 },
  neutral:   {},
};

const VOWEL_TO_BLENDSHAPE: Record<string, string> = {
  A: 'aa', E: 'ee', I: 'ih', O: 'oh', U: 'ou',
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

class PipErrorBoundary extends Component<{ onError: (msg: string) => void; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: Error) { this.props.onError(err.message); }
  render() { return this.state.hasError ? null : this.props.children; }
}

interface PipVRMModelProps {
  avatarUrl: string;
  currentEmotion: EmotionId;
  audioSource: AudioNode | null;
  audioContext: AudioContext | null;
}

function PipVRMModel({ avatarUrl, currentEmotion, audioSource, audioContext }: PipVRMModelProps) {
  const groupRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const blinkTimerRef = useRef(0);
  const blinkPhaseRef = useRef<'open' | 'closing' | 'opening'>('open');
  const blinkValueRef = useRef(0);
  const breathingRef = useRef(0);
  const currentBlendValues = useRef<Record<string, number>>({});
  const targetBlendValues = useRef<Record<string, number>>({});
  const lookAtTarget = useRef(new THREE.Object3D());
  const lipSyncNodeRef = useRef<WLipSyncAudioNode | null>(null);
  const lipSyncProfileRef = useRef<Profile | null>(null);
  const prevGltfRef = useRef<{ scene: THREE.Group; url: string } | null>(null);

  const gltf = useLoader(GLTFLoader, avatarUrl, (loader: GLTFLoader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  });

  useEffect(() => {
    return () => {
      if (prevGltfRef.current && prevGltfRef.current.url !== avatarUrl) {
        try { VRMUtils.deepDispose(prevGltfRef.current.scene); } catch { /* already disposed */ }
        try { useLoader.clear(GLTFLoader, prevGltfRef.current.url); } catch { /* cache removed */ }
      }
    };
  }, [avatarUrl]);

  useEffect(() => {
    if (gltf?.scene) prevGltfRef.current = { scene: gltf.scene, url: avatarUrl };
  }, [gltf, avatarUrl]);

  useEffect(() => {
    if (!gltf) return;
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) return;
    vrmRef.current = vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);

    fetch('/models/lip-sync-profile.json')
      .then(res => res.json() as Promise<Profile>)
      .then(profile => { lipSyncProfileRef.current = profile; })
      .catch(() => {});

    if (audioSource && audioContext && lipSyncProfileRef.current && !lipSyncNodeRef.current) {
      createWLipSyncNode(audioContext, lipSyncProfileRef.current)
        .then(node => {
          lipSyncNodeRef.current = node;
          audioSource.connect(node);
        })
        .catch(() => { /* wlipsync init failed */ });
    }
  }, [gltf, audioSource, audioContext]);

  useFrame((state) => {
    const vrm = vrmRef.current;
    if (!vrm || !groupRef.current) return;
    const delta = state.clock.getDelta();
    const t = state.clock.elapsedTime;

    vrm.update(delta);

    breathingRef.current += delta;
    groupRef.current.position.y = Math.sin(breathingRef.current * 0.5) * 0.02;
    groupRef.current.rotation.x = Math.sin(breathingRef.current * 0.3) * 0.01;
    groupRef.current.rotation.y = Math.sin(t * 0.1) * 0.05;

    const mouseX = state.mouse.x * 0.5;
    const mouseY = state.mouse.y * 0.3;
    lookAtTarget.current.position.set(mouseX, mouseY + 1, 3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (vrm.lookAt) (vrm.lookAt as any).target = lookAtTarget.current;

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
      targetBlendValues.current = { ...EMOTION_BLENDSHAPES[currentEmotion] ?? {} };
      targetBlendValues.current['blink'] = blinkValueRef.current;

      const lipSyncNode = lipSyncNodeRef.current;
      const SILENCE_THRESHOLD = 0.05;
      if (lipSyncNode && lipSyncNode.weights && lipSyncNode.volume > SILENCE_THRESHOLD) {
        const weights = lipSyncNode.weights;
        const volume = lipSyncNode.volume;
        for (const [vowel, blendshape] of Object.entries(VOWEL_TO_BLENDSHAPE)) {
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
    <group ref={groupRef}>
      <primitive object={gltf.scene} scale={1} position={[0, -1.2, 0]} />
      <mesh position={[0, -1.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.6, 32]} />
        <meshBasicMaterial transparent opacity={0.5} depthWrite={false} side={THREE.DoubleSide} map={blobShadowTexture} />
      </mesh>
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
  const { currentAudioSource, audioContext } = useVoiceSession();
  const [currentEmotion] = useState<EmotionId>('neutral');

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
          <button onClick={onClose} className="p-0.5 rounded hover:bg-white/10 transition-colors">
            <X className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
          </button>
        </div>
        <Canvas camera={{ position: [0, 0, 3], fov: 45 }} gl={{ antialias: true, alpha: true }}
          style={{ width: '100%', height: 'calc(100% - 28px)' }}>
          <ambientLight intensity={0.3} />
          <pointLight position={[0, 2, 3]} intensity={1} color="#00BFFF" />
          <pointLight position={[0, -2, 1]} intensity={0.5} color="#0088FF" />
          <Suspense fallback={null}>
            <PipErrorBoundary onError={() => {}}>
              <PipVRMModel avatarUrl={avatarUrl} currentEmotion={currentEmotion}
                audioSource={currentAudioSource} audioContext={audioContext} />
            </PipErrorBoundary>
          </Suspense>
          <OrbitControls enablePan={false} enableZoom={true} minDistance={1.5} maxDistance={6} />
        </Canvas>
      </motion.div>
    </>
  );
}
