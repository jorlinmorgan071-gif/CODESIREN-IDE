// app/src/components/ui/loaders.tsx
// Section 7.2 — Spinners and loaders.
// Based on loader.tsx (12-variant), box-loader.tsx, spinner-morph.tsx, ai-loader.tsx, spinner-1.tsx.
// ALL re-themed to Code Siren tokens — no fixed teal/white/gradient colors from snippets.

import { motion } from 'motion/react';

// ── 1. MultiVariantLoader — rotating set for "AI is thinking" shuffle ──────

export type LoaderVariant = 'circle' | 'dots' | 'wave' | 'bars' | 'terminal' | 'pulse' | 'ring' | 'orbit';

interface MultiVariantLoaderProps {
  variant: LoaderVariant;
  size?: number;
  className?: string;
}

export function MultiVariantLoader({ variant, size = 32, className }: MultiVariantLoaderProps) {
  const color = 'var(--siren-red)';
  const mutedColor = 'var(--muted-silver)';

  switch (variant) {
    case 'circle':
      return (
        <div className={className} style={{ width: size, height: size }}>
          <motion.div
            className="w-full h-full border-2 rounded-full"
            style={{ borderColor: mutedColor, borderTopColor: color }}
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
          />
        </div>
      );

    case 'dots':
      return (
        <div className={`flex items-center gap-1.5 ${className}`}>
          {[0, 1, 2].map(i => (
            <motion.div
              key={i}
              className="rounded-full"
              style={{ width: size / 4, height: size / 4, backgroundColor: color }}
              animate={{ scale: [1, 1.3, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ repeat: Infinity, duration: 0.8, delay: i * 0.15 }}
            />
          ))}
        </div>
      );

    case 'wave':
      return (
        <div className={`flex items-end gap-1 ${className}`} style={{ height: size }}>
          {[0, 1, 2, 3].map(i => (
            <motion.div
              key={i}
              style={{ width: size / 6, backgroundColor: color, borderRadius: 2 }}
              animate={{ height: [size * 0.3, size, size * 0.3] }}
              transition={{ repeat: Infinity, duration: 0.9, delay: i * 0.1, ease: 'easeInOut' }}
            />
          ))}
        </div>
      );

    case 'bars':
      return (
        <div className={`flex items-center gap-1 ${className}`} style={{ height: size }}>
          {[0, 1, 2, 3, 4].map(i => (
            <motion.div
              key={i}
              style={{ width: 3, backgroundColor: color, borderRadius: 2 }}
              animate={{ scaleY: [0.4, 1, 0.4], originY: 0.5 }}
              transition={{ repeat: Infinity, duration: 0.7, delay: i * 0.08 }}
            />
          ))}
        </div>
      );

    case 'terminal':
      return (
        <div
          className={`font-mono text-sm ${className}`}
          style={{ color, fontFamily: 'JetBrains Mono, monospace' }}
        >
          <motion.span
            animate={{ opacity: [1, 0, 1] }}
            transition={{ repeat: Infinity, duration: 1 }}
          >
            {'>'}_
          </motion.span>
        </div>
      );

    case 'pulse':
      return (
        <motion.div
          className={`rounded-full ${className}`}
          style={{ width: size, height: size, backgroundColor: color }}
          animate={{ scale: [1, 1.3, 1], opacity: [0.8, 0.3, 0.8] }}
          transition={{ repeat: Infinity, duration: 1.2, ease: 'easeInOut' }}
        />
      );

    case 'ring':
      return (
        <div className={className} style={{ width: size, height: size }}>
          <motion.div
            className="w-full h-full rounded-full border-2"
            style={{ borderColor: color, borderTopColor: 'transparent', borderRightColor: 'transparent' }}
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
          />
        </div>
      );

    case 'orbit':
      return (
        <div className={`relative ${className}`} style={{ width: size, height: size }}>
          <motion.div
            className="absolute inset-0"
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
          >
            <div
              className="absolute rounded-full"
              style={{ width: size / 4, height: size / 4, backgroundColor: color, top: 0, left: '50%', transform: 'translateX(-50%)' }}
            />
          </motion.div>
        </div>
      );

    default:
      return null;
  }
}

// ── 2. RotatingLoader — picks variants in rotation for "thinking" shuffle ──

interface RotatingLoaderProps {
  size?: number;
  intervalMs?: number;
  className?: string;
}

export function RotatingLoader({ size = 32, intervalMs = 3000, className }: RotatingLoaderProps) {
  const variants: LoaderVariant[] = ['circle', 'dots', 'wave', 'bars', 'ring', 'orbit', 'pulse'];
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIdx(prev => (prev + 1) % variants.length);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs, variants.length]);

  return <MultiVariantLoader variant={variants[idx]} size={size} className={className} />;
}

// import useEffect + useState at top (needed for RotatingLoader)
import { useEffect, useState } from 'react';

// ── 3. BoxLoader — sharp geometric loader for editor tabs/panels ────────────
// Based on box-loader.tsx. Restyled flatter/sharper + reflection beneath.

interface BoxLoaderProps {
  size?: number;
  className?: string;
}

