// app/src/components/ui/card-stack.tsx
// Section 10.3 — Discover news feed: 3D fanned carousel, drag-to-advance, auto-advance.
// Based on card-stack.tsx snippet from 21.dev.
// KEEP: 3D fanned carousel, drag-to-advance, auto-advance, dots navigation.
// DISCARD: demo car-brand placeholder data, Next.js Link import, bundled colors.
// Re-themed to Code Siren tokens.

import * as React from 'react';
import { motion, AnimatePresence, useReducedMotion, type PanInfo } from 'motion/react';

export type CardStackItem = {
  id: string | number;
  title: string;
  description?: string;
  imageSrc?: string;
  href?: string;
  tag?: string;
};

export type CardStackProps<T extends CardStackItem> = {
  items: T[];
  initialIndex?: number;
  maxVisible?: number;
  cardWidth?: number;
  cardHeight?: number;
  overlap?: number;
  spreadDeg?: number;
  perspectivePx?: number;
  depthPx?: number;
  tiltXDeg?: number;
  activeLiftPx?: number;
  activeScale?: number;
  inactiveScale?: number;
  springStiffness?: number;
  springDamping?: number;
  loop?: boolean;
  autoAdvance?: boolean;
  intervalMs?: number;
  pauseOnHover?: boolean;
  showDots?: boolean;
  className?: string;
  onChangeIndex?: (index: number, item: T) => void;
  renderCard?: (item: T, state: { active: boolean }) => React.ReactNode;
};

function wrapIndex(n: number, len: number) {
  if (len <= 0) return 0;
  return ((n % len) + len) % len;
}

function signedOffset(i: number, active: number, len: number, loop: boolean) {
  const raw = i - active;
  if (!loop || len <= 1) return raw;
  const alt = raw > 0 ? raw - len : raw + len;
  return Math.abs(alt) < Math.abs(raw) ? alt : raw;
}

