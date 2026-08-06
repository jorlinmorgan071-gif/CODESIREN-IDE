// app/src/pages/FaceView.tsx
// CHIMERA Avatar Engine — VRM-based avatar with expressions, lip sync, eye tracking.
//
// Replaces the old FBX + wireframe shader system with a VRM model loaded via
// @pixiv/three-vrm. VRM provides standardized blendshapes for expressions,
// spring bones for hair/cloth physics, and look-at bones for eye tracking.
// Lip sync is driven by wlipsync (MFCC-based WASM audio analysis).
//
// VRM blendshape names (standardized per VRM spec):
//   Mouth: aa, ee, ih, oh, ou (vowels for lip sync)
//   Emotions: happy, sad, angry, surprised, relaxed, neutral (expression presets)
//   Eyes: blink (left+right combined), lookAt (eye tracking via look-at bone)

import { useState, useEffect, useRef, useCallback, Suspense, Component, lazy, type ReactNode } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import { ChevronDown, User, Check, Upload, Trash2, Pencil, AlertTriangle } from 'lucide-react';
import { createWLipSyncNode, type WLipSyncAudioNode, type Profile } from 'wlipsync';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useApp } from '@/store/AppContext';
import { wsClient } from '@/lib/ws';
import { getToken } from '@/lib/auth';
import type { AgentEvent } from '@/types';
import { Mic, MicOff, PhoneOff, Loader2, Volume2 } from 'lucide-react';

// Phase B: Lazy-load the upload dialog (heavy: Three.js + VRM analysis)
const AvatarUploadDialogLazy = lazy(() =>
  import('@/components/avatar/AvatarUploadDialog').then(m => ({ default: m.AvatarUploadDialog }))
);

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

// ── FaceErrorBoundary ────────────────────────────────────────────────────

class FaceErrorBoundary extends Component<{ children: ReactNode; onError: (msg: string) => void }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: Error) { this.props.onError(err.message); }
  render() { return this.state.hasError ? null : this.props.children; }
}

// ── VRM Emotion System ───────────────────────────────────────────────────
// Reimplementation of AIRI's emotion→blendshape mapping in plain TypeScript.
// VRM blendshapes use standardized names: happy, sad, angry, surprised, relaxed, neutral.
// Each emotion maps to a set of blendshape values with lerp/easing transitions.

type EmotionId = 'happy' | 'sad' | 'angry' | 'think' | 'surprised' | 'neutral';

const EMOTION_BLENDSHAPES: Record<EmotionId, Record<string, number>> = {
  happy:     { happy: 0.7, aa: 0.2 },
  sad:       { sad: 0.7, oh: 0.15 },
  angry:     { angry: 0.7, ee: 0.3 },
  think:     { relaxed: 0.3, oh: 0.1 },
  surprised: { surprised: 0.8, aa: 0.3 },
  neutral:   {},
};

// ── VRM Model Component ──────────────────────────────────────────────────
// Loads a VRM model via @pixiv/three-vrm's GLTFLoader plugin, applies
// expression + lip sync + eye tracking in the animation loop.

interface VRMModelProps {
  amplitude: number;
  visemeHint: string;
  isActive: boolean;
  currentEmotion: EmotionId;
  audioSource: AudioNode | null;
  audioContext: AudioContext | null;
  avatarUrl: string;  // Phase B: dynamic avatar URL
}

// Vowel → VRM blendshape mapping (per VRM spec + Section 0 findings)
const VOWEL_TO_BLENDSHAPE: Record<string, string> = {
  A: 'aa',
  E: 'ee',
  I: 'ih',
  O: 'oh',
  U: 'ou',
};

