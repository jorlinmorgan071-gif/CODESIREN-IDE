// app/src/components/dashboard/views/ExecutionView.tsx
// Step 1 — Execution view: distribution by mode, outcome, domain. Recent runs.

import { useDashboardData, Card, LoadingState, ErrorState, RefreshButton, Badge, EmptyState, formatRelative, outcomeColor } from '../shared';
import { dashboardApi, type ExecutionOverview } from '@/lib/dashboardApi';

export function ExecutionView() {
  const { data, loading, error, refresh } = useDashboardData<ExecutionOverview>(
    () => dashboardApi.execution(),
  );

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  const maxModeCount = Math.max(1, ...Object.values(data.byMode));
  const maxOutcomeCount = Math.max(1, ...Object.values(data.byOutcome));
  const maxDomainCount = Math.max(1, ...Object.values(data.byDomain));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatBox label="Total Runs" value={data.totalRuns} hint={data.sampleNote} />
        <StatBox label="Avg Duration" value={data.duration.avgHuman} />
        <StatBox label="Max Duration" value={data.duration.maxHuman} />
        <StatBox label="Min Duration" value={data.duration.minHuman} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card title="By Execution Mode">
          <div className="space-y-2">
            {Object.entries(data.byMode).map(([mode, count]) => (
              <Bar
                key={mode}
                label={mode}
                count={count}
                max={maxModeCount}
                color="var(--siren-red)"
              />
            ))}
          </div>
        </Card>

        <Card title="By Outcome">
          <div className="space-y-2">
            {Object.entries(data.byOutcome).map(([outcome, count]) => (
              <Bar
                key={outcome}
                label={outcome}
                count={count}
                max={maxOutcomeCount}
                color={outcomeColor(outcome)}
              />
            ))}
          </div>
        </Card>

        <Card title="By Domain">
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {Object.entries(data.byDomain)
              .sort((a, b) => b[1] - a[1])
              .map(([domain, count]) => (
                <Bar
                  key={domain}
                  label={domain}
                  count={count}
                  max={maxDomainCount}
                  color="var(--info)"
                />
              ))}
            {Object.keys(data.byDomain).length === 0 && <EmptyState message="No traces yet" />}
          </div>
        </Card>
      </div>

      <Card
        title="Recent Runs"
        subtitle={`Last ${data.recent.length} runs`}
        right={<RefreshButton onClick={refresh} />}
      >
        {data.recent.length === 0 ? (
          <EmptyState message="No runs yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <Th>Started</Th>
                  <Th>Agent</Th>
                  <Th>Domain</Th>
                  <Th>Mode</Th>
                  <Th>Outcome</Th>
                  <Th>Turns</Th>
                  <Th>Steps</Th>
                  <Th>Tools</Th>
                  <Th>Duration</Th>
                  <Th>Input Preview</Th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.traceId} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <Td style={{ color: 'var(--steel-silver)' }}>{formatRelative(r.startedAt)}</Td>
                    <Td style={{ color: 'var(--bright-silver)' }}>{r.agentId}</Td>
                    <Td><Badge>{r.domain}</Badge></Td>
                    <Td><Badge color="var(--info)" background="rgba(59, 130, 246, 0.1)">{r.executionMode}</Badge></Td>
                    <Td>
                      <span style={{ color: outcomeColor(r.outcome) }}>{r.outcome}</span>
                    </Td>
                    <Td style={{ color: 'var(--steel-silver)' }}>{r.turns}</Td>
                    <Td style={{ color: 'var(--steel-silver)' }}>{r.stepsCount}</Td>
                    <Td style={{ color: 'var(--steel-silver)' }}>{r.toolCallsCount}</Td>
                    <Td style={{ color: 'var(--steel-silver)' }}>{r.durationHuman}</Td>
                    <Td
                      className="max-w-xs truncate"
                      style={{ color: 'var(--steel-silver)' }}
                      title={r.inputPreview}
                    >
                      {r.inputPreview}
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

function StatBox({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
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

function Bar({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  const pct = (count / max) * 100;
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1">
        <span style={{ color: 'var(--bright-silver)' }}>{label}</span>
        <span style={{ color: 'var(--steel-silver)' }}>{count}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-raised)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
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

function Td({ children, style, className, title }: { children: React.ReactNode; style?: React.CSSProperties; className?: string; title?: string }) {
  return <td className={`px-3 py-2.5 ${className ?? ''}`} style={style} title={title}>{children}</td>;
}
