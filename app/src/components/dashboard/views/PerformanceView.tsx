// app/src/components/dashboard/views/PerformanceView.tsx
// Step 6 — Performance: latency, build time, requests, cache hit, agent runtime.
// No optimization — display only.

import { useDashboardData, Card, LoadingState, ErrorState, RefreshButton, Badge, EmptyState } from '../shared';
import { dashboardApi, type PerformanceOverview } from '@/lib/dashboardApi';

export function PerformanceView() {
  const { data, loading, error, refresh } = useDashboardData<PerformanceOverview>(
    () => dashboardApi.performance(),
  );

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  const maxLatency = Math.max(1, data.latency.p99Ms, data.latency.maxMs);
  const maxAgentRuns = Math.max(1, ...data.agentRuntime.map((a) => a.runs));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatBox
          label="Avg Latency"
          value={data.latency.avgHuman}
          hint={`${data.latency.sampleSize} samples`}
        />
        <StatBox
          label="P95 Latency"
          value={data.latency.p95Human}
          accent="var(--warning)"
        />
        <StatBox
          label="P99 Latency"
          value={data.latency.p99Human}
          accent="var(--siren-red)"
        />
        <StatBox
          label="Max Latency"
          value={data.latency.maxMs ? formatMs(data.latency.maxMs) : '—'}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card title="Latency Distribution">
          {data.latency.sampleSize === 0 ? (
            <EmptyState message="No traces yet" />
          ) : (
            <div className="space-y-3">
              <LatencyBar label="Avg" ms={data.latency.avgMs} max={maxLatency} color="var(--info)" />
              <LatencyBar label="P50" ms={data.latency.p50Ms} max={maxLatency} color="var(--success)" />
              <LatencyBar label="P95" ms={data.latency.p95Ms} max={maxLatency} color="var(--warning)" />
              <LatencyBar label="P99" ms={data.latency.p99Ms} max={maxLatency} color="var(--siren-red)" />
              <LatencyBar label="Max" ms={data.latency.maxMs} max={maxLatency} color="#F97316" />
            </div>
          )}
        </Card>

        <Card title="Process Memory">
          <div className="space-y-2">
            <MemoryBar label="Heap Used" used={data.processMemory.heapUsed} total={data.processMemory.heapTotal} />
            <div className="text-[11px] flex justify-between" style={{ color: 'var(--steel-silver)' }}>
              <span>RSS</span>
              <span>{data.processMemory.rssHuman}</span>
            </div>
            <div className="text-[11px] flex justify-between" style={{ color: 'var(--steel-silver)' }}>
              <span>Heap Total</span>
              <span>{data.processMemory.heapTotalHuman}</span>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card title="Build Time">
          <div
            className="p-3 rounded text-[11px]"
            style={{
              backgroundColor: 'rgba(59, 130, 246, 0.05)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              color: 'var(--info)',
            }}
          >
            {data.buildTime.note}
          </div>
          <div className="mt-2 text-[11px]" style={{ color: 'var(--steel-silver)' }}>
            See PHASE4_REPORT.md for measured build time.
          </div>
        </Card>

        <Card title="Requests (active buckets)">
          <div className="space-y-2">
            <MetricRow label="IP buckets" value={data.requests.activeIpBuckets} />
            <MetricRow label="User buckets" value={data.requests.activeUserBuckets} />
            <MetricRow label="WS buckets" value={data.requests.activeWsBuckets} />
          </div>
          <div
            className="mt-2 pt-2 text-[10px] border-t"
            style={{ color: 'var(--muted-silver)', borderColor: 'var(--border-subtle)' }}
          >
            {data.requests.note}
          </div>
        </Card>

        <Card title="Cache">
          <div className="space-y-2">
            <MetricRow label="In-memory entries" value={data.cacheHit.inMemoryEntries} />
            <MetricRow
              label="DB available"
              value={data.cacheHit.dbAvailable ? 'yes' : 'no'}
              color={data.cacheHit.dbAvailable ? 'var(--success)' : 'var(--warning)'}
            />
          </div>
          <div
            className="mt-2 pt-2 text-[10px] border-t"
            style={{ color: 'var(--muted-silver)', borderColor: 'var(--border-subtle)' }}
          >
            {data.cacheHit.note}
          </div>
        </Card>
      </div>

      <Card
        title="Agent Runtime"
        subtitle="Per-agent runtime stats from last 1000 traces"
        right={<RefreshButton onClick={refresh} />}
      >
        {data.agentRuntime.length === 0 ? (
          <EmptyState message="No agent runs yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <Th>Agent</Th>
                  <Th>Runs</Th>
                  <Th>Avg Duration</Th>
                  <Th>Max Duration</Th>
                  <Th>Errors</Th>
                  <Th>Error Rate</Th>
                  <Th>Run Distribution</Th>
                </tr>
              </thead>
              <tbody>
                {data.agentRuntime.map((a) => (
                  <tr key={a.agentId} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <Td style={{ color: 'var(--bright-silver)' }}>{a.agentId}</Td>
                    <Td style={{ color: 'var(--steel-silver)' }}>{a.runs}</Td>
                    <Td style={{ color: 'var(--bright-silver)' }}>{a.avgHuman}</Td>
                    <Td style={{ color: 'var(--steel-silver)' }}>{a.maxHuman}</Td>
                    <Td>
                      {a.errors > 0 ? (
                        <span style={{ color: 'var(--siren-red)' }}>{a.errors}</span>
                      ) : (
                        <span style={{ color: 'var(--muted-silver)' }}>0</span>
                      )}
                    </Td>
                    <Td>
                      <Badge
                        color={a.errorRate > 0.1 ? 'var(--siren-red)' : a.errorRate > 0 ? 'var(--warning)' : 'var(--success)'}
                        background={
                          a.errorRate > 0.1 ? 'rgba(238, 28, 28, 0.1)' :
                          a.errorRate > 0 ? 'rgba(245, 158, 11, 0.1)' :
                          'rgba(34, 197, 94, 0.1)'
                        }
                      >
                        {(a.errorRate * 100).toFixed(1)}%
                      </Badge>
                    </Td>
                    <Td>
                      <div className="w-24 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-raised)' }}>
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(a.runs / maxAgentRuns) * 100}%`,
                            backgroundColor: 'var(--siren-red)',
                          }}
                        />
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function StatBox({ label, value, hint, accent }: { label: string; value: string | number; hint?: string; accent?: string }) {
  return (
    <div
      className="rounded-md p-3"
      style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--muted-silver)' }}>
        {label}
      </div>
      <div className="text-xl font-semibold" style={{ color: accent ?? 'var(--bright-silver)' }}>{value}</div>
      {hint && <div className="text-[10px] mt-1" style={{ color: 'var(--steel-silver)' }}>{hint}</div>}
    </div>
  );
}

function LatencyBar({ label, ms, max, color }: { label: string; ms: number; max: number; color: string }) {
  const pct = (ms / max) * 100;
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1">
        <span style={{ color: 'var(--bright-silver)' }}>{label}</span>
        <span style={{ color: 'var(--steel-silver)' }}>{formatMs(ms)}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-raised)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function MemoryBar({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1">
        <span style={{ color: 'var(--bright-silver)' }}>{label}</span>
        <span style={{ color: 'var(--steel-silver)' }}>
          {(used / 1024 / 1024).toFixed(1)}MB / {(total / 1024 / 1024).toFixed(1)}MB ({pct.toFixed(0)}%)
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-raised)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            backgroundColor: pct > 80 ? 'var(--siren-red)' : 'var(--info)',
          }}
        />
      </div>
    </div>
  );
}

function MetricRow({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="flex justify-between text-[11px]">
      <span style={{ color: 'var(--steel-silver)' }}>{label}</span>
      <span style={{ color: color ?? 'var(--bright-silver)' }}>{value}</span>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="text-left px-3 py-2 text-[10px] uppercase tracking-wider font-medium"
      style={{ color: 'var(--muted-silver)' }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td className="px-3 py-2.5" style={style}>{children}</td>;
}
