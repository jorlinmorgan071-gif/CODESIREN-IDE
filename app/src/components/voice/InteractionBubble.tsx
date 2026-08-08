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

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useApp } from '@/store/AppContext';
import { themes } from '@/store/themes';
import { Mic, MicOff, PhoneOff, Monitor, Video, Maximize2, Minimize2, X } from 'lucide-react';
import { getToken } from '@/lib/auth';

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

// ── BubbleCaption (reads existing VoiceSessionContext captions) ──────────
function BubbleCaption({ captions }: { captions: { user: string; agent: string } }) {
  if (!captions.user && !captions.agent) return null;
  return (
    <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 max-w-[250px] space-y-1">
      {captions.user && (
        <div className="text-[10px] p-1.5 rounded-md" style={{ backgroundColor: 'rgba(14, 14, 20, 0.9)', border: '1px solid var(--border-subtle)' }}>
          <span className="text-[8px] uppercase mr-1" style={{ color: 'var(--steel-silver)' }}>You:</span>
          <span style={{ color: 'var(--bright-silver)' }}>{captions.user.slice(0, 120)}</span>
        </div>
      )}
      {captions.agent && (
        <div className="text-[10px] p-1.5 rounded-md" style={{ backgroundColor: 'rgba(14, 14, 20, 0.9)', border: '1px solid rgba(0, 191, 255, 0.2)' }}>
          <span className="text-[8px] uppercase mr-1" style={{ color: 'var(--steel-silver)' }}>AI:</span>
          <span style={{ color: 'var(--bright-silver)' }}>{captions.agent.slice(0, 120)}</span>
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

  const size = expanded ? 300 : 120;
  const height = expanded ? 400 : 120;
  const borderRadius = expanded ? 12 : 60;

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
              className="relative w-full h-full overflow-hidden flex flex-col"
              style={{
                borderRadius,
                backgroundColor: 'rgba(7, 7, 11, 0.9)',
                border: `1px solid ${accentColor}30`,
                boxShadow: `0 8px 32px rgba(0,0,0,0.6), 0 0 20px ${accentColor}15`,
                backdropFilter: 'blur(12px)',
              }}
            >
              {/* Waveform canvas — fills the bubble in idle/voice-call mode */}
              <div className="flex-1 relative" style={{ minHeight: 0 }}>
                <Canvas
                  camera={{ position: [0, 0, 2], fov: 50 }}
                  gl={{ alpha: true, antialias: true }}
                  style={{ width: '100%', height: '100%' }}
                >
                  <ambientLight intensity={0.5} />
                  <pointLight position={[0, 0, 3]} intensity={1} color={accentColor} />
                  <WaveformRing analyser={analyser} accentColor={accentColor} />
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
              <BubbleCaption captions={captions} />
            </div>
          </motion.div>
        </>
      )}
    </>
  );
}
