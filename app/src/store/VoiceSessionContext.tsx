// app/src/store/VoiceSessionContext.tsx
// Face Avatar + Live Voice Pipeline — global voice session.
//
// UPGRADED from the Brain phase: the stub sine-wave amplitude is replaced
// with a real Web Audio API AnalyserNode that reads amplitude from
// whichever audio source is active (TTS playback or mic input).
//
// The external shape is UNCHANGED: isActive, isMuted, startedAt, amplitude.
// The Brain's reactive rendering works unmodified — it just gets real
// amplitude data instead of the stub sine wave.
//
// New fields added for the Face phase:
//   sessionId: string | null — the server-side voice session ID
//   captions: { user: string, agent: string } — live transcript text
//   visemeHint: string — current phoneme category for lip-sync
//   setAudioSource / clearAudioSource — for connecting AnalyserNode

/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';

interface Caption {
  user: string;
  agent: string;
}

interface VoiceSessionState {
  isActive: boolean;
  isMuted: boolean;
  startedAt: number | null;
  amplitude: number;  // 0..1, updated ~60fps from AnalyserNode
  sessionId: string | null;
  captions: Caption;
  visemeHint: string;  // 'open' | 'front' | 'rounded' | 'bilabial' | 'rest'
}

interface VoiceSessionContextValue extends VoiceSessionState {
  startSession: (sessionId: string) => void;
  endSession: () => void;
  toggleMute: () => void;
  setCaption: (role: 'user' | 'agent', text: string) => void;
  setVisemeHint: (hint: string) => void;
  setAudioSource: (source: AudioNode) => void;
  clearAudioSource: () => void;
  ensureAudioContext: () => AudioContext;
  currentAudioSource: AudioNode | null;
  audioContext: AudioContext | null;
}

const VoiceSessionContext = createContext<VoiceSessionContextValue | null>(null);

export function VoiceSessionProvider({ children }: { children: React.ReactNode }) {
  const [isActive, setIsActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [amplitude, setAmplitude] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [captions, setCaptions] = useState<Caption>({ user: '', agent: '' });
  const [visemeHint, setVisemeHint] = useState('rest');
  const [currentAudioSource, setCurrentAudioSource] = useState<AudioNode | null>(null);
  const [audioContextState, setAudioContextState] = useState<AudioContext | null>(null);

  // Web Audio API — AnalyserNode for real amplitude extraction
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const currentSourceRef = useRef<AudioNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // Amplitude loop — reads from AnalyserNode when active.
  // When no audio source is connected, falls back to 0 (idle).
  // This REPLACES the Brain phase's stub sine wave — same external interface.
  useEffect(() => {
    if (!isActive) {
      Promise.resolve().then(() => setAmplitude(0));
      return;
    }

    const updateAmplitude = () => {
      let value = 0;

      if (analyserRef.current && currentSourceRef.current) {
        // Real amplitude from AnalyserNode
        const buf = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(buf);
        // Average the low-frequency bins (voice energy)
        let sum = 0;
        for (let i = 0; i < 16; i++) {
          sum += buf[i];
        }
        value = (sum / 16) / 255;  // normalize to 0..1
        // Boost slightly for visual effect
        value = Math.min(1, value * 1.5);
      }

      setAmplitude(isMuted ? 0 : value);
      rafRef.current = requestAnimationFrame(updateAmplitude);
    };

    rafRef.current = requestAnimationFrame(updateAmplitude);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isActive, isMuted]);

  // Initialize AudioContext lazily (browsers require user gesture)
  const ensureAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 128;
      analyserRef.current.smoothingTimeConstant = 0.8;
    }
    return audioContextRef.current;
  }, []);

  const startSession = useCallback((sid: string) => {
    ensureAudioContext();
    setIsActive(true);
    setStartedAt(Date.now());
    setSessionId(sid);
  }, [ensureAudioContext]);

  const endSession = useCallback(() => {
    setIsActive(false);
    setStartedAt(null);
    setSessionId(null);
    setAmplitude(0);
    setCaptions({ user: '', agent: '' });
    setVisemeHint('rest');

    // Disconnect audio source
    if (currentSourceRef.current) {
      try { currentSourceRef.current.disconnect(); } catch { /* */ }
      currentSourceRef.current = null;
    }
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted(prev => !prev);
  }, []);

  const setCaption = useCallback((role: 'user' | 'agent', text: string) => {
    setCaptions(prev => ({ ...prev, [role]: text }));
  }, []);

  const setAudioSource = useCallback((source: AudioNode) => {
    const ctx = ensureAudioContext();
    const analyser = analyserRef.current!;

    // Disconnect previous source
    if (currentSourceRef.current) {
      try { currentSourceRef.current.disconnect(); } catch { /* */ }
    }

    // Connect: source → analyser → destination
    source.connect(analyser);
    analyser.connect(ctx.destination);
    currentSourceRef.current = source;
    setCurrentAudioSource(source);
    setAudioContextState(ctx);
  }, [ensureAudioContext]);

  const clearAudioSource = useCallback(() => {
    if (currentSourceRef.current) {
      try { currentSourceRef.current.disconnect(); } catch { /* */ }
      currentSourceRef.current = null;
    }
    setCurrentAudioSource(null);
  }, []);

  const value = useMemo(() => ({
    isActive, isMuted, startedAt, amplitude, sessionId, captions, visemeHint,
    startSession, endSession, toggleMute, setCaption, setVisemeHint,
    setAudioSource, clearAudioSource, ensureAudioContext,
    currentAudioSource,
    audioContext: audioContextState,
  }), [isActive, isMuted, startedAt, amplitude, sessionId, captions, visemeHint,
    startSession, endSession, toggleMute, setCaption, setVisemeHint,
    setAudioSource, clearAudioSource, ensureAudioContext, currentAudioSource, audioContextState]);

  return (
    <VoiceSessionContext.Provider value={value}>
      {children}
    </VoiceSessionContext.Provider>
  );
}

export function useVoiceSession() {
  const ctx = useContext(VoiceSessionContext);
  if (!ctx) throw new Error('useVoiceSession must be used within VoiceSessionProvider');
  return ctx;
}
