// app/src/components/ui/premium-tooltip.tsx
// Section 9 — Tooltips: premium feel with entrance animation (scale + fade in).
// Based on tooltip-1.tsx snippet (KEEP: react-tooltip wrapper pattern; DISCARD: default severity colors).
// Re-themed to Code Siren's CSS variable tokens.

import React, { useId } from 'react';
import { Tooltip as ReactTooltip } from 'react-tooltip';
import clsx from 'clsx';

type Severity = 'default' | 'success' | 'warning' | 'error' | 'info';

const severityClasses: Record<Severity, string> = {
  default: '!bg-[var(--surface-raised)] !text-[var(--bright-silver)] !border !border-[var(--border-subtle)]',
  success: '!bg-[var(--success)] !text-white',
  warning: '!bg-[var(--warning)] !text-black',
  error: '!bg-[var(--error)] !text-white',
  info: '!bg-[var(--info)] !text-white',
};

interface PremiumTooltipProps {
  children: React.ReactNode;
  text: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: boolean;
  severity?: Severity;
  tip?: boolean;
  className?: string;
}

export const PremiumTooltip = ({
  children,
  text,
  position = 'top',
  delay = true,
  severity = 'default',
  tip = true,
  className,
}: PremiumTooltipProps) => {
  const rawId = useId();
  const id = `tt-${rawId.replace(/:/g, '')}`;

  return (
    // Bug E fix — the outer wrapper must NOT block pointer events from
    // reaching the trigger child (e.g. motion.button's onHoverStart).
    // inline-flex + pointer-events-auto on the inner id-wrapper preserves
    // hover/click delivery to the trigger. The ReactTooltip content is a
    // separate floating element rendered elsewhere in the DOM, so it
    // doesn't need pointer-events handling here.
    <div className={clsx('inline-flex', className)} style={{ pointerEvents: 'auto' }}>
      <div id={id} className="inline-flex" style={{ pointerEvents: 'auto' }}>
        {children}
      </div>
      <ReactTooltip
        anchorSelect={`#${id}`}
        place={position}
        delayShow={delay ? 400 : 0}
        opacity={1}
        noArrow={!tip}
        // Entrance animation: scale + fade in (not instant snap)
        float={true}
        className={clsx(
          '!font-sans !text-[12px] !max-w-56 !rounded-md !shadow-lg !z-50',
          '!transition-all !duration-200',
          severityClasses[severity],
        )}
        style={{
          // Override react-tooltip's default transitions with our own
          '--rt-transition-show': 'opacity 200ms ease, transform 200ms ease',
          '--rt-transition-hide': 'opacity 150ms ease, transform 150ms ease',
        } as React.CSSProperties}
      >
        {text}
      </ReactTooltip>
    </div>
  );
};
