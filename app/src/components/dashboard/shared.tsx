// app/src/components/dashboard/shared.ts
// Shared helpers + small components used by all dashboard views.

/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { useApp } from '@/store/AppContext';

// ── useDashboardData — fetch + cache + refresh ───────────────────────────
//
// Auth-gate fix (Bug A): the hook now reads `authReady` from AppContext and
// waits for it to become true before firing the fetcher. Before authReady is
// true, the hook stays in `loading: true` state — it does NOT call fetcher()
// (which would fire an unauthenticated request, get a 401, and surface
// "Failed to fetch" to the user). Once authReady flips to true, the effect
// re-runs and fires the fetcher with a valid JWT in localStorage.

export function useDashboardData<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const { state } = useApp();
  const authReady = state.authReady;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Auth gate: do not fire any authenticated fetch until auto-login has
    // completed and the JWT is in localStorage. Stay in loading state so the
    // UI shows a spinner rather than a "Failed to fetch" error.
    if (!authReady) return;
    let cancelled = false;
    setLoading(true);
    fetcher()
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err.message ?? String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, authReady]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

// ── Layout primitives ────────────────────────────────────────────────────

export function Card({
  title,
  subtitle,
  children,
  right,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      className="rounded-md"
      style={{
        backgroundColor: 'var(--surface-dark)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {(title || right) && (
        <div
          className="px-4 py-2.5 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div>
            {title && (
              <div
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--bright-silver)' }}
              >
                {title}
              </div>
            )}
            {subtitle && (
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                {subtitle}
              </div>
            )}
          </div>
          {right}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  accent = 'var(--bright-silver)',
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: string;
}) {
  return (
    <div
      className="rounded-md p-3"
      style={{
        backgroundColor: 'var(--surface-dark)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <div
        className="text-[10px] uppercase tracking-wider mb-1"
        style={{ color: 'var(--muted-silver)' }}
      >
        {label}
      </div>
      <div className="text-xl font-semibold" style={{ color: accent }}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px] mt-1" style={{ color: 'var(--steel-silver)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function Badge({
  children,
  color = 'var(--steel-silver)',
  background = 'var(--surface-raised)',
}: {
  children: ReactNode;
  color?: string;
  background?: string;
}) {
  return (
    <span
      className="inline-block text-[10px] px-1.5 py-0.5 rounded font-medium"
      style={{ color, backgroundColor: background }}
    >
      {children}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  const color =
    status === 'RUNNING' ? 'var(--success)' :
    status === 'ERROR' ? 'var(--siren-red)' :
    status === 'REVIEWING' ? 'var(--warning)' :
    status === 'PAUSED' ? 'var(--muted-silver)' :
    'var(--steel-silver)';
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full mr-1.5"
      style={{ backgroundColor: color }}
    />
  );
}

// ── Loading / error states ───────────────────────────────────────────────

export function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <RefreshCw
        className="w-4 h-4 animate-spin"
        style={{ color: 'var(--steel-silver)' }}
      />
      <span className="ml-2 text-[12px]" style={{ color: 'var(--steel-silver)' }}>
        Loading…
      </span>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="flex items-center gap-2 p-3 rounded-md"
      style={{
        backgroundColor: 'rgba(238, 28, 28, 0.05)',
        border: '1px solid rgba(238, 28, 28, 0.3)',
      }}
    >
      <AlertCircle className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
      <span className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>
        {message}
      </span>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-8">
      <span className="text-[12px]" style={{ color: 'var(--muted-silver)' }}>
        {message}
      </span>
    </div>
  );
}

// ── Refresh button ───────────────────────────────────────────────────────

export function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors hover:bg-white/5"
      style={{ color: 'var(--steel-silver)' }}
      title="Refresh"
    >
      <RefreshCw className="w-3 h-3" />
      Refresh
    </button>
  );
}

// ── Formatters ───────────────────────────────────────────────────────────

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatRelative(ts: number | null): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function trustColor(score: number): string {
  if (score >= 0.85) return 'var(--success)';
  if (score >= 0.7) return 'var(--warning)';
  return 'var(--siren-red)';
}

export function severityColor(severity: string): string {
  switch (severity) {
    case 'critical': return 'var(--siren-red)';
    case 'high': return '#F97316';
    case 'medium': return 'var(--warning)';
    case 'low': return 'var(--info)';
    default: return 'var(--steel-silver)';
  }
}

export function outcomeColor(outcome: string): string {
  switch (outcome) {
    case 'success': return 'var(--success)';
    case 'error': return 'var(--siren-red)';
    case 'loop-blocked': return 'var(--warning)';
    case 'max-turns': return '#F97316';
    case 'aborted': return 'var(--muted-silver)';
    default: return 'var(--steel-silver)';
  }
}
