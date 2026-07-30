// app/src/components/dashboard/views/SecurityView.tsx
// Step 5 — Security Panel: rate limits, rejections, timeouts, circuit breakers, threat heat map.
// Uses existing telemetry (security-log + rate-limiter + circuit-breaker).

import { useDashboardData, Card, LoadingState, ErrorState, RefreshButton, Badge, EmptyState, severityColor, formatRelative, formatTimestamp } from '../shared';
import { dashboardApi, type SecurityOverview } from '@/lib/dashboardApi';

export function SecurityView() {
  const { data, loading, error, refresh } = useDashboardData<SecurityOverview>(
    () => dashboardApi.security(),
  );

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  const maxHourCount = Math.max(1, ...data.threatHeatMap.byHour.map((h) => h.count));
  const totalBreakers = Object.keys(data.circuitBreakers).length;
  const openBreakers = Object.values(data.circuitBreakers).filter((b) => b.state === 'open').length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatBox
          label="Total Events"
          value={data.summary.total}
          hint={`${data.summary.last5Minutes} in last 5 min`}
        />
        <StatBox
          label="Active IP Buckets"
          value={data.rateLimits.active.ipBuckets}
          hint={`limit: ${data.rateLimits.config.maxPerIp}/min`}
        />
        <StatBox
          label="Active User Buckets"
          value={data.rateLimits.active.userBuckets}
          hint={`limit: ${data.rateLimits.config.maxPerUser}/min`}
        />
        <StatBox
          label="Circuit Breakers"
          value={`${openBreakers}/${totalBreakers} open`}
          accent={openBreakers > 0 ? 'var(--siren-red)' : 'var(--success)'}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card title="Events by Severity (last 5 min)">
          <div className="grid grid-cols-4 gap-2">
            {(['critical', 'high', 'medium', 'low'] as const).map((sev) => (
              <div
                key={sev}
                className="rounded p-2 text-center"
                style={{ backgroundColor: 'var(--surface-raised)' }}
              >
                <div
                  className="text-lg font-semibold"
                  style={{ color: severityColor(sev) }}
                >
                  {data.summary.bySeverity[sev] ?? 0}
                </div>
                <div className="text-[9px] uppercase" style={{ color: 'var(--muted-silver)' }}>
                  {sev}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Events by Type (last 5 min)">
          {Object.keys(data.summary.byType).length === 0 ? (
            <EmptyState message="No events in last 5 minutes" />
          ) : (
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {Object.entries(data.summary.byType)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => (
                  <div key={type} className="flex justify-between text-[11px]">
                    <span style={{ color: 'var(--bright-silver)' }}>{type}</span>
                    <span style={{ color: 'var(--steel-silver)' }}>{count}</span>
                  </div>
                ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Threat Heat Map — Events per Hour (last 24h)">
        <div className="flex items-end gap-1 h-32">
          {data.threatHeatMap.byHour.map((h) => {
            const pct = (h.count / maxHourCount) * 100;
            return (
              <div
                key={h.hour}
                className="flex-1 flex flex-col items-center justify-end h-full"
                title={`${h.hour}: ${h.count} events`}
              >
                <div
                  className="w-full rounded-t transition-all"
                  style={{
                    height: `${pct}%`,
                    minHeight: h.count > 0 ? '4px' : '0',
                    backgroundColor: h.count > 0
                      ? `rgba(238, 28, 28, ${0.3 + (pct / 100) * 0.7})`
                      : 'transparent',
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between text-[9px] mt-2" style={{ color: 'var(--muted-silver)' }}>
          <span>24h ago</span>
          <span>now</span>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card title="Top IPs by Event Count">
          {data.threatHeatMap.byIp.length === 0 ? (
            <EmptyState message="No events yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <th className="text-left px-2 py-1.5 text-[10px] uppercase" style={{ color: 'var(--muted-silver)' }}>IP</th>
                    <th className="text-right px-2 py-1.5 text-[10px] uppercase" style={{ color: 'var(--muted-silver)' }}>Total</th>
                    <th className="text-right px-2 py-1.5 text-[10px] uppercase" style={{ color: 'var(--muted-silver)' }}>Crit</th>
                    <th className="text-right px-2 py-1.5 text-[10px] uppercase" style={{ color: 'var(--muted-silver)' }}>High</th>
                    <th className="text-right px-2 py-1.5 text-[10px] uppercase" style={{ color: 'var(--muted-silver)' }}>Med</th>
                  </tr>
                </thead>
                <tbody>
                  {data.threatHeatMap.byIp.slice(0, 15).map((row) => (
                    <tr key={row.ip} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td className="px-2 py-1.5" style={{ color: 'var(--bright-silver)' }}>{row.ip}</td>
                      <td className="text-right px-2 py-1.5" style={{ color: 'var(--bright-silver)' }}>{row.count}</td>
                      <td className="text-right px-2 py-1.5" style={{ color: severityColor('critical') }}>{row.critical}</td>
                      <td className="text-right px-2 py-1.5" style={{ color: severityColor('high') }}>{row.high}</td>
                      <td className="text-right px-2 py-1.5" style={{ color: severityColor('medium') }}>{row.medium}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Circuit Breakers">
          {totalBreakers === 0 ? (
            <EmptyState message="No breakers registered" />
          ) : (
            <div className="space-y-2">
              {Object.entries(data.circuitBreakers).map(([name, b]) => (
                <div
                  key={name}
                  className="flex items-center justify-between p-2 rounded"
                  style={{ backgroundColor: 'var(--surface-raised)' }}
                >
                  <div>
                    <div className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>{name}</div>
                    <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                      failures: {b.failures} · successes: {b.successes}
                    </div>
                  </div>
                  <Badge
                    color={b.state === 'closed' ? 'var(--success)' : b.state === 'open' ? 'var(--siren-red)' : 'var(--warning)'}
                    background={
                      b.state === 'closed' ? 'rgba(34, 197, 94, 0.1)' :
                      b.state === 'open' ? 'rgba(238, 28, 28, 0.1)' :
                      'rgba(245, 158, 11, 0.1)'
                    }
                  >
                    {b.state}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Recent Security Events"
        subtitle={`Last ${data.recentEvents.length} events`}
        right={<RefreshButton onClick={refresh} />}
      >
        {data.recentEvents.length === 0 ? (
          <EmptyState message="No security events" />
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {data.recentEvents.map((e) => (
              <div
                key={e.id}
                className="flex items-start gap-3 p-2 rounded"
                style={{ backgroundColor: 'var(--surface-raised)' }}
              >
                <div
                  className="w-1 self-stretch rounded-full shrink-0"
                  style={{ backgroundColor: severityColor(e.severity) }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge color={severityColor(e.severity)} background={`${severityColor(e.severity)}20`}>
                      {e.severity}
                    </Badge>
                    <span className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                      {e.type}
                    </span>
                    {e.method && (
                      <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                        {e.method} {e.endpoint}
                      </span>
                    )}
                    <span className="text-[10px] ml-auto" style={{ color: 'var(--muted-silver)' }}>
                      {formatRelative(e.timestamp)}
                    </span>
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--steel-silver)' }}>
                    {e.description}
                  </div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                    {e.ip && `ip=${e.ip} `}
                    {e.userId && `user=${e.userId} `}
                    {formatTimestamp(e.timestamp)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
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
