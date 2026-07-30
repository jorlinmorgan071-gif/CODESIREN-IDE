// app/src/pages/FaceView.tsx
// Face Avatar + Live Voice Pipeline — 3D rigged face with blendshapes.
//
// Loads the Lisa FBX model, applies a wireframe + emissive glow shader,
// drives blendshape weights from VoiceSessionContext's amplitude + viseme data.
//
// Section 1 blendshape names — ONLY these are used, no hardcoded guesses:
//   Visemes: AA, CH, DD, EE, FF, IH, KK, NN, OH, OU, PP, RR, TH
//   Jaw: JawOpen, JawFwd, JawLeft, JawRight
//   Lips: LipsFunnel, LipsPucker, LipsLowerClose, LipsLowerDown, LipsLowerOpen,
//         LipsUpperClose, LipsUpperOpen, LipsUpperUp
//   Mouth: MouthDimple_L, MouthDimple_R, MouthFrown_L, MouthFrown_R,
//          MouthLeft, MouthRight, MouthSmile_L, MouthSmile_R, Puff, Sneer
//   Eyes: EyeBlink_L, EyeBlink_R, EyeOpen_L, EyeOpen_R, EyeSquint_L, EyeSquint_R,
//         EyesDown, EyesLeft, EyesRight, EyesUp
//   Brows: BrowsD_L, BrowsD_R, BrowsU_C, BrowsU_L, BrowsU_R
//   Base: Basis, base_head

import { useState, useEffect, useRef, useCallback, Suspense, Component, type ReactNode } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { FBXLoader } from 'three-stdlib';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useApp } from '@/store/AppContext';
import { wsClient } from '@/lib/ws';
import { getToken } from '@/lib/auth';
import type { AgentEvent } from '@/types';
import { Mic, MicOff, PhoneOff, Loader2, Volume2 } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

// ── FaceErrorBoundary ────────────────────────────────────────────────────
// Fix 2 — React Three Fiber's useLoader uses the Suspense protocol: it
// throws a Promise while loading and throws an Error if the load fails.
// Without a Suspense boundary INSIDE the Canvas, the thrown Error
// propagates OUTSIDE the Canvas into FaceView's render cycle, corrupting
// the outer component's state and producing a red error banner.
// This ErrorBoundary catches loader errors, turns off the loading spinner,
// and surfaces a clear error message rather than crashing the Canvas.

interface FaceErrorBoundaryProps {
  children: ReactNode;
  onError: (msg: string) => void;
}

interface FaceErrorBoundaryState {
  hasError: boolean;
}

