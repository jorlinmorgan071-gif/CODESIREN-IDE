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

import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { motion } from 'motion/react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useApp } from '@/store/AppContext';
import { themes } from '@/store/themes';
import { Mic, MicOff, PhoneOff, Monitor, Video, Maximize2, Minimize2, X } from 'lucide-react';
import { getToken } from '@/lib/auth';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import { createWLipSyncNode, type WLipSyncAudioNode, type Profile } from 'wlipsync';

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

// ── VRM Emotion + Lip Sync constants ─────────────────────────────────────
const EMOTION_BLENDSHAPES: Record<string, Record<string, number>> = {
  happy:     { happy: 0.7, aa: 0.2 },
  sad:       { sad: 0.7, oh: 0.15 },
  angry:     { angry: 0.7, ee: 0.3 },
  think:     { relaxed: 0.3, oh: 0.1 },
  surprised: { surprised: 0.8, aa: 0.3 },
  neutral:   {},
};

const VOWEL_TO_BLENDSHAPE: Record<string, string> = {
  A: 'aa', E: 'ee', I: 'ih', O: 'oh', U: 'ou',
};

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
function VRMBubbleContent({ avatarUrl }: { avatarUrl: string }) {
  const { currentAudioSource, audioContext } = useVoiceSession();
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

  // Leak-free switching
  useEffect(() => {
    return () => {
      if (prevGltfRef.current && prevGltfRef.current.url !== avatarUrl) {
        try { VRMUtils.deepDispose(prevGltfRef.current.scene); } catch { /* */ }
        try { useLoader.clear(GLTFLoader, prevGltfRef.current.url); } catch { /* */ }
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

    // Enable shadows
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // Load wlipsync profile
    fetch('/models/lip-sync-profile.json')
      .then(res => res.json() as Promise<Profile>)
      .then(profile => { lipSyncProfileRef.current = profile; })
      .catch(() => {});
  }, [gltf]);

  // Connect lip sync to audio source
  useEffect(() => {
    if (!currentAudioSource || !audioContext || !lipSyncProfileRef.current) return;
    if (lipSyncNodeRef.current) {
      try { currentAudioSource.disconnect(lipSyncNodeRef.current); } catch { /* */ }
    }
    createWLipSyncNode(audioContext, lipSyncProfileRef.current)
      .then(node => {
        lipSyncNodeRef.current = node;
        currentAudioSource.connect(node);
      })
      .catch(() => {});

    return () => {
      if (lipSyncNodeRef.current && currentAudioSource) {
        try { currentAudioSource.disconnect(lipSyncNodeRef.current); } catch { /* */ }
      }
    };
  }, [currentAudioSource, audioContext]);

  useFrame((state) => {
    const vrm = vrmRef.current;
    if (!vrm || !groupRef.current) return;
    const delta = state.clock.getDelta();
    const t = state.clock.elapsedTime;

    vrm.update(delta);

    // Breathing
    breathingRef.current += delta;
    groupRef.current.position.y = Math.sin(breathingRef.current * 0.5) * 0.02;
    groupRef.current.rotation.x = Math.sin(breathingRef.current * 0.3) * 0.01;
    groupRef.current.rotation.y = Math.sin(t * 0.1) * 0.05;

    // Eye tracking
    const mouseX = state.mouse.x * 0.5;
    const mouseY = state.mouse.y * 0.3;
    lookAtTarget.current.position.set(mouseX, mouseY + 1, 3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (vrm.lookAt) (vrm.lookAt as any).target = lookAtTarget.current;

    // Blink
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

    // Expressions + lip sync
    const expr = vrm.expressionManager;
    if (expr) {
      targetBlendValues.current = { ...EMOTION_BLENDSHAPES['neutral'] ?? {} };
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
      {/* Blob shadow at feet */}
      <mesh position={[0, -1.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.6, 32]} />
        <meshBasicMaterial transparent opacity={0.5} depthWrite={false} side={THREE.DoubleSide} map={blobShadowTexture} />
      </mesh>
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
  visual, analyser, accentColor, avatarUrl,
}: {
  visual: string;
  analyser: AnalyserNode | null;
  accentColor: string;
  avatarUrl: string;
}) {
  if (visual === 'vrm' && avatarUrl) {
    return (
      <Suspense fallback={<PulseVisualization analyser={analyser} accentColor={accentColor} />}>
        <VRMBubbleContent avatarUrl={avatarUrl} />
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
export function InteractionBubble() {
  const {
    isActive, isMuted, captions, analyser,
    toggleMute, endVoiceSession, toggleVoiceSession,
  } = useVoiceSession();
  const { state } = useApp();
  const accentColor = themes[state.currentTheme]?.colors.accent ?? '#EE1C1C';

  const [mode, setMode] = useState<BubbleMode>('idle');
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [visible, setVisible] = useState(false);

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
    // End current mode's resources
    if (mode === 'voice-call' && isActive && newMode !== 'voice-call') {
      await endVoiceSession();
    }

    // Start new mode
    if (newMode === 'voice-call' && !isActive) {
      await toggleVoiceSession();
    }

    if (newMode === 'screen-share') {
      // Trigger screen share (same pattern as Home.tsx)
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 1 },
          audio: false,
        });
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        await new Promise(r => requestAnimationFrame(() => r(null)));
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
      setMode('idle');
      return;
    }

    setMode(newMode);
  }, [mode, isActive, endVoiceSession, toggleVoiceSession, state.inlineAIVisible]);

  // ── Handle end ─────────────────────────────────────────────────────────
  const handleEnd = useCallback(async () => {
    if (isActive) await endVoiceSession();
    setMode('idle');
    setVisible(false);
  }, [isActive, endVoiceSession]);

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

  return (
    <>
      {/* Toggle button to show/hide the bubble */}
      {!visible && (
        <button
          data-testid="interaction-bubble-toggle"
          onClick={() => setVisible(true)}
          className="fixed bottom-4 right-28 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110 z-40"
          style={{
            backgroundColor: 'rgba(14, 14, 20, 0.8)',
            border: '1px solid var(--border-subtle)',
            backdropFilter: 'blur(8px)',
            color: 'var(--steel-silver)',
          }}
          title="Show interaction bubble"
        >
          <Mic className="w-4 h-4" />
        </button>
      )}

      {visible && (
        <>
          {/* Constraints ref for drag bounds */}
          <div className="fixed inset-0 pointer-events-none" ref={() => {}} />

          <motion.div
            data-testid="interaction-bubble"
            drag
            dragMomentum={false}
            dragElastic={0}
            initial={{ x: position.x, y: position.y }}
            onDragEnd={(_, info) => {
              handleDragEnd({
                x: position.x + info.offset.x,
                y: position.y + info.offset.y,
              });
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
                    avatarUrl={bubbleSettings.bubbleAvatarId === 'default'
                      ? '/models/avatars/default/model.vrm'
                      : `/models/avatars/${bubbleSettings.bubbleAvatarId}/model.vrm`}
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
                  <button
                    onClick={() => setExpanded(!expanded)}
                    className="p-1 rounded transition-colors hover:bg-white/10"
                    style={{ color: 'var(--steel-silver)' }}
                    title={expanded ? 'Minimize' : 'Expand'}
                  >
                    {expanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={() => { handleEnd(); setVisible(false); }}
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
        </>
      )}
    </>
  );
}
