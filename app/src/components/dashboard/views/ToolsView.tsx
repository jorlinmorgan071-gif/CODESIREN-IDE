// app/src/components/dashboard/views/ToolsView.tsx
// Step 1 — Tools view: list of registered tools from the existing toolRegistry.

import { useDashboardData, Card, LoadingState, ErrorState, RefreshButton, Badge, EmptyState } from '../shared';
import { dashboardApi, type ToolsOverview } from '@/lib/dashboardApi';

export function ToolsView() {
  const { data, loading, error, refresh } = useDashboardData<ToolsOverview>(
    () => dashboardApi.tools(),
  );

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <StatBox label="Total Tools" value={data.totalTools} />
        <StatBox label="Built-in" value={data.tools.filter((t) => ['calculator', 'code_interpreter', 'think'].includes(t.name)).length} />
        <StatBox label="Custom" value={data.tools.filter((t) => !['calculator', 'code_interpreter', 'think'].includes(t.name)).length} />
      </div>

      <Card
        title="Registered Tools"
        subtitle="Existing tool contracts — read-only"
        right={<RefreshButton onClick={refresh} />}
      >
        {data.tools.length === 0 ? (
          <EmptyState message="No tools registered" />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {data.tools.map((t) => {
              const isBuiltin = ['calculator', 'code_interpreter', 'think'].includes(t.name);
              return (
                <div
                  key={t.name}
                  className="p-3 rounded-md"
                  style={{ backgroundColor: 'var(--surface-raised)' }}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <code
                      className="text-[12px] font-mono font-semibold"
                      style={{ color: 'var(--siren-red)' }}
                    >
                      {t.name}
                    </code>
                    <Badge
                      color={isBuiltin ? 'var(--info)' : 'var(--success)'}
                      background={isBuiltin ? 'rgba(59, 130, 246, 0.1)' : 'rgba(34, 197, 94, 0.1)'}
                    >
                      {isBuiltin ? 'built-in' : 'custom'}
                    </Badge>
                  </div>
                  <p className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                    {t.description}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: number | string }) {
  return (
    <div
      className="rounded-md p-3"
      style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--muted-silver)' }}>
        {label}
      </div>
      <div className="text-xl font-semibold" style={{ color: 'var(--bright-silver)' }}>{value}</div>
    </div>
  );
}
