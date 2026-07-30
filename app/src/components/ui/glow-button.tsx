// app/src/components/ui/glow-button.tsx
// Section 4 — Buttons: dark surface, subtle text micro-animation, soft glow on hover.
// The conic-gradient glow technique comes from the animated-glowing-search-bar snippet
// (KEEP: rotating conic-gradient glow layers; DISCARD: entire search input markup).
// All colors use Code Siren's theme tokens — no bundled palette.

import * as React from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface GlowButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  glow?: boolean;  // enable conic-gradient glow on hover
  loading?: boolean;
}

export const GlowButton = React.forwardRef<HTMLButtonElement, GlowButtonProps>(
  ({ className, variant = 'primary', size = 'md', glow = false, loading = false, children, disabled, ...props }, ref) => {
    const base = 'relative inline-flex items-center justify-center gap-1.5 font-medium rounded-md transition-all duration-200 focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none select-none';

    const variants: Record<string, string> = {
      primary: 'text-white',
      secondary: 'text-[var(--bright-silver)]',
      ghost: 'text-[var(--steel-silver)] hover:text-[var(--bright-silver)]',
      destructive: 'text-white',
    };

    const sizes: Record<string, string> = {
      sm: 'h-7 px-2.5 text-xs',
      md: 'h-9 px-4 text-sm',
      lg: 'h-11 px-6 text-base',
      icon: 'w-9 h-9',
    };

    const bgStyles: Record<string, React.CSSProperties> = {
      primary: { backgroundColor: 'var(--siren-red)' },
      secondary: { backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' },
      ghost: { backgroundColor: 'transparent' },
      destructive: { backgroundColor: 'var(--error)' },
    };

    return (
      <motion.button
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        style={{ ...bgStyles[variant], ...(props.style || {}) }}
        whileHover={{ scale: disabled ? 1 : 1.02 }}
        whileTap={{ scale: disabled ? 1 : 0.98 }}
        disabled={disabled || loading}
        {...(props as React.ComponentProps<typeof motion.button>)}
      >
        {/* Conic-gradient glow layers (from animated-glowing-search-bar technique) */}
        {glow && !disabled && (
          <span
            className="pointer-events-none absolute -inset-[1px] rounded-md opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{
              background: `conic-gradient(from var(--glow-angle, 0deg), var(--siren-red), transparent, var(--accent-secondary, var(--siren-red)), transparent, var(--siren-red))`,
              animation: 'glow-rotate 3s linear infinite',
              zIndex: -1,
              filter: 'blur(8px)',
            }}
          />
        )}
        {loading && (
          <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
        )}
        <span className="relative z-10">{children}</span>
      </motion.button>
    );
  }
);
GlowButton.displayName = 'GlowButton';