export function BoxLoader({ size = 40, className }: BoxLoaderProps) {
  const color = 'var(--siren-red)';
  const mutedColor = 'var(--border-subtle)';

  return (
    <div className={`flex flex-col items-center gap-1 ${className}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <motion.div
          className="absolute inset-0 rounded-sm"
          style={{ border: `2px solid ${mutedColor}` }}
          animate={{ rotate: 0 }}
        />
        <motion.div
          className="absolute inset-0 rounded-sm"
          style={{ border: `2px solid ${color}`, borderTopColor: 'transparent', borderRightColor: 'transparent' }}
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
        />
        <motion.div
          className="absolute rounded-sm"
          style={{
            width: size * 0.3,
            height: size * 0.3,
            backgroundColor: color,
            top: '50%',
            left: '50%',
          }}
          animate={{
            scale: [1, 0.5, 1],
            borderRadius: ['4px', '50%', '4px'],
          }}
          transition={{ repeat: Infinity, duration: 1.5, ease: 'easeInOut' }}
          // center it
          initial={{ x: '-50%', y: '-50%' }}
        />
      </div>
      {/* Reflection beneath — consistent with Dock's mirror treatment */}
      <motion.div
        className="rounded-sm"
        style={{
          width: size * 0.7,
          height: size * 0.15,
          background: `linear-gradient(to bottom, ${color}30, transparent)`,
          filter: 'blur(2px)',
          transform: 'scaleY(-1)',
          opacity: 0.4,
        }}
        animate={{ opacity: [0.2, 0.4, 0.2] }}
        transition={{ repeat: Infinity, duration: 1.5 }}
      />
    </div>
  );
}

// ── 4. AttachmentSpinner — 12-bar radial spinner for upload-in-progress ────
// Based on spinner-1.tsx (shugar/spinner-1). Used inside attach button / file chip.

interface AttachmentSpinnerProps {
  size?: number;
  className?: string;
}

export function AttachmentSpinner({ size = 20, className }: AttachmentSpinnerProps) {
  const color = 'var(--siren-red)';
  const bars = 12;

  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      {Array.from({ length: bars }).map((_, i) => (
        <motion.div
          key={i}
          className="absolute origin-bottom"
          style={{
            width: 2,
            height: size * 0.35,
            backgroundColor: color,
            borderRadius: 1,
            left: '50%',
            top: '50%',
            transformOrigin: 'center bottom',
            transform: `translateX(-50%) rotate(${(360 / bars) * i}deg) translateY(-${size * 0.15}px)`,
          }}
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{
            repeat: Infinity,
            duration: 0.9,
            delay: (i / bars) * 0.9,
            ease: 'linear',
          }}
        />
      ))}
    </div>
  );
}

// ── 5. AiLoader — rotating ring + letter animation for app boot ────────────
// Based on ai-loader.tsx.

interface AiLoaderProps {
  text?: string;
  size?: number;
  className?: string;
}

export function AiLoader({ text = 'Code Siren', size = 64, className }: AiLoaderProps) {
  const color = 'var(--siren-red)';
  const mutedColor = 'var(--border-subtle)';

  return (
    <div className={`flex flex-col items-center gap-4 ${className}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <motion.div
          className="absolute inset-0 rounded-full border-2"
          style={{ borderColor: mutedColor, borderTopColor: color }}
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
        />
        <div
          className="absolute inset-0 flex items-center justify-center font-bold"
          style={{ color, fontSize: size * 0.25 }}
        >
          AI
        </div>
      </div>
      <motion.div
        className="text-sm font-medium"
        style={{ color: 'var(--steel-silver)' }}
        animate={{ opacity: [0.5, 1, 0.5] }}
        transition={{ repeat: Infinity, duration: 1.5 }}
      >
        {text}
      </motion.div>
    </div>
  );
}

// ── 6. SpinnerMorph — organic morph for premium large-scale loading ────────
// Based on spinner-morph.tsx. Re-themed (no fixed teal/white).

interface SpinnerMorphProps {
  size?: number;
  className?: string;
}

export function SpinnerMorph({ size = 120, className }: SpinnerMorphProps) {
  const color = 'var(--siren-red)';

  return (
    <div className={className} style={{ width: size, height: size }}>
      <motion.svg
        viewBox="0 0 100 100"
        className="w-full h-full"
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 6, ease: 'linear' }}
      >
        <motion.path
          fill={color}
          animate={{
            d: [
              'M50 10 C70 10 90 30 90 50 C90 70 70 90 50 90 C30 90 10 70 10 50 C10 30 30 10 50 10 Z',
              'M50 15 C65 15 85 35 85 50 C85 65 65 85 50 85 C35 85 15 65 15 50 C15 35 35 15 50 15 Z',
              'M50 10 C70 10 90 30 90 50 C90 70 70 90 50 90 C30 90 10 70 10 50 C10 30 30 10 50 10 Z',
            ],
          }}
          transition={{ repeat: Infinity, duration: 6, ease: 'easeInOut' }}
        />
      </motion.svg>
    </div>
  );
}
