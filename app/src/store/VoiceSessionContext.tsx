// app/src/store/VoiceSessionContext.tsx
// Face Avatar + Live Voice Pipeline — global voice session.
//
// Phase B: Hands-Free — refactored. The getUserMedia + MediaRecorder +
// silence-detection logic that previously lived inside FaceView.handleStart()
// has been lifted into this context so it can be triggered from anywhere
// (the FaceView button OR the global F6 hotkey). FaceView now calls the same
// shared startVoiceSession/endVoiceSession functions — no duplication.
//
// The context also registers a global F6 keydown listener that toggles the
// voice session on/off app-wide, and a 5-minute client-side auto-end safety
// net (on top of the existing 90s server-side silence timeout).
//
// External shape (consumed by FaceView, Home PIP overlay, Brain):
//   isActive, isMuted, startedAt, amplitude, sessionId, captions, visemeHint
//   startVoiceSession() — full start: POST /voice/live/start + getUserMedia + recorder
//   endVoiceSession()   — full end: stop recorder + close AudioContext + POST /voice/live/:id/end
//   toggleVoiceSession() — start if inactive, end if active (used by F6 hotkey)
//   toggleMute(), setCaption(), setVisemeHint(), setAudioSource(), clearAudioSource()
//   error: string | null — last start/end error (for FaceView to display)

/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { wsClient } from '@/lib/ws';
import { getToken } from '@/lib/auth';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

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
  error: string | null;  // last start/end error
}

interface VoiceSessionContextValue extends VoiceSessionState {
  // Full lifecycle (new — Phase B): POST + getUserMedia + recorder + silence
  startVoiceSession: () => Promise<void>;
  endVoiceSession: () => Promise<void>;
  toggleVoiceSession: () => Promise<void>;
  // Low-level session state (existing — used by FaceView's WS handlers)
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
  analyser: AnalyserNode | null;  // exposed for waveform visualization
}

const VoiceSessionContext = createContext<VoiceSessionContextValue | null>(null);

