// app/src/components/ui/notification-alert.tsx
// Section 8 — Notifications: elevated shadow + glossy highlight + severity variants.
// Based on alert-1.tsx snippet (KEEP: variant system, structure; DISCARD: default solid/light colors).
// Re-themed to Code Siren tokens. Fire ONLY on: long-running response finishing, error, project build completing.

import * as React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

type AlertSeverity = 'info' | 'success' | 'warning' | 'error';
type AlertAppearance = 'solid' | 'glass';

interface NotificationAlertProps {
  severity?: AlertSeverity;
  appearance?: AlertAppearance;
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  dismissible?: boolean;
  onDismiss?: () => void;
  visible?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const severityStyles: Record<AlertSeverity, { bg: string; border: string; text: string; icon: string }> = {
  info: {
    bg: 'rgba(59, 130, 246, 0.15)',
    border: 'rgba(59, 130, 246, 0.4)',
    text: 'var(--bright-silver)',
    icon: 'var(--info)',
  },
  success: {
    bg: 'rgba(34, 197, 94, 0.15)',
    border: 'rgba(34, 197, 94, 0.4)',
    text: 'var(--bright-silver)',
    icon: 'var(--success)',
  },
  warning: {
    bg: 'rgba(245, 158, 11, 0.15)',
    border: 'rgba(245, 158, 11, 0.4)',
    text: 'var(--bright-silver)',
    icon: 'var(--warning)',
  },
  error: {
    bg: 'rgba(238, 28, 28, 0.15)',
    border: 'rgba(238, 28, 28, 0.4)',
    text: 'var(--bright-silver)',
    icon: 'var(--error)',
  },
};

export function NotificationAlert({
  severity = 'info',
  appearance = 'glass',
  title,
  description,
  icon,
  dismissible = false,
  onDismiss,
  visible = true,
  className,
  children,
}: NotificationAlertProps) {
  const styles = severityStyles[severity];

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className={cn(
            'relative flex items-start gap-3 p-3.5 rounded-lg overflow-hidden',
            className,
          )}
          style={{
            backgroundColor: appearance === 'glass' ? styles.bg : 'var(--surface-raised)',
            border: `1px solid ${styles.border}`,
            backdropFilter: appearance === 'glass' ? 'blur(12px)' : 'none',
            // Elevated shadow — reads as hovering above the surface
            boxShadow: '0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2)',
            color: styles.text,
          }}
        >
          {/* Glossy highlight — subtle light-catching sheen across top edge */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-px"
            style={{
              background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent)',
            }}
          />

          {/* Icon */}
          {icon && (
            <div className="shrink-0 mt-0.5" style={{ color: styles.icon }}>
              {icon}
            </div>
          )}

          {/* Content */}
          <div className="flex-1 min-w-0">
            {title && (
              <div className="text-sm font-semibold mb-0.5" style={{ color: styles.text }}>
                {title}
              </div>
            )}
            {description && (
              <div className="text-xs" style={{ color: 'var(--steel-silver)' }}>
                {description}
              </div>
            )}
            {children}
          </div>

          {/* Dismiss button */}
          {dismissible && (
            <button
              onClick={onDismiss}
              className="shrink-0 p-0.5 rounded transition-colors hover:bg-white/10"
              style={{ color: 'var(--muted-silver)' }}
              aria-label="Dismiss notification"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Notification container — manages a queue of notifications ────────────

export interface NotificationItem {
  id: string;
  severity: AlertSeverity;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  duration?: number;  // ms before auto-dismiss; 0 = sticky
}

interface NotificationContainerProps {
  notifications: NotificationItem[];
  onDismiss: (id: string) => void;
}

export function NotificationContainer({ notifications, onDismiss }: NotificationContainerProps) {
  return (
    <div className="fixed top-12 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      <AnimatePresence>
        {notifications.map((n) => (
          <NotificationAlert
            key={n.id}
            severity={n.severity}
            title={n.title}
            description={n.description}
            icon={n.icon}
            dismissible
            onDismiss={() => onDismiss(n.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