function VRMModel({ amplitude, currentEmotion, audioSource, audioContext, avatarUrl }: VRMModelProps) {
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

  // Load VRM model via GLTFLoader with VRMLoaderPlugin — uses avatarUrl prop
  const gltf = useLoader(GLTFLoader, avatarUrl, (loader: GLTFLoader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  });

  // Phase B: Leak-free switching — when avatarUrl changes, deepDispose the old
  // model's GPU resources (geometries, textures, materials) AND clear R3F's
  // loader cache. useLoader.clear alone does NOT free GPU memory — it only
  // removes the entry from the cache Map. VRMUtils.deepDispose traverses the
  // scene graph and calls .dispose() on every geometry, material, and texture.
  const prevGltfRef = useRef<{ scene: THREE.Group; url: string } | null>(null);

  useEffect(() => {
    return () => {
      if (prevGltfRef.current && prevGltfRef.current.url !== avatarUrl) {
        try {
          // 1. deepDispose — frees GPU resources (geometries, textures, materials)
          VRMUtils.deepDispose(prevGltfRef.current.scene);
          console.log(`[face] deepDispose old avatar: ${prevGltfRef.current.url}`);
        } catch {
          // deepDispose may fail if already disposed
        }
        try {
          // 2. useLoader.clear — removes the entry from R3F's loader cache
          useLoader.clear(GLTFLoader, prevGltfRef.current.url);
        } catch {
          // cache entry may already be removed
        }
      }
    };
  }, [avatarUrl]);

  // Store the current gltf scene for disposal on next switch
  useEffect(() => {
    if (gltf?.scene) {
      prevGltfRef.current = { scene: gltf.scene, url: avatarUrl };
    }
  }, [gltf, avatarUrl]);

  useEffect(() => {
    if (!gltf) return;
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      console.error('[face] No VRM data in gltf.userData');
      return;
    }
    vrmRef.current = vrm;

    // Remove unnecessary materials/shaders — use VRM's built-in MToon shader
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    // VRMUtils.combineSkeletons(vrm); // type mismatch — skip for now

    // Log available blendshapes
    if (vrm.expressionManager) {
      const expressions = vrm.expressionManager.expressions;
      console.log(`[face] VRM loaded with ${expressions.length} expressions:`,
        expressions.map(e => e.expressionName).join(', '));
    }

    // Enable shadows
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // Load wlipsync profile (async, non-blocking)
    fetch('/models/lip-sync-profile.json')
      .then(res => res.json() as Promise<Profile>)
      .then(profile => {
        lipSyncProfileRef.current = profile;
        console.log('[face] wlipsync profile loaded:', profile.mfccs?.length, 'phonemes');
      })
      .catch(err => console.warn('[face] Failed to load lip-sync profile:', err));
  }, [gltf]);

  // Create/connect lip sync node when audio source changes
  useEffect(() => {
    if (!audioSource || !audioContext || !lipSyncProfileRef.current) return;
    if (lipSyncNodeRef.current) {
      try { audioSource.disconnect(lipSyncNodeRef.current); } catch { /* disconnect may fail */ }
    }

    createWLipSyncNode(audioContext, lipSyncProfileRef.current)
      .then(node => {
        lipSyncNodeRef.current = node;
        audioSource.connect(node);
        console.log('[face] wlipsync node created and connected to audio source');

        // Decoupled logging: setInterval reads weights every 200ms, independent
        // of requestAnimationFrame / useFrame frame rate. This ensures we capture
        // vowel weight values even in headless browsers where rAF runs at 1-5 FPS.
        const logInterval = setInterval(() => {
          const lsNode = lipSyncNodeRef.current;
          if (!lsNode || !lsNode.weights) return;
          const w = lsNode.weights;
          const vol = lsNode.volume || 0;
          const vowelStr = Object.entries(w)
            .filter(([k]) => k in VOWEL_TO_BLENDSHAPE)
            .map(([k, v]) => `${k}=${(v as number).toFixed(3)}`)
            .join(' ');
          // Mark silence state for debugging
          const silenceTag = vol <= 0.05 ? ' [SILENCE→blendshapes decaying]' : '';
          console.log(`[face] lip sync: ${vowelStr} vol=${vol.toFixed(3)}${silenceTag}`);
        }, 200);

        // Clear interval when audio source changes or component unmounts
        return () => clearInterval(logInterval);
      })
      .catch(err => console.warn('[face] Failed to create wlipsync node:', err));

    return () => {
      if (lipSyncNodeRef.current && audioSource) {
        try { audioSource.disconnect(lipSyncNodeRef.current); } catch { /* disconnect may fail */ }
      }
    };
  }, [audioSource, audioContext]);

  // Animation loop — drives expressions, blink, breathing, lip sync, eye tracking
  useFrame((state) => {
    const vrm = vrmRef.current;
    if (!vrm || !groupRef.current) return;

    const delta = state.clock.getDelta();
    const t = state.clock.elapsedTime;

    // Update VRM spring bones + look-at
    vrm.update(delta);

    // ── Idle breathing ──
    breathingRef.current += delta;
    groupRef.current.position.y = Math.sin(breathingRef.current * 0.5) * 0.02;
    groupRef.current.rotation.x = Math.sin(breathingRef.current * 0.3) * 0.01;
    groupRef.current.rotation.y = Math.sin(t * 0.1) * 0.05;

    // ── Eye tracking: cursor → look-at target ──
    const mouseX = (state.mouse.x * 0.5);
    const mouseY = (state.mouse.y * 0.3);
    lookAtTarget.current.position.set(mouseX, mouseY + 1, 3);
    if (vrm.lookAt) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vrm.lookAt as any).target = lookAtTarget.current;
    }

    // ── Blink cycle ──
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
        blinkTimerRef.current = 3000 + Math.random() * 3000;
      }
    }

    // ── Expression system: lerp toward target blendshape values ──
    const expr = vrm.expressionManager;
    if (expr) {
      // Set target values from current emotion
      targetBlendValues.current = { ...EMOTION_BLENDSHAPES[currentEmotion] ?? {} };

      // Add blink
      targetBlendValues.current['blink'] = blinkValueRef.current;

      // ── Real lip sync via wlipsync MFCC vowel analysis ──
      // Note: logging is done via setInterval in the useEffect above (decoupled
      // from useFrame frame rate). Here we just read weights and apply blendshapes.
      const lipSyncNode = lipSyncNodeRef.current;
      const SILENCE_THRESHOLD = 0.05;  // below this volume, treat as silence
      if (lipSyncNode && lipSyncNode.weights && lipSyncNode.volume > SILENCE_THRESHOLD) {
        const weights = lipSyncNode.weights;
        const volume = lipSyncNode.volume;

        // Map vowel weights to VRM blendshapes with volume scaling
        for (const [vowel, blendshape] of Object.entries(VOWEL_TO_BLENDSHAPE)) {
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
        // Silence or wlipsync not ready: don't set any vowel blendshape targets.
        // The lerp system below will smoothly decay existing values toward 0
        // (since targetBlendValues doesn't include vowel keys), returning the
        // mouth to neutral. This prevents the "frozen last vowel" issue where
        // wlipsync holds its last non-zero weights after audio ends.
        // Amplitude fallback for when wlipsync node doesn't exist yet:
        if (!lipSyncNode && amplitude > 0.01) {
          targetBlendValues.current['aa'] = Math.max(targetBlendValues.current['aa'] ?? 0, amplitude * 0.7);
        }
      }

      // Lerp current values toward targets
      const allKeys = new Set([...Object.keys(currentBlendValues.current), ...Object.keys(targetBlendValues.current)]);
      for (const key of allKeys) {
        const current = currentBlendValues.current[key] ?? 0;
        const target = targetBlendValues.current[key] ?? 0;
        const lerpSpeed = 8; // higher = faster transition
        const newVal = current + (target - current) * Math.min(1, delta * lerpSpeed);
        currentBlendValues.current[key] = newVal;
        expr.setValue(key, newVal);
      }

      // Apply expression updates
      expr.update();
    }
  });

  return (
    <group ref={groupRef}>
      <primitive object={gltf.scene} scale={1} position={[0, -1.2, 0]} />
      {/* Phase B: Soft blob shadow — a radial-gradient circle at the avatar's
          feet. Not a real shadow-map (which needs a directional light + ground
          plane + shadow camera). This is the VTuber/desktop-mascot technique:
          a simple semi-transparent ellipse that grounds the avatar visually.
          Positioned just below the model's base (y=-1.25), rotated flat (X=-90°)
          so it lies on the "ground" plane. The shadow follows the groupRef
          (which is animated by the breathing loop), so it stays attached
          during idle movement and future PIP dragging. */}
      <mesh position={[0, -1.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.6, 32]} />
        <meshBasicMaterial
          transparent
          opacity={0.5}
          depthWrite={false}
          side={THREE.DoubleSide}
          map={blobShadowTexture}
        />
      </mesh>
    </group>
  );
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