// Phase B: 5-minute client-side auto-end safety net.
// If the session is active but no audio activity (amplitude > threshold) is
// detected for 5 minutes, auto-end. This prevents the "toggled on and walked
// away" problem on top of the server's 90s silence timeout (which only fires
// during active turns, not when the user never speaks at all).
const AUTO_END_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes
const AUTO_END_AMPLITUDE_THRESHOLD = 5;  // below this = silence

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
  const [error, setError] = useState<string | null>(null);

  // Web Audio API — AnalyserNode for real amplitude extraction
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const currentSourceRef = useRef<AudioNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // Phase B: Mic capture + recorder + silence detection refs.
  // Previously lived in FaceView as local refs; now in the context so the
  // F6 hotkey can start/stop the mic from anywhere.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceAnalyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);  // kept for recorder restart
  const isActiveRef = useRef(false);  // ref mirror of isActive for closures
  const autoEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep isActiveRef in sync so silence-detection closures see current value
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Amplitude loop — reads from AnalyserNode when active.
  useEffect(() => {
    if (!isActive) {
      Promise.resolve().then(() => setAmplitude(0));
      return;
    }

    const updateAmplitude = () => {
      let value = 0;

      if (analyserRef.current && currentSourceRef.current) {
        const buf = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < 16; i++) {
          sum += buf[i];
        }
        value = (sum / 16) / 255;
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

  // Low-level session state setters (existing — used by WS handlers in FaceView)
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

    if (currentSourceRef.current) {
      try { currentSourceRef.current.disconnect(); } catch { /* */ }
    }

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

  // ── Phase B: Full lifecycle (getUserMedia + recorder + silence) ────────
  // This logic was lifted from FaceView.handleStart/handleEnd so the F6
  // hotkey can trigger it from anywhere. FaceView's button now calls these
  // same functions — no duplication.

  // Reset the 5-min auto-end timer. Called whenever audio activity is detected.
  const resetAutoEndTimer = useCallback(() => {
    if (autoEndTimerRef.current) {
      clearTimeout(autoEndTimerRef.current);
    }
    autoEndTimerRef.current = setTimeout(() => {
      console.log('[voice-session] 5-min inactivity timeout — auto-ending session');
      // Fire-and-forget — endVoiceSession is async but we don't need to await
      void endVoiceSessionInternal();
    }, AUTO_END_TIMEOUT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Internal end (used by auto-end timer to avoid circular dep on endVoiceSession)
  const endVoiceSessionInternal = useCallback(async () => {
    // Stop recording
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      } catch { /* */ }
      mediaRecorderRef.current = null;
    }

    // Stop all media tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }

    // Close the shared AudioContext (used for both silence detection + amplitude).
    // Note: ensureAudioContext() will create a fresh one on next start.
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch { /* */ }
      audioContextRef.current = null;
      analyserRef.current = null;  // amplitude analyser lives in this context
    }

    // Clear silence analyser
    silenceAnalyserRef.current = null;

    // Clear silence timer
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    // Clear auto-end timer
    if (autoEndTimerRef.current) {
      clearTimeout(autoEndTimerRef.current);
      autoEndTimerRef.current = null;
    }

    clearAudioSource();

    // Tell server to end the session
    const currentSid = sessionId;
    if (currentSid) {
      try {
        const token = getToken();
        await fetch(`${API_BASE}/voice/live/${currentSid}/end`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch { /* server may have already cleaned up */ }
    }

    endSession();
  }, [sessionId, endSession, clearAudioSource]);

  // Full start: POST /voice/live/start + getUserMedia + recorder + silence detection
  const startVoiceSession = useCallback(async () => {
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
      mediaStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        if (audioChunksRef.current.length === 0) return;
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        audioChunksRef.current = [];

        const arrayBuffer = await blob.arrayBuffer();
        // The authenticated WS server accepts raw binary audio, then processes
        // the accumulated turn only after this explicit existing control event.
        wsClient.send('voice:audio', arrayBuffer);
        wsClient.send('voice:turn-end', { sessionId: body.sessionId });
      };

      recorder.start(1000);
      mediaRecorderRef.current = recorder;

      // Set up silence detection using the SAME AudioContext as amplitude.
      // The original FaceView code created a separate AudioContext for silence
      // detection, which caused "cannot connect to an AudioNode belonging to a
      // different audio context" errors when setAudioSource() tried to connect
      // the mic source (from the silence context) to the amplitude analyser
      // (from ensureAudioContext()). Using one shared context fixes this.
      const ctx = ensureAudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const silenceAnalyser = ctx.createAnalyser();
      silenceAnalyser.fftSize = 256;
      source.connect(silenceAnalyser);
      silenceAnalyserRef.current = silenceAnalyser;

      // Connect mic to VoiceSessionContext for amplitude (same context now)
      setAudioSource(source);

      // Start the 5-min auto-end timer
      resetAutoEndTimer();

      // Silence detection loop
      const checkSilence = () => {
        if (!silenceAnalyserRef.current || !isActiveRef.current) return;
        const data = new Uint8Array(silenceAnalyserRef.current.frequencyBinCount);
        silenceAnalyserRef.current.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;

        // Reset auto-end timer on any audio activity
        if (avg > AUTO_END_AMPLITUDE_THRESHOLD) {
          resetAutoEndTimer();
        }

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
                if (isActiveRef.current && mediaRecorderRef.current === null && mediaStreamRef.current) {
                  const newRecorder = new MediaRecorder(mediaStreamRef.current);
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
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      console.error('[voice-session] start failed:', msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSession, setAudioSource, resetAutoEndTimer]);

  // Full end: stop recorder + close AudioContext + POST /voice/live/:id/end
  const endVoiceSession = useCallback(async () => {
    await endVoiceSessionInternal();
  }, [endVoiceSessionInternal]);

  // Toggle: start if inactive, end if active (used by F6 hotkey + FaceView button)
  const toggleVoiceSession = useCallback(async () => {
    if (isActiveRef.current) {
      await endVoiceSession();
    } else {
      await startVoiceSession();
    }
  }, [startVoiceSession, endVoiceSession]);

  // ── Phase B: Global F6 hotkey ──────────────────────────────────────────
  // F6 is completely unclaimed — no Monaco default binding, no browser
  // default action, no existing app shortcut. Registered on window so it
  // fires app-wide (editor focused, chat focused, dashboard, anywhere).
  // keydown counts as a user gesture for getUserMedia.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F6') {
        e.preventDefault();
        // Fire-and-forget — toggleVoiceSession is async
        void toggleVoiceSession();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleVoiceSession]);

  const value = useMemo(() => ({
    isActive, isMuted, startedAt, amplitude, sessionId, captions, visemeHint, error,
    startVoiceSession, endVoiceSession, toggleVoiceSession,
    startSession, endSession, toggleMute, setCaption, setVisemeHint,
    setAudioSource, clearAudioSource, ensureAudioContext,
    currentAudioSource,
    audioContext: audioContextState,
    analyser: analyserRef.current,
  }), [isActive, isMuted, startedAt, amplitude, sessionId, captions, visemeHint, error,
    startVoiceSession, endVoiceSession, toggleVoiceSession,
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
