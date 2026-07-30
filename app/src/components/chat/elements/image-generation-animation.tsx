// app/src/components/chat/elements/image-generation-animation.tsx
// Section 3 — Image generation animation.
// Two phases: shimmer label (generating state) + progressive reveal (blurred mask wipes top-to-bottom).
// Based on ai-chat-image-generation-1.tsx snippet.
// KEEP: shimmer label + progressive reveal mask logic.
// DISCARD: default neutral gradient — must use theme accent token.

import { useState, useEffect } from 'react';

interface ImageGenerationAnimationProps {
  state: 'generating' | 'revealing' | 'done';
  imageUrl?: string;
  altText?: string;
  className?: string;
}

export function ImageGenerationAnimation({
  state,
  imageUrl,
  altText = 'Generated image',
  className,
}: ImageGenerationAnimationProps) {
  const [revealProgress, setRevealProgress] = useState(0);

  useEffect(() => {
    if (state === 'revealing') {
      const interval = setInterval(() => {
        setRevealProgress(prev => {
          if (prev >= 100) {
            clearInterval(interval);
            return 100;
          }
          return prev + 4;
        });
      }, 30);
      return () => clearInterval(interval);
    }
  }, [state]);

  // Phase 1: Generating — shimmer label
  if (state === 'generating') {
    return (
      <div
        className={`flex items-center justify-center rounded-lg ${className}`}
        style={{
          width: '100%',
          minHeight: 200,
          backgroundColor: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <div
          className="text-sm font-medium"
          style={{
            background: `linear-gradient(110deg, var(--muted-silver) 30%, var(--siren-red) 50%, var(--muted-silver) 70%)`,
            backgroundSize: '200% 100%',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            animation: 'shimmer-loop 2s linear infinite',
          }}
        >
          Generating image…
        </div>
      </div>
    );
  }

  // Phase 2: Revealing — progressive blurred mask wipe (top-to-bottom)
  if (state === 'revealing' || state === 'done') {
    return (
      <div
        className={`relative overflow-hidden rounded-lg ${className}`}
        style={{
          border: '1px solid var(--border-subtle)',
          backgroundColor: 'var(--surface-raised)',
        }}
      >
        {imageUrl && (
          <img
            src={imageUrl}
            alt={altText}
            className="w-full h-auto block"
            draggable={false}
          />
        )}
        {/* Blurred mask that wipes away top-to-bottom */}
        {state === 'revealing' && revealProgress < 100 && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backdropFilter: 'blur(12px)',
              backgroundColor: 'rgba(7, 7, 11, 0.6)',
              clipPath: `inset(${revealProgress}% 0 0 0)`,
              transition: 'clip-path 0.03s linear',
            }}
          >
            <div
              className="absolute left-0 right-0 h-[2px]"
              style={{
                top: `${revealProgress}%`,
                background: 'linear-gradient(90deg, transparent, var(--siren-red), transparent)',
                boxShadow: '0 0 8px var(--siren-red)',
              }}
            />
          </div>
        )}
      </div>
    );
  }

  return null;
}
