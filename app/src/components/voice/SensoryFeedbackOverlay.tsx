// app/src/components/voice/SensoryFeedbackOverlay.tsx
// Phase B: Hands-Free — Sensory feedback overlay.
//
// Four components, all rendered conditionally during voice sessions:
//   1. ScreenEdgeGlow — soft pulsing border using accent color, driven by amplitude
//   2. CursorShimmer — subtle glow trailing the cursor in accent color
//   3. WaveformVisualizer — real waveform from AnalyserNode frequency data
//   4. ConfirmationChime — short audio cue on entering hands-free-ready state
//
// Accessibility: respects prefers-reduced-motion. When set:
//   - ScreenEdgeGlow: static border instead of pulsing
//   - CursorShimmer: disabled entirely
//   - WaveformVisualizer: stays (not motion-flashing)
//   - ConfirmationChime: stays (audio, not visual motion)

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useApp } from '@/store/AppContext';
import { themes } from '@/store/themes';

// ── Hook: prefers-reduced-motion ────────────────────────────────────────
// Uses useSyncExternalStore (React 18+) for proper media-query subscription.
function subscribePrefersReducedMotion(callback: () => void): () => void {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', callback);
  return () => mq.removeEventListener('change', callback);
}

function getPrefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getPrefersReducedMotionServer(): boolean {
  return false;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribePrefersReducedMotion,
    getPrefersReducedMotion,
    getPrefersReducedMotionServer,
  );
}

// ── 1. ScreenEdgeGlow ───────────────────────────────────────────────────
export function ScreenEdgeGlow() {
  const { amplitude, isActive } = useVoiceSession();
  const { state } = useApp();
  const reduced = usePrefersReducedMotion();
  const accentColor = themes[state.currentTheme]?.colors.accent ?? '#EE1C1C';

  if (!isActive) return null;

  if (reduced) {
    return (
      <div
        className="fixed inset-0 pointer-events-none z-[45]"
        style={{ boxShadow: `inset 0 0 0 2px ${accentColor}40` }}
      />
    );
  }

  const glowSize = 20 + amplitude * 60;
  const glowOpacity = 0.15 + amplitude * 0.35;

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[45]"
      style={{
        boxShadow: `inset 0 0 ${glowSize}px ${glowSize / 3}px ${accentColor}${Math.round(glowOpacity * 255).toString(16).padStart(2, '0')}`,
        transition: 'box-shadow 0.1s ease-out',
      }}
    />
  );
}

// ── 2. CursorShimmer ────────────────────────────────────────────────────
export function CursorShimmer() {
  const { isActive } = useVoiceSession();
  const { state } = useApp();
  const reduced = usePrefersReducedMotion();
  const dotRef = useRef<HTMLDivElement>(null);
  const accentColor = themes[state.currentTheme]?.colors.accent ?? '#EE1C1C';

  useEffect(() => {
    if (!isActive || reduced) return;
    let raf = 0;
    let mouseX = 0;
    let mouseY = 0;
    let dotX = 0;
    let dotY = 0;

    const onMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    };

    const animate = () => {
      dotX += (mouseX - dotX) * 0.15;
      dotY += (mouseY - dotY) * 0.15;
      if (dotRef.current) {
        dotRef.current.style.transform = `translate(${dotX - 8}px, ${dotY - 8}px)`;
      }
      raf = requestAnimationFrame(animate);
    };

    window.addEventListener('mousemove', onMove);
    raf = requestAnimationFrame(animate);
    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [isActive, reduced, accentColor]);

  if (!isActive || reduced) return null;

  return (
    <div
      ref={dotRef}
      className="fixed top-0 left-0 w-4 h-4 rounded-full pointer-events-none z-[46]"
      style={{
        background: `${accentColor}30`,
        boxShadow: `0 0 12px 4px ${accentColor}50`,
      }}
    />
  );
}

// ── 3. WaveformVisualizer ───────────────────────────────────────────────
export function WaveformVisualizer() {
  const { analyser, isActive } = useVoiceSession();
  const { state } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accentColor = themes[state.currentTheme]?.colors.accent ?? '#EE1C1C';

  useEffect(() => {
    if (!isActive || !analyser || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const barCount = Math.min(bufferLength, 32);
      const barWidth = width / barCount;

      for (let i = 0; i < barCount; i++) {
        const value = dataArray[i];
        const barHeight = (value / 255) * height;
        const x = i * barWidth;
        const y = height - barHeight;
        const opacity = 0.3 + (value / 255) * 0.7;
        ctx.fillStyle = `${accentColor}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
        ctx.fillRect(x + 1, y, barWidth - 2, barHeight);
      }
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, [isActive, analyser, accentColor]);

  if (!isActive) return null;

  return (
    <canvas
      ref={canvasRef}
      width={120}
      height={40}
      className="fixed bottom-4 right-4 z-[44] rounded-lg pointer-events-none"
      style={{
        backgroundColor: 'rgba(7, 7, 11, 0.7)',
        border: `1px solid ${accentColor}30`,
        backdropFilter: 'blur(4px)',
      }}
    />
  );
}

// ── 4. ConfirmationChime ────────────────────────────────────────────────
export function ConfirmationChime() {
  const { isActive, audioContext } = useVoiceSession();
  const hasPlayedRef = useRef(false);

  useEffect(() => {
    if (!isActive) {
      hasPlayedRef.current = false;
    }
  }, [isActive]);

  useEffect(() => {
    if (!isActive || !audioContext || hasPlayedRef.current) return;
    hasPlayedRef.current = true;

    try {
      const ctx = audioContext;
      const now = ctx.currentTime;

      // Tone 1: A5
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.value = 880;
      gain1.gain.setValueAtTime(0, now);
      gain1.gain.linearRampToValueAtTime(0.15, now + 0.02);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.3);

      // Tone 2: E5, slightly delayed
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.value = 660;
      gain2.gain.setValueAtTime(0, now + 0.1);
      gain2.gain.linearRampToValueAtTime(0.12, now + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.1);
      osc2.stop(now + 0.5);

      console.log('[chime] confirmation chime played');
    } catch (err) {
      console.warn('[chime] failed to play:', err);
    }
  }, [isActive, audioContext]);

  return null;
}

// ── Combined overlay ────────────────────────────────────────────────────
export function SensoryFeedbackOverlay() {
  return (
    <>
      <ScreenEdgeGlow />
      <CursorShimmer />
      <WaveformVisualizer />
      <ConfirmationChime />
    </>
  );
}