class FaceErrorBoundary extends Component<FaceErrorBoundaryProps, FaceErrorBoundaryState> {
  state: FaceErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): FaceErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(err: Error): void {
    this.props.onError(err.message);
  }

  render(): ReactNode {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

// ── Confirmed blendshape names (Section 1) ────────────────────────────────
const VISEME_SHAPES = ['AA', 'CH', 'DD', 'EE', 'FF', 'IH', 'KK', 'NN', 'OH', 'OU', 'PP', 'RR', 'TH'];
const JAW_SHAPES = ['JawOpen', 'JawFwd', 'JawLeft', 'JawRight'];
const LIP_SHAPES = ['LipsFunnel', 'LipsPucker', 'LipsLowerClose', 'LipsLowerDown', 'LipsLowerOpen', 'LipsUpperClose', 'LipsUpperOpen', 'LipsUpperUp'];
const MOUTH_SHAPES = ['MouthDimple_L', 'MouthDimple_R', 'MouthFrown_L', 'MouthFrown_R', 'MouthLeft', 'MouthRight', 'MouthSmile_L', 'MouthSmile_R', 'Puff', 'Sneer'];
const EYE_SHAPES = ['EyeBlink_L', 'EyeBlink_R', 'EyeOpen_L', 'EyeOpen_R', 'EyeSquint_L', 'EyeSquint_R', 'EyesDown', 'EyesLeft', 'EyesRight', 'EyesUp'];
const BROW_SHAPES = ['BrowsD_L', 'BrowsD_R', 'BrowsU_C', 'BrowsU_L', 'BrowsU_R'];

// All confirmed shapes in one array
const ALL_CONFIRMED_SHAPES = [...VISEME_SHAPES, ...JAW_SHAPES, ...LIP_SHAPES, ...MOUTH_SHAPES, ...EYE_SHAPES, ...BROW_SHAPES];

// ── 5-category phoneme → viseme mapping (Section 1) ──────────────────────
// Open vowel (AH/AA)  → AA + JawOpen
// Front vowel (EE/IH) → EE or IH
// Rounded vowel (OH/OU) → OH or OU + LipsFunnel
// Bilabial (PP/BB/MM) → PP (lips together)
// Default/rest        → neutral, JawOpen driven by amplitude only

const PHONEME_MAP: Record<string, { shapes: string[], weight: number }> = {
  open:    { shapes: ['AA', 'JawOpen'], weight: 0.8 },
  front:   { shapes: ['EE', 'IH'], weight: 0.6 },
  rounded: { shapes: ['OH', 'OU', 'LipsFunnel'], weight: 0.7 },
  bilabial:{ shapes: ['PP'], weight: 0.9 },
  rest:    { shapes: [], weight: 0 },
};

// ── Phoneme classifier — simple text-based heuristics (Section 3) ────────
function classifyPhoneme(text: string, charIndex: number): string {
  if (charIndex >= text.length) return 'rest';
  const char = text[charIndex].toLowerCase();
  const nextChar = text[charIndex + 1]?.toLowerCase() ?? '';

  // Bilabial: P, B, M
  if ('pbm'.includes(char)) return 'bilabial';

  // Open vowels: A, and AH/AA patterns
  if (char === 'a' || (char === 'a' && 'ah'.includes(nextChar))) return 'open';

  // Front vowels: E, I
  if ('ei'.includes(char)) return 'front';

  // Rounded vowels: O, U
  if ('ou'.includes(char)) return 'rounded';

  // Default
  return 'rest';
}

// ── Wireframe + emissive glow shader material ────────────────────────────
function createWireframeGlowMaterial(amplitude: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAmplitude: { value: amplitude },
      uGlowColor: { value: new THREE.Color('#00BFFF') },  // cyber-mesh blue
      uBaseColor: { value: new THREE.Color('#001833') },
      uWireframeColor: { value: new THREE.Color('#00FFFF') },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uAmplitude;
      uniform vec3 uGlowColor;
      uniform vec3 uBaseColor;
      uniform vec3 uWireframeColor;
      varying vec3 vNormal;
      varying vec3 vPosition;

      void main() {
        // Fresnel glow — brighter at edges
        float fresnel = 1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0)));
        fresnel = pow(fresnel, 2.0);

        // Base color with amplitude-driven glow
        vec3 color = mix(uBaseColor, uGlowColor, fresnel * (0.3 + uAmplitude * 0.7));

        // Wireframe lines — simulate via position-based grid
        float wireX = abs(fract(vPosition.x * 20.0) - 0.5);
        float wireY = abs(fract(vPosition.y * 20.0) - 0.5);
        float wireZ = abs(fract(vPosition.z * 20.0) - 0.5);
        float wire = min(min(wireX, wireY), wireZ);
        float wireIntensity = smoothstep(0.45, 0.5, 1.0 - wire) * (0.3 + uAmplitude * 0.5);

        color = mix(color, uWireframeColor, wireIntensity * 0.6);

        // Pulsing glow
        float pulse = sin(uTime * 2.0) * 0.1 + 0.9;
        color *= pulse * (0.7 + uAmplitude * 0.6);

        gl_FragColor = vec4(color, 1.0);
      }
    `,
    wireframe: false,  // We do custom wireframe in the shader
  });
}

// ── 3D Face mesh component ───────────────────────────────────────────────

interface FaceMeshProps {
  amplitude: number;
  visemeHint: string;
  isActive: boolean;
}

function FaceMesh({ amplitude, visemeHint, isActive }: FaceMeshProps) {
  const meshRef = useRef<THREE.Group>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const blinkTimerRef = useRef<number>(0);
  const blinkPhaseRef = useRef<'open' | 'closing' | 'opening'>('open');
  const blinkValueRef = useRef(0);
  const breathingRef = useRef(0);

  // Load the FBX model
  // Fix 1 — use absolute path '/models/lisa.fbx' instead of relative
  // './models/lisa.fbx'. When the app is at /face, the relative path
  // resolves to /face/models/lisa.fbx (404). Files in app/public/ are
  // served from the root, so the absolute path works on every route.
  const fbx = useLoader(FBXLoader, '/models/lisa.fbx');

  // Apply wireframe shader to all meshes in the model
  useEffect(() => {
    if (!fbx) return;

    fbx.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        // Create shader material for this mesh
        const mat = createWireframeGlowMaterial(0);
        child.material = mat;
        if (!materialRef.current) materialRef.current = mat;

        // Enable morph targets (blendshapes)
        if (child.morphTargetDictionary && child.morphTargetInfluences) {
          // Log available blendshapes for verification
          const available = Object.keys(child.morphTargetDictionary);
          const confirmed = ALL_CONFIRMED_SHAPES.filter(s => available.includes(s));
          const unconfirmed = available.filter(s => !ALL_CONFIRMED_SHAPES.includes(s));
          console.log(`[face] Mesh has ${available.length} morph targets. Confirmed: ${confirmed.length}, Unconfirmed: ${unconfirmed.length}`);
          if (unconfirmed.length > 0) {
            console.log(`[face] Unconfirmed shapes (not used): ${unconfirmed.join(', ')}`);
          }
        }
      }
    });
  }, [fbx]);

  // Animation loop
  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;

    // Update shader uniforms
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = t;
      materialRef.current.uniforms.uAmplitude.value = amplitude;
    }

    // Idle breathing — subtle head movement (even when not in a session)
    breathingRef.current += 0.01;
    const breathY = Math.sin(breathingRef.current * 0.5) * 0.02;
    const breathX = Math.sin(breathingRef.current * 0.3) * 0.01;
    meshRef.current.position.y = breathY;
    meshRef.current.rotation.x = breathX;
    meshRef.current.rotation.y = Math.sin(t * 0.1) * 0.05;  // slow idle rotation

    // ── Blink cycle (3-6 second random, fast close ~80ms, slow open ~200ms) ──
    blinkTimerRef.current -= state.clock.getDelta() * 1000;
    if (blinkPhaseRef.current === 'open' && blinkTimerRef.current <= 0) {
      blinkPhaseRef.current = 'closing';
      blinkTimerRef.current = 80;  // 80ms close
    } else if (blinkPhaseRef.current === 'closing') {
      blinkValueRef.current = Math.min(1, blinkValueRef.current + state.clock.getDelta() * 12);
      if (blinkValueRef.current >= 1) {
        blinkPhaseRef.current = 'opening';
        blinkTimerRef.current = 200;  // 200ms open
      }
    } else if (blinkPhaseRef.current === 'opening') {
      blinkValueRef.current = Math.max(0, blinkValueRef.current - state.clock.getDelta() * 5);
      if (blinkValueRef.current <= 0) {
        blinkPhaseRef.current = 'open';
        blinkTimerRef.current = 3000 + Math.random() * 3000;  // 3-6s until next blink
      }
    }

    // ── Drive blendshapes ──────────────────────────────────────────────
    fbx.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (!child.morphTargetDictionary || !child.morphTargetInfluences) return;

      const dict = child.morphTargetDictionary;
      const inf = child.morphTargetInfluences;

      // JawOpen — primary lip-sync target, driven by amplitude
      if ('JawOpen' in dict) {
        inf[dict['JawOpen']] = amplitude * 0.8;
      }

      // Viseme shapes based on current phoneme category
      const visemeConfig = PHONEME_MAP[visemeHint] ?? PHONEME_MAP.rest;
      for (const shape of visemeConfig.shapes) {
        if (shape in dict) {
          inf[dict[shape]] = visemeConfig.weight * (0.5 + amplitude * 0.5);
        }
      }

      // Reset non-active viseme shapes to 0 (gradually)
      for (const shape of VISEME_SHAPES) {
        if (!visemeConfig.shapes.includes(shape) && shape in dict) {
          inf[dict[shape]] *= 0.85;  // decay
        }
      }

      // Blink — EyeBlink_L and EyeBlink_R together
      if ('EyeBlink_L' in dict) inf[dict['EyeBlink_L']] = blinkValueRef.current;
      if ('EyeBlink_R' in dict) inf[dict['EyeBlink_R']] = blinkValueRef.current;

      // Subtle smile when active ( MouthSmile_L, MouthSmile_R )
      if (isActive) {
        if ('MouthSmile_L' in dict) inf[dict['MouthSmile_L']] = Math.max(inf[dict['MouthSmile_L']] ?? 0, 0.15);
        if ('MouthSmile_R' in dict) inf[dict['MouthSmile_R']] = Math.max(inf[dict['MouthSmile_R']] ?? 0, 0.15);
      }
    });
  });

  return <primitive ref={meshRef} object={fbx} scale={0.01} position={[0, -0.5, 0]} />;
}

// ── Main FaceView component ──────────────────────────────────────────────

export default function FaceView() {
  const {
    isActive, isMuted, amplitude, sessionId, captions, visemeHint,
    startSession, endSession, toggleMute,
    setCaption, setVisemeHint, setAudioSource, clearAudioSource,
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
  const audioContextRef = useRef<AudioContext | null>(null);
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

        // Convert to ArrayBuffer and send via WS as binary
        const arrayBuffer = await blob.arrayBuffer();
        // Pad session ID to 16 bytes
        const sessionIdPadded = (sessionId ?? '').padEnd(16, '\0').slice(0, 16);
        const combined = new Uint8Array(16 + arrayBuffer.byteLength);
        combined.set(new TextEncoder().encode(sessionIdPadded), 0);
        combined.set(new Uint8Array(arrayBuffer), 16);

        wsClient.send('voice:audio', combined.buffer);
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
  }, [startSession, sessionId, isActive, setAudioSource]);

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
  useEffect(() => {
    if (!authReady) return;
    const offTranscript = wsClient.on('voice:transcript' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { text: string; role: string };
      setCaption('user', payload.text);
    });

    const offAgentChunk = wsClient.on('voice:agent-chunk' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { content: string };
      setIsProcessing(true);
      // Append to agent caption — read current from context
      setCaption('agent', captions.agent + payload.content);
    });

    const offAgentResponse = wsClient.on('voice:agent-response' as never, async (evt: AgentEvent) => {
      const payload = evt.payload as { text: string; audioBase64: string | null };
      setIsProcessing(false);
      setCaption('agent', payload.text);

      // Play TTS audio
      if (payload.audioBase64) {
        try {
          const audioCtx = new AudioContext();
          const audioBuffer = await audioCtx.decodeAudioData(
            Uint8Array.from(atob(payload.audioBase64), c => c.charCodeAt(0)).buffer
          );
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);
          source.start();

          // Connect to VoiceSessionContext for amplitude + viseme driving
          setAudioSource(source);

          // Drive visemes from the response text
          const text = payload.text;
          let charIdx = 0;
          const visemeInterval = setInterval(() => {
            if (charIdx >= text.length) {
              setVisemeHint('rest');
              clearInterval(visemeInterval);
              return;
            }
            const phoneme = classifyPhoneme(text, charIdx);
            setVisemeHint(phoneme);
            charIdx++;
          }, 80);  // ~12 chars/sec

          source.onended = () => {
            clearInterval(visemeInterval);
            setVisemeHint('rest');
            clearAudioSource();
            audioCtx.close();
          };
        } catch (err) {
          console.error('[face] TTS audio playback failed:', err);
        }
      }
    });

    const offAgentStart = wsClient.on('voice:agent-start' as never, () => {
      setIsProcessing(true);
      setCaption('agent', '');
    });

    const offError = wsClient.on('voice:error' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { error: string };
      setError(payload.error);
      setIsProcessing(false);
    });

    const offEnded = wsClient.on('voice:session-ended' as never, () => {
      clearAudioSource();
    });

    const offAutoDisconnect = wsClient.on('voice:auto-disconnect' as never, () => {
      setError('Auto-disconnected after 90 seconds of silence');
      handleEnd();
    });

    return () => {
      offTranscript();
      offAgentChunk();
      offAgentResponse();
      offAgentStart();
      offError();
      offEnded();
      offAutoDisconnect();
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
              <FaceMesh amplitude={amplitude} visemeHint={visemeHint} isActive={isActive} />
            </FaceErrorBoundary>
          </Suspense>

          <OrbitControls enablePan={false} enableZoom={true} minDistance={1.5} maxDistance={6} />
        </Canvas>

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
