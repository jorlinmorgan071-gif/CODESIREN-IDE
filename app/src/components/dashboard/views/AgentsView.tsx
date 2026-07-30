// app/src/components/dashboard/views/AgentsView.tsx
// Step 2 — Agent View: status, count, trust score, last execution, duration, errors, memory.
// Read-only — no agent mutation.

import { useDashboardData, Card, LoadingState, ErrorState, RefreshButton, Badge, StatusDot, formatRelative, trustColor } from '../shared';
import { dashboardApi, type AgentsOverview } from '@/lib/dashboardApi';

export function AgentsView() {
  const { data, loading, error, refresh } = useDashboardData<AgentsOverview>(
    () => dashboardApi.agents(),
  );

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatBox label="Total Agents" value={data.totalAgents} />
        <StatBox label="Memory Entries" value={data.memoryEntriesTotal} hint="across all agents" />
        <StatBox label="Traces Sampled" value={data.tracesSampleSize} hint="last 1000 runs" />
        <StatBox
          label="Avg Trust"
          value={(data.agents.reduce((s, a) => s + a.trustScore, 0) / (data.agents.length || 1)).toFixed(3)}
        />
      </div>

      <Card
        title="Agents"
        subtitle={`${data.totalAgents} registered · last ${data.tracesSampleSize} traces mined for stats`}
        right={<RefreshButton onClick={refresh} />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <Th>Agent</Th>
                <Th>Domain</Th>
                <Th>Status</Th>
                <Th>Trust</Th>
                <Th>Skills</Th>
                <Th>Last Exec</Th>
                <Th>Duration</Th>
                <Th>Errors</Th>
                <Th>Runs</Th>
                <Th>Memory</Th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr
                  key={a.id}
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                >
                  <Td>
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: a.color }}
                      />
                      <div>
                        <div style={{ color: 'var(--bright-silver)' }}>{a.name}</div>
                        <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>{a.id}</div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <Badge>{a.domain}</Badge>
                  </Td>
                  <Td>
                    <span style={{ color: 'var(--bright-silver)' }}>
                      <StatusDot status={a.status} />
                      {a.status}
                    </span>
                  </Td>
                  <Td>
                    <span style={{ color: trustColor(a.trustScore) }}>
                      {a.trustScore.toFixed(3)}
                    </span>
                  </Td>
                  <Td>
                    {a.acceptsSkills ? (
                      <Badge color="var(--success)" background="rgba(34, 197, 94, 0.1)">
                        {a.skillsCount}
                      </Badge>
                    ) : (
                      <span style={{ color: 'var(--muted-silver)' }}>—</span>
                    )}
                  </Td>
                  <Td style={{ color: 'var(--steel-silver)' }}>{formatRelative(a.lastExecAt)}</Td>
                  <Td style={{ color: 'var(--steel-silver)' }}>{a.lastDurationHuman}</Td>
                  <Td>
                    {a.errorCount > 0 ? (
                      <span style={{ color: 'var(--siren-red)' }}>{a.errorCount}</span>
                    ) : (
                      <span style={{ color: 'var(--muted-silver)' }}>0</span>
                    )}
                  </Td>
                  <Td style={{ color: 'var(--steel-silver)' }}>{a.totalRuns}</Td>
                  <Td style={{ color: 'var(--steel-silver)' }}>{a.memoryEntries}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function StatBox({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div
      className="rounded-md p-3"
      style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--muted-silver)' }}>
        {label}
      </div>
      <div className="text-xl font-semibold" style={{ color: 'var(--bright-silver)' }}>{value}</div>
      {hint && <div className="text-[10px] mt-1" style={{ color: 'var(--steel-silver)' }}>{hint}</div>}
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
