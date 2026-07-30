// app/src/components/chat/elements/text-animations.tsx
// Section 7.1 — Text animation: typewriter reveal, word-fade scroll-reveal, shimmer text.
// All re-themed to Code Siren tokens. Based on typewriter-text.tsx, magic-text.tsx, shining-text.tsx.

import { useEffect, useState, useRef } from 'react';
import { motion, useInView } from 'motion/react';

// ── 1. TypewriterText — character-by-character reveal for streaming responses ──

interface TypewriterTextProps {
  text: string;
  speed?: number;  // ms per character
  className?: string;
  onComplete?: () => void;
  showCursor?: boolean;
}

export function TypewriterText({ text, speed = 20, className, onComplete, showCursor = false }: TypewriterTextProps) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed('');
    setDone(false);
    let i = 0;
    const interval = setInterval(() => {
      if (i < text.length) {
        setDisplayed(text.slice(0, i + 1));
        i++;
      } else {
        clearInterval(interval);
        setDone(true);
        onComplete?.();
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, speed, onComplete]);

  return (
    <span className={className} style={{ color: 'var(--bright-silver)' }}>
      {displayed}
      {showCursor && !done && (
        <span
          className="inline-block w-[2px] h-[1em] align-text-bottom ml-0.5 animate-pulse"
          style={{ backgroundColor: 'var(--siren-red)' }}
        />
      )}
    </span>
  );
}

// ── 2. ScrollRevealText — word-fade animation for long pasted/scrolled text ──

interface ScrollRevealTextProps {
  text: string;
  className?: string;
}

export function ScrollRevealText({ text, className }: ScrollRevealTextProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const inView = useInView(ref, { once: true, margin: '-50px' });
  const words = text.split(' ');

  return (
    <p ref={ref} className={className} style={{ color: 'var(--bright-silver)' }}>
      {words.map((word, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, y: 8 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: i * 0.03, duration: 0.3, ease: 'easeOut' }}
          className="inline-block mr-[0.3em]"
        >
          {word}
        </motion.span>
      ))}
    </p>
  );
}

// ── 3. ShimmerText — shimmer/shine treatment for links and "thinking" label ──

interface ShimmerTextProps {
  text: string;
  className?: string;
  loop?: boolean;  // continuous shimmer (for "thinking" label)
  as?: 'span' | 'div';
}

export function ShimmerText({ text, className, loop = false, as = 'span' }: ShimmerTextProps) {
  const Tag = as;
  return (
    <Tag
      className={className}
      style={{
        background: `linear-gradient(110deg, var(--muted-silver) 35%, var(--bright-silver) 50%, var(--muted-silver) 65%)`,
        backgroundSize: '200% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        animation: loop ? 'shimmer-loop 2s linear infinite' : 'shimmer-once 1.5s ease forwards',
      }}
    >
      {text}
    </Tag>
  );
}

// ── 4. ShiningLink — shining treatment specifically for links inside AI text ──

interface ShiningLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

export function ShiningLink({ href, children, className }: ShiningLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-block ${className ?? ''}`}
      style={{
        background: `linear-gradient(110deg, var(--siren-red) 30%, var(--bright-silver) 50%, var(--siren-red) 70%)`,
        backgroundSize: '200% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        textDecoration: 'underline',
        textDecorationColor: 'var(--dim-red)',
        animation: 'shimmer-loop 3s linear infinite',
      }}
    >
      {children}
    </a>
  );
}
