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

import { useState, useEffect, useRef, useCallback, Suspense, Component, type ReactNode } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import { createWLipSyncNode, type WLipSyncAudioNode, type Profile } from 'wlipsync';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useApp } from '@/store/AppContext';
import { wsClient } from '@/lib/ws';
import { getToken } from '@/lib/auth';
import type { AgentEvent } from '@/types';
import { Mic, MicOff, PhoneOff, Loader2, Volume2 } from 'lucide-react';

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
}

// Vowel → VRM blendshape mapping (per VRM spec + Section 0 findings)
const VOWEL_TO_BLENDSHAPE: Record<string, string> = {
  A: 'aa',
  E: 'ee',
  I: 'ih',
  O: 'oh',
  U: 'ou',
};

function VRMModel({ amplitude, currentEmotion, audioSource, audioContext }: VRMModelProps) {
  const groupRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const blinkTimerRef = useRef(0);
  const blinkPhaseRef = useRef<'open' | 'closing' | 'opening'>('open');
  const blinkValueRef = useRef(0);
  const breathingRef = useRef(0);
  const currentBlendValues = useRef<Record<string, number>>({});
  const targetBlendValues = useRef<Record<string, number>>({});
  const lookAtTarget = useRef(new THREE.Vector3(0, 0, 3));
  const lipSyncNodeRef = useRef<WLipSyncAudioNode | null>(null);
  const lipSyncProfileRef = useRef<Profile | null>(null);
  const lipSyncLogTimer = useRef(0);

  // Load VRM model via GLTFLoader with VRMLoaderPlugin
  const gltf = useLoader(GLTFLoader, '/models/sample.vrm', (loader: GLTFLoader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  });

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
      // Disconnect old source from previous lip sync node
      try { audioSource.disconnect(lipSyncNodeRef.current); } catch { /* disconnect may fail */ }
    }

    createWLipSyncNode(audioContext, lipSyncProfileRef.current)
      .then(node => {
        lipSyncNodeRef.current = node;
        audioSource.connect(node);
        // Don't connect node to destination — we only read weights, don't need audio output
        console.log('[face] wlipsync node created and connected to audio source');
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
    lookAtTarget.current.set(mouseX, mouseY, 3);
    if (vrm.lookAt) {
      // lookAt target can be a Vector3 or Object3D — VRM handles both
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
      const lipSyncNode = lipSyncNodeRef.current;
      if (lipSyncNode && lipSyncNode.weights) {
        // Read vowel weights from wlipsync (A, E, I, O, U, S)
        const weights = lipSyncNode.weights;
        const volume = lipSyncNode.volume;

        // Map vowel weights to VRM blendshapes with volume scaling
        for (const [vowel, blendshape] of Object.entries(VOWEL_TO_BLENDSHAPE)) {
          const weight = weights[vowel] ?? 0;
          // Scale by volume (0-1) and apply a cap to prevent over-articulation
          const scaled = Math.min(1, weight * volume * 1.5);
          if (scaled > 0.01) {
            targetBlendValues.current[blendshape] = Math.max(
              targetBlendValues.current[blendshape] ?? 0,
              scaled
            );
          }
        }

        // Log vowel weights periodically (every ~500ms) for proof
        lipSyncLogTimer.current += delta;
        if (lipSyncLogTimer.current > 0.5 && volume > 0.05) {
          lipSyncLogTimer.current = 0;
          const topVowel = Object.entries(weights)
            .filter(([k]) => k in VOWEL_TO_BLENDSHAPE)
            .sort((a, b) => b[1] - a[1])[0];
          if (topVowel && topVowel[1] > 0.1) {
            console.log(`[face] lip sync: ${topVowel[0]}=${topVowel[1].toFixed(2)} vol=${volume.toFixed(2)} → ${VOWEL_TO_BLENDSHAPE[topVowel[0]]}=${(topVowel[1] * volume * 1.5).toFixed(2)}`);
          }
        }
      } else {
        // Fallback: amplitude-based mouth open if wlipsync not ready
        if (amplitude > 0.01) {
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
    </group>
  );
}

// ── Main FaceView component ──────────────────────────────────────────────

export default function FaceView() {
  const {
    isActive, isMuted, amplitude, sessionId, captions, visemeHint,
    startSession, endSession, toggleMute,
    setCaption, setVisemeHint, setAudioSource, clearAudioSource,
    currentAudioSource, audioContext,
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

          // VRM lip sync: amplitude from the audio source drives the 'aa'
          // blendshape directly in VRMModel's useFrame loop (via the
          // amplitude prop from VoiceSessionContext). The old text-based
          // viseme classification (classifyPhoneme) is no longer needed —
          // VRM's standardized blendshapes work with amplitude-driven mouth open.
          // We just need to connect the audio source so VoiceSessionContext
          // can compute amplitude from it.
          source.onended = () => {
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
          const audioCtx = new AudioContext();
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
            audioCtx.close();
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
              <VRMModel amplitude={amplitude} visemeHint={visemeHint} isActive={isActive} currentEmotion={currentEmotion} audioSource={currentAudioSource} audioContext={audioContext} />
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