// ── Main FaceView component ──────────────────────────────────────────────

export default function FaceView() {
  const {
    isActive, isMuted, amplitude, sessionId, captions, visemeHint,
    startSession, endSession, toggleMute,
    setCaption, setVisemeHint, setAudioSource, clearAudioSource,
    currentAudioSource, audioContext, ensureAudioContext,
  } = useVoiceSession();
  // Auth-gate fix (Bug A): the WS listeners effect below subscribes to
  // voice:* events which carry auth-context. Don't attach them until
  // AppContext.authReady is true (i.e. until the WS connection is up
  // and the JWT is stored). The user-triggered handleStart already
  // happens after auth completes (button click), but the WS listener
  // registration itself is a mount-time effect — gating it prevents
  // events from being received before the connection is authenticated.
  const { state: appState } = useApp();
  const authReady = appState.authReady;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentEmotion, setCurrentEmotion] = useState<EmotionId>('neutral');
  const audioContextRef = useRef<AudioContext | null>(null);

  // Phase B: Avatar picker state
  const [avatarUrl, setAvatarUrl] = useState('/models/sample.vrm'); // default until settings load
  const [avatarList, setAvatarList] = useState<Array<{ id: string; name: string; thumbnail: string | null; format: string; expressionCount: number; isCustom?: boolean; issues?: string[] }>>([]);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [currentAvatarName, setCurrentAvatarName] = useState('Default Avatar');
  const [avatarSwitching, setAvatarSwitching] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [avatarToDelete, setAvatarToDelete] = useState<string | null>(null);
  const [avatarToRename, setAvatarToRename] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameConflict, setRenameConflict] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // ── Start a voice session ─────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    setError(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/voice/live/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { sessionId: string };
      startSession(body.sessionId);

      // Start recording from microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        // Send accumulated audio to server for ASR
        if (audioChunksRef.current.length === 0) return;
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        audioChunksRef.current = [];

        // Convert to ArrayBuffer and send via WS as binary.
        // Option C fix: pure audio data, no sessionId header. The server
        // routes the audio to the user's active voice session via their WS
        // auth state (state.claims.sub).
        const arrayBuffer = await blob.arrayBuffer();
        wsClient.send('voice:audio', arrayBuffer);
      };

      // Start recording in 1-second chunks
      recorder.start(1000);
      mediaRecorderRef.current = recorder;

      // Set up silence detection
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Connect mic to VoiceSessionContext for amplitude
      setAudioSource(source);

      // Silence detection loop
      const checkSilence = () => {
        if (!analyserRef.current || !isActive) return;
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;

        if (avg < 10) {  // silence threshold
          if (silenceTimerRef.current === null) {
            silenceTimerRef.current = setTimeout(() => {
              // Turn end detected — stop recording, send audio, restart
              if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                mediaRecorderRef.current.stop();
                mediaRecorderRef.current = null;
              }
              // Restart recording for next turn
              setTimeout(() => {
                if (isActive && mediaRecorderRef.current === null) {
                  const newRecorder = new MediaRecorder(stream);
                  newRecorder.ondataavailable = recorder.ondataavailable;
                  newRecorder.onstop = recorder.onstop;
                  newRecorder.start(1000);
                  mediaRecorderRef.current = newRecorder;
                }
              }, 500);
              silenceTimerRef.current = null;
            }, 1500);  // 1.5s of silence = turn end
          }
        } else {
          if (silenceTimerRef.current !== null) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        }

        requestAnimationFrame(checkSilence);
      };
      checkSilence();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [startSession, isActive, setAudioSource]);

  // ── End voice session ─────────────────────────────────────────────────
  const handleEnd = useCallback(async () => {
    // Stop recording
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }

    // Stop all media tracks
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Clear silence timer
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    clearAudioSource();

    // Tell server to end the session
    if (sessionId) {
      try {
        const token = getToken();
        await fetch(`${API_BASE}/voice/live/${sessionId}/end`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch { /* server may have already cleaned up */ }
    }

    endSession();
  }, [sessionId, endSession, clearAudioSource]);

  // ── Toggle mute ───────────────────────────────────────────────────────
  const handleMute = useCallback(async () => {
    toggleMute();
    if (sessionId) {
      try {
        const token = getToken();
        await fetch(`${API_BASE}/voice/live/${sessionId}/mute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ muted: !isMuted }),
        });
      } catch { /* */ }
    }
  }, [toggleMute, sessionId, isMuted]);

  // ── WS listeners for voice events ─────────────────────────────────────
  // Auth-gate fix (Bug A): don't attach WS listeners until authReady is
  // true. The handlers themselves don't fetch, but the WS connection is
  // only established after the JWT is stored, so attaching listeners
  // before that just registers dead handlers. Gating on authReady also
  // guarantees the user can never see stale events from a previous
  // session that were queued before auth completed.
  // Phase B: Fetch avatar settings + manifest on boot (after auth)
  useEffect(() => {
    if (!authReady) return;
    const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';
    const token = getToken() ?? '';

    // Fetch manifest (list of available avatars)
    fetch(`${API_BASE}/avatar/manifest`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.avatars && Array.isArray(data.avatars)) {
          setAvatarList(data.avatars.map((a: { id: string; name: string; thumbnail: string | null; format: string; expressionCount?: number; isCustom?: boolean; issues?: string[] }) => ({
            id: a.id,
            name: a.name,
            thumbnail: a.thumbnail,
            format: a.format,
            expressionCount: a.expressionCount ?? 0,
            isCustom: a.isCustom ?? false,
            issues: a.issues,
          })));
        }
      })
      .catch((err) => console.warn('[face] failed to fetch avatar manifest:', err));

    // Fetch persisted avatar settings
    fetch(`${API_BASE}/avatar/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.settings?.selectedAvatarId) {
          const id = data.settings.selectedAvatarId as string;
          const manifestEntry = avatarList.find((a) => a.id === id);
          // Build the URL — custom avatars served by API server, built-in by vite
          const isCustom = id.startsWith('custom-');
          const apiOrigin = API_BASE.replace(/\/api$/, '');
          const url = isCustom
            ? `${apiOrigin}/models/avatars/custom/${id}/model.vrm`
            : `/models/avatars/${id}/model.vrm`;
          setAvatarUrl(url);
          setCurrentAvatarName(manifestEntry?.name ?? id);
          console.log(`[face] loaded persisted avatar: ${id}`);
        }
      })
      .catch((err) => console.warn('[face] failed to fetch avatar settings:', err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady]);

  // Phase B: Handle avatar selection from picker
  const handleSelectAvatar = async (avatarId: string, name: string) => {
    // Custom avatars are served by the API server (not vite) because vite
    // doesn't reliably serve newly-created files in nested subdirectories.
    // Built-in avatars are served from vite's static public/ dir.
    const isCustom = avatarId.startsWith('custom-');
    const apiOrigin = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api').replace(/\/api$/, '');
    const newUrl = isCustom
      ? `${apiOrigin}/models/avatars/custom/${avatarId}/model.vrm`
      : `/models/avatars/${avatarId}/model.vrm`;
    if (newUrl === avatarUrl) {
      setShowAvatarPicker(false);
      return;
    }

    setAvatarSwitching(true);
    setShowAvatarPicker(false);

    // Persist to server
    const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';
    const token = getToken() ?? '';
    try {
      await fetch(`${API_BASE}/avatar/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ selectedAvatarId: avatarId }),
      });
    } catch (err) {
      console.warn('[face] failed to persist avatar selection:', err);
    }

    // Trigger the switch (useLoader will re-suspend with the new URL)
    setAvatarUrl(newUrl);
    setCurrentAvatarName(name);
    setLoading(true); // show loading spinner during switch

    // Reset state for new model
    setCurrentEmotion('neutral');
  };

  // Phase B: Refresh the avatar list from the server (after upload/delete/rename)
  const refreshAvatarList = useCallback(async () => {
    const token = getToken() ?? '';
    try {
      const res = await fetch(`${API_BASE}/avatar/manifest`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { avatars: any[] };
      if (data.avatars && Array.isArray(data.avatars)) {
        setAvatarList(data.avatars.map((a: any) => ({
          id: a.id,
          name: a.name,
          thumbnail: a.thumbnail,
          format: a.format,
          expressionCount: a.expressionCount ?? 0,
          isCustom: a.isCustom ?? false,
          issues: a.issues,
        })));
      }
    } catch (err) {
      console.warn('[face] failed to refresh avatar list:', err);
    }
  }, []);

  // Phase B: Handle custom avatar uploaded
  const handleAvatarUploaded = useCallback(async (newAvatar: any) => {
    setShowUploadDialog(false);
    await refreshAvatarList();
    // Auto-select the newly uploaded avatar
    if (newAvatar?.id) {
      handleSelectAvatar(newAvatar.id, newAvatar.name);
    }
  }, [refreshAvatarList]);

  // Phase B: Handle custom avatar delete
  const handleDeleteAvatar = useCallback(async (avatarId: string) => {
    const token = getToken() ?? '';
    try {
      const res = await fetch(`${API_BASE}/avatar/custom/${avatarId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        throw new Error(data.error ?? `Delete failed (${res.status})`);
      }
      const data = await res.json() as { settingsReset?: boolean };
      setAvatarToDelete(null);
      await refreshAvatarList();
      // If the deleted avatar was selected, the server reset to default —
      // update the UI to reflect that
      if (data.settingsReset) {
        setAvatarUrl('/models/avatars/default/model.vrm');
        setCurrentAvatarName('Default Avatar');
      }
    } catch (err: any) {
      console.error('[face] delete failed:', err);
      alert(`Failed to delete avatar: ${err.message}`);
    }
  }, [refreshAvatarList]);

  // Phase B: Start rename flow
  const handleStartRename = useCallback((avatarId: string, currentName: string) => {
    setAvatarToRename(avatarId);
    setRenameValue(currentName);
    setRenameConflict(false);
  }, []);

  // Phase B: Confirm rename
  const handleConfirmRename = useCallback(async () => {
    if (!avatarToRename || !renameValue.trim()) return;
    const token = getToken() ?? '';
    try {
      const res = await fetch(`${API_BASE}/avatar/custom/${avatarToRename}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        if (res.status === 409) {
          setRenameConflict(true);
          return;
        }
        throw new Error(data.error ?? `Rename failed (${res.status})`);
      }
      setAvatarToRename(null);
      setRenameValue('');
      setRenameConflict(false);
      await refreshAvatarList();
      // If we renamed the currently-selected avatar, update the display name
      const renamed = avatarList.find(a => a.id === avatarToRename);
      if (renamed && avatarUrl === `/models/avatars/${avatarToRename}/model.vrm`) {
        setCurrentAvatarName(renameValue.trim());
      }
    } catch (err: any) {
      console.error('[face] rename failed:', err);
      alert(`Failed to rename avatar: ${err.message}`);
    }
  }, [avatarToRename, renameValue, avatarList, avatarUrl, refreshAvatarList]);

  // Phase B: Debounced rename conflict check
  useEffect(() => {
    if (!avatarToRename || !renameValue.trim()) {
      setRenameConflict(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const token = getToken() ?? '';
        const res = await fetch(`${API_BASE}/avatar/custom/check-name?name=${encodeURIComponent(renameValue)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as { conflict: boolean };
        // Don't flag conflict if the name matches the avatar being renamed
        const currentAvatar = avatarList.find(a => a.id === avatarToRename);
        if (currentAvatar && currentAvatar.name.toLowerCase() === renameValue.trim().toLowerCase()) {
          setRenameConflict(false);
        } else {
          setRenameConflict(data.conflict);
        }
      } catch {
        // network error — don't block
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [renameValue, avatarToRename, avatarList]);

  // Phase B: Handle loading state during avatar switch
  useEffect(() => {
    if (avatarSwitching) {
      // Give the Suspense boundary time to catch + show the spinner
      const timer = setTimeout(() => setAvatarSwitching(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [avatarSwitching]);

  useEffect(() => {
    if (!authReady) return;
    const offTranscript = wsClient.on('voice:transcript' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { text: string; role: string };
      setCaption('user', payload.text);
      setCurrentEmotion('neutral');  // user speaking → neutral listening face
    });

    const offAgentChunk = wsClient.on('voice:agent-chunk' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { content: string };
      setIsProcessing(true);
      setCurrentEmotion('think');  // agent thinking/generating → think expression
      // Append to agent caption — read current from context
      setCaption('agent', captions.agent + payload.content);
    });

    const offAgentResponse = wsClient.on('voice:agent-response' as never, async (evt: AgentEvent) => {
      const payload = evt.payload as { text: string; audioBase64: string | null };
      setIsProcessing(false);
      setCaption('agent', payload.text);
      setCurrentEmotion('happy');  // response delivered → happy expression

      // Play TTS audio
      if (payload.audioBase64) {
        try {
          // Reuse the VoiceSessionContext's AudioContext — AudioNodes can
          // only connect within the same context. ensureAudioContext() creates
          // one if it doesn't exist yet (e.g., greeting arrives before
          // startSession() has run).
          const audioCtx = audioContext ?? ensureAudioContext();
          const audioBuffer = await audioCtx.decodeAudioData(
            Uint8Array.from(atob(payload.audioBase64), c => c.charCodeAt(0)).buffer
          );
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);
          source.start();

          // Connect to VoiceSessionContext for amplitude + lip sync driving
          setAudioSource(source);

          // VRM lip sync: amplitude from the audio source drives the 'aa'
          // blendshape directly in VRMModel's useFrame loop (via the
          // amplitude prop from VoiceSessionContext). The old text-based
          // viseme classification (classifyPhoneme) is no longer needed —
          // VRM's standardized blendshapes work with amplitude-driven mouth open.
          // We just need to connect the audio source so VoiceSessionContext
          // can compute amplitude from it.
          source.onended = () => {
            clearAudioSource();
            // Don't close audioCtx if it belongs to VoiceSessionContext
            if (!audioContext) {
              try { audioCtx.close(); } catch { /* already closed */ }
            }
          };
        } catch (err) {
          console.error('[face] TTS audio playback failed:', err);
        }
      }
    });

    const offAgentStart = wsClient.on('voice:agent-start' as never, () => {
      setIsProcessing(true);
      setCaption('agent', '');
      setCurrentEmotion('think');  // agent processing → think expression
    });

    const offError = wsClient.on('voice:error' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { error: string };
      setError(payload.error);
      setIsProcessing(false);
      setCurrentEmotion('sad');  // error → sad expression
    });

    const offEnded = wsClient.on('voice:session-ended' as never, () => {
      clearAudioSource();
    });

    const offAutoDisconnect = wsClient.on('voice:auto-disconnect' as never, () => {
      setError('Auto-disconnected after 90 seconds of silence');
      handleEnd();
    });

    // Wake greeting — fires once on session start. Shows greeting text as
    // caption and plays TTS audio if available.
    const offGreeting = wsClient.on('voice:greeting' as never, async (evt: AgentEvent) => {
      const payload = evt.payload as { text: string; audioBase64: string | null };
      setCaption('agent', payload.text);

      if (payload.audioBase64) {
        try {
          // Reuse the VoiceSessionContext's AudioContext — AudioNodes can
          // only connect within the same context. ensureAudioContext() creates
          // one if it doesn't exist yet.
          const audioCtx = audioContext ?? ensureAudioContext();
          const audioBuffer = await audioCtx.decodeAudioData(
            Uint8Array.from(atob(payload.audioBase64), c => c.charCodeAt(0)).buffer
          );
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);
          source.start();
          setAudioSource(source);
          source.onended = () => {
            clearAudioSource();
            if (!audioContext) {
              try { audioCtx.close(); } catch { /* already closed */ }
            }
          };
        } catch (err) {
          console.error('[face] greeting audio playback failed:', err);
        }
      }
    });

    return () => {
      offTranscript();
      offAgentChunk();
      offAgentResponse();
      offAgentStart();
      offError();
      offEnded();
      offAutoDisconnect();
      offGreeting();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCaption, setVisemeHint, setAudioSource, clearAudioSource, handleEnd, authReady]);

  // ── Navigate back ─────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    if (isActive) handleEnd();
    window.history.back();
  }, [isActive, handleEnd]);

  return (
    <div className="h-screen w-screen flex flex-col" style={{ backgroundColor: '#07070B' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <button onClick={handleBack} className="p-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)]" style={{ color: 'var(--steel-silver)' }}>
          <PhoneOff className="w-4 h-4" />
        </button>
        <span className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
          Face Avatar {isActive && <span style={{ color: 'var(--siren-red)' }}>• LIVE</span>}
        </span>
        <div className="w-6" />
      </div>

      {/* 3D Scene */}
      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--siren-red)' }} />
          </div>
        )}

        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 px-3 py-2 rounded-md text-[12px]"
            style={{ backgroundColor: 'rgba(238, 28, 28, 0.15)', border: '1px solid rgba(238, 28, 28, 0.4)', color: 'var(--siren-red)' }}>
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
          </div>
        )}

        <Canvas
          camera={{ position: [0, 0, 3], fov: 45 }}
          gl={{ antialias: true, alpha: true }}
          onCreated={() => setLoading(false)}
        >
          <ambientLight intensity={0.3} />
          <pointLight position={[0, 2, 3]} intensity={1} color="#00BFFF" />
          <pointLight position={[0, -2, 1]} intensity={0.5} color="#0088FF" />

          {/* Fix 2 — Suspense boundary INSIDE the Canvas to catch the
              Promise that useLoader throws while the FBX is loading.
              fallback={null} means the Canvas shows nothing (transparent)
              during load — the existing loading spinner in FaceView
              already handles this. The FaceErrorBoundary catches any
              load errors (e.g. 404, malformed FBX), turns off the
              loading spinner, and surfaces a clear error message
              rather than crashing the Canvas silently. */}
          <Suspense fallback={null}>
            <FaceErrorBoundary
              onError={(msg) => {
                setLoading(false);
                setError(`3D model failed to load: ${msg}`);
              }}
            >
              <VRMModel amplitude={amplitude} visemeHint={visemeHint} isActive={isActive} currentEmotion={currentEmotion} audioSource={currentAudioSource} audioContext={audioContext} avatarUrl={avatarUrl} />
            </FaceErrorBoundary>
          </Suspense>

          <OrbitControls enablePan={false} enableZoom={true} minDistance={1.5} maxDistance={6} />
        </Canvas>

        {/* Phase B: Avatar Picker — top-right corner, doesn't obscure the 3D render */}
        <div className="absolute top-3 right-3 z-20">
          <button
            onClick={() => setShowAvatarPicker(!showAvatarPicker)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] transition-colors"
            style={{
              backgroundColor: 'rgba(14, 14, 20, 0.8)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--bright-silver)',
            }}
          >
            <User className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
            <span>{currentAvatarName}</span>
            <ChevronDown className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
          </button>

          {showAvatarPicker && (
            <div
              className="absolute top-full right-0 mt-1 w-72 rounded-lg overflow-hidden shadow-xl max-h-[70vh] flex flex-col"
              style={{
                backgroundColor: 'rgba(14, 14, 20, 0.95)',
                backdropFilter: 'blur(12px)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {avatarList.length === 0 && (
                <div className="px-3 py-4 text-[11px] text-center" style={{ color: 'var(--steel-silver)' }}>
                  Loading avatars...
                </div>
              )}

              {/* Avatar list — scrollable */}
              <div className="overflow-y-auto flex-1">
                {avatarList.map((avatar) => {
                  // Selected check — handles both built-in (vite-served) and
                  // custom (API-served) avatar URL formats
                  const expectedUrl = avatar.isCustom
                    ? `${API_BASE.replace(/\/api$/, '')}/models/avatars/custom/${avatar.id}/model.vrm`
                    : `/models/avatars/${avatar.id}/model.vrm`;
                  const isSelected = avatarUrl === expectedUrl || avatarUrl === `/models/avatars/${avatar.id}/model.vrm`;
                  const isCustom = avatar.isCustom;
                  const isRenaming = avatarToRename === avatar.id;
                  return (
                    <div
                      key={avatar.id}
                      className="group relative"
                      style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    >
                      {isRenaming ? (
                        /* Inline rename input */
                        <div className="p-2.5 space-y-2">
                          <input
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            maxLength={60}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleConfirmRename();
                              if (e.key === 'Escape') { setAvatarToRename(null); setRenameValue(''); }
                            }}
                            className="w-full px-2 py-1 rounded text-[12px] outline-none"
                            style={{
                              backgroundColor: 'rgba(255,255,255,0.05)',
                              border: `1px solid ${renameConflict ? 'var(--siren-red)' : 'rgba(238, 28, 28, 0.3)'}`,
                              color: 'var(--bright-silver)',
                            }}
                          />
                          {renameConflict && (
                            <div className="text-[10px]" style={{ color: 'var(--siren-red)' }}>
                              Name already taken
                            </div>
                          )}
                          <div className="flex gap-1">
                            <button
                              onClick={handleConfirmRename}
                              disabled={!renameValue.trim() || renameConflict}
                              className="flex-1 px-2 py-1 rounded text-[11px] transition-colors disabled:opacity-40"
                              style={{ backgroundColor: 'rgba(238, 28, 28, 0.2)', color: 'var(--bright-silver)' }}
                            >
                              Save
                            </button>
                            <button
                              onClick={() => { setAvatarToRename(null); setRenameValue(''); }}
                              className="flex-1 px-2 py-1 rounded text-[11px] transition-colors"
                              style={{ backgroundColor: 'rgba(255,255,255,0.05)', color: 'var(--steel-silver)' }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleSelectAvatar(avatar.id, avatar.name)}
                          className="flex items-center gap-3 w-full px-3 py-2.5 text-left transition-colors hover:bg-white/5"
                        >
                          {/* Thumbnail — custom avatars get red border glow */}
                          {avatar.thumbnail ? (
                            <img
                              src={avatar.thumbnail}
                              alt={avatar.name}
                              className="w-10 h-10 rounded object-cover flex-shrink-0"
                              style={{
                                border: isCustom
                                  ? '1px solid rgba(238, 28, 28, 0.6)'
                                  : '1px solid var(--border-subtle)',
                                boxShadow: isCustom
                                  ? '0 0 8px rgba(238, 28, 28, 0.4)'
                                  : 'none',
                              }}
                            />
                          ) : (
                            <div
                              className="w-10 h-10 rounded flex items-center justify-center flex-shrink-0"
                              style={{
                                backgroundColor: 'var(--surface-raised)',
                                border: isCustom
                                  ? '1px solid rgba(238, 28, 28, 0.6)'
                                  : '1px solid var(--border-subtle)',
                                boxShadow: isCustom
                                  ? '0 0 8px rgba(238, 28, 28, 0.4)'
                                  : 'none',
                              }}
                            >
                              <User className="w-4 h-4" style={{ color: 'var(--steel-silver)' }} />
                            </div>
                          )}

                          {/* Name + metadata — custom avatars get red neon glow on name */}
                          <div className="flex-1 min-w-0">
                            <div
                              className="text-[12px] font-medium truncate"
                              style={{
                                color: isCustom ? '#ff4444' : 'var(--bright-silver)',
                                textShadow: isCustom
                                  ? '0 0 5px rgba(238, 28, 28, 0.8), 0 0 10px rgba(238, 28, 28, 0.6), 0 0 15px rgba(238, 28, 28, 0.4)'
                                  : 'none',
                              }}
                            >
                              {avatar.name}
                            </div>
                            <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                              VRM {avatar.format} · {avatar.expressionCount} expressions
                              {isCustom && <span style={{ color: 'rgba(238, 28, 28, 0.7)' }}> · custom</span>}
                            </div>
                            {/* Issues warning */}
                            {avatar.issues && avatar.issues.length > 0 && (
                              <div className="flex items-center gap-1 mt-0.5 text-[9px]" style={{ color: 'rgba(251, 191, 36, 0.8)' }}>
                                <AlertTriangle className="w-2.5 h-2.5" />
                                {avatar.issues.length} issue{avatar.issues.length === 1 ? '' : 's'}
                              </div>
                            )}
                          </div>

                          {/* Selected indicator */}
                          {isSelected && (
                            <Check className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--siren-red)' }} />
                          )}
                        </button>
                      )}

                      {/* Rename + Delete buttons for custom avatars (appear on hover) */}
                      {isCustom && !isRenaming && (
                        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartRename(avatar.id, avatar.name);
                            }}
                            className="p-1 rounded hover:bg-white/10"
                            title="Rename"
                          >
                            <Pencil className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setAvatarToDelete(avatar.id);
                            }}
                            className="p-1 rounded hover:bg-white/10"
                            title="Delete"
                          >
                            <Trash2 className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Footer: Add Custom Model button */}
              <button
                onClick={() => {
                  setShowAvatarPicker(false);
                  setShowUploadDialog(true);
                }}
                className="flex items-center justify-center gap-2 px-3 py-2.5 text-[12px] font-medium transition-colors hover:bg-white/5"
                style={{
                  borderTop: '1px solid rgba(238, 28, 28, 0.2)',
                  backgroundColor: 'rgba(238, 28, 28, 0.05)',
                  color: 'var(--bright-silver)',
                }}
              >
                <Upload className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
                Add Custom Model
              </button>
            </div>
          )}
        </div>

        {/* Phase B: Custom avatar upload dialog */}
        {showUploadDialog && (
          <AvatarUploadDialogLazy
            onClose={() => setShowUploadDialog(false)}
            onUploaded={handleAvatarUploaded}
          />
        )}

        {/* Phase B: Delete confirmation dialog */}
        {avatarToDelete && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
            onClick={() => setAvatarToDelete(null)}
          >
            <div
              className="w-[min(400px,90vw)] rounded-xl p-5"
              style={{
                backgroundColor: 'rgba(7, 7, 11, 0.95)',
                border: '1px solid rgba(238, 28, 28, 0.3)',
                boxShadow: '0 0 30px rgba(238, 28, 28, 0.2)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-5 h-5" style={{ color: 'var(--siren-red)' }} />
                <span className="text-[14px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                  Delete Custom Avatar?
                </span>
              </div>
              <p className="text-[12px] mb-4" style={{ color: 'var(--steel-silver)' }}>
                This will permanently delete the model file and remove it from your avatar list. This action cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setAvatarToDelete(null)}
                  className="flex-1 px-3 py-2 rounded-lg text-[12px] transition-colors"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--steel-silver)',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteAvatar(avatarToDelete)}
                  className="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors"
                  style={{
                    backgroundColor: 'rgba(238, 28, 28, 0.2)',
                    border: '1px solid rgba(238, 28, 28, 0.4)',
                    color: 'var(--bright-silver)',
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Avatar switching loading indicator */}
        {avatarSwitching && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20">
            <div className="text-[12px] px-4 py-2 rounded-lg" style={{
              backgroundColor: 'rgba(14, 14, 20, 0.9)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--steel-silver)',
            }}>
              Switching avatar...
            </div>
          </div>
        )}

        {/* Live captions */}
        {(captions.user || captions.agent) && (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 z-10 space-y-2">
            {captions.user && (
              <div className="text-[13px] p-2.5 rounded-lg" style={{ backgroundColor: 'rgba(14, 14, 20, 0.8)', backdropFilter: 'blur(8px)', border: '1px solid var(--border-subtle)' }}>
                <span className="text-[10px] uppercase tracking-wider mr-2" style={{ color: 'var(--steel-silver)' }}>You:</span>
                <span style={{ color: 'var(--bright-silver)' }}>{captions.user}</span>
              </div>
            )}
            {captions.agent && (
              <div className="text-[13px] p-2.5 rounded-lg" style={{ backgroundColor: 'rgba(14, 14, 20, 0.8)', backdropFilter: 'blur(8px)', border: '1px solid rgba(0, 191, 255, 0.3)' }}>
                <span className="text-[10px] uppercase tracking-wider mr-2" style={{ color: 'var(--steel-silver)' }}>AI:</span>
                <span style={{ color: 'var(--bright-silver)' }}>{captions.agent}</span>
                {isProcessing && <Loader2 className="inline-block w-3 h-3 ml-2 animate-spin" style={{ color: 'var(--siren-red)' }} />}
              </div>
            )}
          </div>
        )}

        {/* Session controls */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 z-10">
          {!isActive ? (
            <button
              onClick={handleStart}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-medium transition-all hover:scale-105"
              style={{ backgroundColor: 'var(--siren-red)', color: 'white', boxShadow: '0 4px 20px rgba(238, 28, 28, 0.4)' }}
            >
              <Mic className="w-4 h-4" />
              Start Voice Call
            </button>
          ) : (
            <>
              {/* Mute */}
              <button
                onClick={handleMute}
                className="flex items-center justify-center w-11 h-11 rounded-full transition-all hover:scale-105"
                style={{
                  backgroundColor: isMuted ? 'rgba(238, 28, 28, 0.2)' : 'var(--surface-raised)',
                  border: '1px solid var(--border-subtle)',
                  color: isMuted ? 'var(--siren-red)' : 'var(--steel-silver)',
                }}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>

              {/* End call */}
              <button
                onClick={handleEnd}
                className="flex items-center justify-center w-11 h-11 rounded-full transition-all hover:scale-105"
                style={{ backgroundColor: 'var(--siren-red)', color: 'white' }}
                title="End call"
              >
                <PhoneOff className="w-4 h-4" />
              </button>

              {/* Volume indicator */}
              <div className="flex items-center gap-1 px-3 py-2 rounded-full" style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
                <Volume2 className="w-3.5 h-3.5" style={{ color: 'var(--steel-silver)' }} />
                <div className="w-16 h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--border-subtle)' }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${amplitude * 100}%`, backgroundColor: 'var(--siren-red)' }} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