export function CardStack<T extends CardStackItem>({
  items,
  initialIndex = 0,
  maxVisible = 7,
  cardWidth = 440,
  cardHeight = 280,
  overlap = 0.48,
  spreadDeg = 42,
  perspectivePx = 1100,
  depthPx = 120,
  tiltXDeg = 10,
  activeLiftPx = 18,
  activeScale = 1.03,
  inactiveScale = 0.94,
  springStiffness = 280,
  springDamping = 28,
  loop = true,
  autoAdvance = false,
  intervalMs = 3000,
  pauseOnHover = true,
  showDots = true,
  className,
  onChangeIndex,
  renderCard,
}: CardStackProps<T>) {
  const reduceMotion = useReducedMotion();
  const len = items.length;

  const [active, setActive] = React.useState(() => wrapIndex(initialIndex, len));
  const [hovering, setHovering] = React.useState(false);

  React.useEffect(() => {
    setActive((a) => wrapIndex(a, len));
  }, [len]);

  React.useEffect(() => {
    if (!len) return;
    onChangeIndex?.(active, items[active]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const maxOffset = Math.max(0, Math.floor(maxVisible / 2));
  const cardSpacing = Math.max(10, Math.round(cardWidth * (1 - overlap)));
  const stepDeg = maxOffset > 0 ? spreadDeg / maxOffset : 0;

  const canGoPrev = loop || active > 0;
  const canGoNext = loop || active < len - 1;

  const prev = React.useCallback(() => {
    if (!len || !canGoPrev) return;
    setActive((a) => wrapIndex(a - 1, len));
  }, [canGoPrev, len]);

  const next = React.useCallback(() => {
    if (!len || !canGoNext) return;
    setActive((a) => wrapIndex(a + 1, len));
  }, [canGoNext, len]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') prev();
    if (e.key === 'ArrowRight') next();
  };

  React.useEffect(() => {
    if (!autoAdvance || reduceMotion || !len || (pauseOnHover && hovering)) return;
    const id = window.setInterval(
      () => { if (loop || active < len - 1) next(); },
      Math.max(700, intervalMs),
    );
    return () => window.clearInterval(id);
  }, [autoAdvance, intervalMs, hovering, pauseOnHover, reduceMotion, len, loop, active, next]);

  if (!len) return null;

  return (
    <div
      className={`w-full ${className ?? ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div
        className="relative w-full"
        style={{ height: Math.max(340, cardHeight + 60) }}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {/* Background spotlight */}
        <div
          className="pointer-events-none absolute inset-x-0 top-6 mx-auto h-48 w-[70%] rounded-full blur-3xl"
          style={{ backgroundColor: 'var(--siren-red)', opacity: 0.04 }}
          aria-hidden="true"
        />

        <div
          className="absolute inset-0 flex items-end justify-center"
          style={{ perspective: `${perspectivePx}px` }}
        >
          <AnimatePresence initial={false}>
            {items.map((item, i) => {
              const off = signedOffset(i, active, len, loop);
              const abs = Math.abs(off);
              const visible = abs <= maxOffset;
              if (!visible) return null;

              const rotateZ = off * stepDeg;
              const x = off * cardSpacing;
              const y = abs * 8;
              const z = -abs * depthPx;
              const isActive = off === 0;
              const scale = isActive ? activeScale : inactiveScale;
              const lift = isActive ? -activeLiftPx : 0;
              const rotateX = isActive ? 0 : tiltXDeg;
              const zIndex = 100 - abs;

              const dragProps = isActive
                ? {
                    drag: 'x' as const,
                    dragConstraints: { left: 0, right: 0 },
                    dragElastic: 0.18,
                    onDragEnd: (_e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
                      if (reduceMotion) return;
                      const travel = info.offset.x;
                      const v = info.velocity.x;
                      const threshold = Math.min(160, cardWidth * 0.22);
                      if (travel > threshold || v > 650) prev();
                      else if (travel < -threshold || v < -650) next();
                    },
                  }
                : {};

              return (
                <motion.div
                  key={item.id}
                  className={`absolute bottom-0 rounded-xl overflow-hidden shadow-xl will-change-transform select-none ${isActive ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
                  style={{
                    width: cardWidth,
                    height: cardHeight,
                    zIndex,
                    border: '1px solid var(--border-subtle)',
                    transformStyle: 'preserve-3d',
                  }}
                  initial={reduceMotion ? false : { opacity: 0, y: y + 40, x, rotateZ, rotateX, scale }}
                  animate={{ opacity: 1, x, y: y + lift, rotateZ, rotateX, scale }}
                  transition={{ type: 'spring', stiffness: springStiffness, damping: springDamping }}
                  onClick={() => setActive(i)}
                  {...dragProps}
                >
                  <div className="h-full w-full" style={{ transform: `translateZ(${z}px)`, transformStyle: 'preserve-3d' }}>
                    {renderCard ? renderCard(item, { active: isActive }) : <DefaultCard item={item} active={isActive} />}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {showDots && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <div className="flex items-center gap-2">
            {items.map((it, idx) => {
              const on = idx === active;
              return (
                <button
                  key={it.id}
                  onClick={() => setActive(idx)}
                  className="h-2 w-2 rounded-full transition-all"
                  style={{
                    backgroundColor: on ? 'var(--siren-red)' : 'var(--muted-silver)',
                    opacity: on ? 1 : 0.4,
                  }}
                  aria-label={`Go to ${it.title}`}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function DefaultCard({ item }: { item: CardStackItem; active: boolean }) {
  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">
        {item.imageSrc ? (
          <img src={item.imageSrc} alt={item.title} className="h-full w-full object-cover" draggable={false} loading="eager" />
        ) : (
          <div className="flex h-full w-full items-center justify-center" style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--muted-silver)' }}>
            <span className="text-sm">No image</span>
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent 50%)' }} />
      <div className="relative z-10 flex h-full flex-col justify-end p-4">
        {item.tag && (
          <span className="text-[10px] uppercase tracking-wider mb-1 px-1.5 py-0.5 rounded inline-block w-fit" style={{ backgroundColor: 'var(--siren-red)', color: 'white' }}>
            {item.tag}
          </span>
        )}
        <div className="truncate text-base font-semibold text-white">{item.title}</div>
        {item.description && <div className="mt-0.5 line-clamp-2 text-xs text-white/80">{item.description}</div>}
      </div>
    </div>
  );
}
