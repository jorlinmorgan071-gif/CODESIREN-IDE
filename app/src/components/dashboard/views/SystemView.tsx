// app/src/components/dashboard/views/SystemView.tsx
// Step 1 — System overview: server, database, agents, ghost mode, sidecars, memory.

import { useDashboardData, Card, StatCard, LoadingState, ErrorState, RefreshButton, formatTimestamp, formatRelative } from '../shared';
import { dashboardApi, type SystemOverview } from '@/lib/dashboardApi';

export function SystemView() {
  const { data, loading, error, refresh } = useDashboardData<SystemOverview>(
    () => dashboardApi.system(),
  );

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatCard
          label="Uptime"
          value={data.server.uptimeHuman}
          hint={`Since ${formatTimestamp(data.server.startedAt)}`}
        />
        <StatCard
          label="Agents Registered"
          value={data.agents.total}
          hint={`${data.agents.idle} idle · ${data.agents.running} running`}
        />
        <StatCard
          label="Sidecars"
          value={data.sidecars.count}
          hint={data.sidecars.registered.length > 0 ? data.sidecars.registered.join(', ') : 'none (spawned on demand)'}
        />
        <StatCard
          label="DB Mode"
          value={data.database.mode === 'postgresql' ? 'PostgreSQL' : 'In-memory'}
          hint={data.database.available ? 'pgvector ready' : 'degraded'}
          accent={data.database.available ? 'var(--success)' : 'var(--warning)'}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card
          title="Server"
          right={<RefreshButton onClick={refresh} />}
        >
          <dl className="space-y-2 text-[12px]">
            <Row label="Name" value={data.server.name} />
            <Row label="Version" value={data.server.version} />
            <Row label="Node" value={data.server.nodeVersion} />
            <Row label="Platform" value={data.server.platform} />
            <Row label="PID" value={String(data.server.pid)} />
            <Row label="Started" value={formatTimestamp(data.server.startedAt)} />
            <Row label="Uptime" value={`${data.server.uptimeHuman} (${formatRelative(data.server.startedAt)})`} />
          </dl>
        </Card>

        <Card title="Ghost Mode">
          <dl className="space-y-2 text-[12px]">
            <Row label="State" value={data.ghost.state} accent="var(--siren-red)" />
            <Row label="Level" value={data.ghost.level} />
          </dl>
          <div className="mt-4 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>
              Agent Status Breakdown
            </div>
            <div className="grid grid-cols-5 gap-2">
              <MiniStat label="Idle" value={data.agents.idle} color="var(--steel-silver)" />
              <MiniStat label="Running" value={data.agents.running} color="var(--success)" />
              <MiniStat label="Reviewing" value={data.agents.reviewing} color="var(--warning)" />
              <MiniStat label="Error" value={data.agents.error} color="var(--siren-red)" />
              <MiniStat label="Paused" value={data.agents.paused} color="var(--muted-silver)" />
            </div>
          </div>
        </Card>

        <Card title="Process Memory">
          <dl className="space-y-2 text-[12px]">
            <Row label="RSS" value={`${data.memory.rssHuman} (${data.memory.rss.toLocaleString()} B)`} />
            <Row label="Heap Used" value={`${data.memory.heapUsedHuman} / ${data.memory.heapTotalHuman}`} />
            <Row label="Heap Total" value={data.memory.heapTotalHuman} />
            <Row label="External" value={data.memory.externalHuman} />
          </dl>
        </Card>

        <Card title="Configuration">
          <dl className="space-y-2 text-[12px]">
            <Row label="Port" value={String(data.config.port)} />
            <Row label="Node Env" value={data.config.nodeEnv} />
            <Row label="Ollama Host" value={data.config.ollamaHost} />
            <Row label="Ollama Default" value={data.config.ollamaDefaultModel} />
            <Row label="CORS Origins" value={data.config.corsOrigins.join(', ')} />
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex justify-between items-center gap-3">
      <dt style={{ color: 'var(--muted-silver)' }}>{label}</dt>
      <dd
        className="text-right truncate"
        style={{ color: accent ?? 'var(--bright-silver)' }}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      className="rounded p-2 text-center"
      style={{ backgroundColor: 'var(--surface-raised)' }}
    >
      <div className="text-base font-semibold" style={{ color }}>{value}</div>
      <div className="text-[9px] uppercase" style={{ color: 'var(--muted-silver)' }}>{label}</div>
    </div>
  );
}
