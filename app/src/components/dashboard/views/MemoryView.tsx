// app/src/components/dashboard/views/MemoryView.tsx
// Step 4 — Memory Inspector: stored entries, retrieval frequency, categories, cache stats.
// Read-only — no editing.

import { useDashboardData, Card, LoadingState, ErrorState, RefreshButton, Badge, EmptyState, formatRelative } from '../shared';
import { dashboardApi, type MemoryOverview } from '@/lib/dashboardApi';

export function MemoryView() {
  const { data, loading, error, refresh } = useDashboardData<MemoryOverview>(
    () => dashboardApi.memory(),
  );

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  const maxSourceType = Math.max(1, ...Object.values(data.bySourceType));
  const maxAgent = Math.max(1, ...Object.values(data.byAgent));
  const maxCategory = Math.max(1, ...Object.values(data.byCategory));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatBox label="Total Entries" value={data.totalEntries} hint={data.sampleNote} />
        <StatBox
          label="In-Memory Cache"
          value={data.cacheStats.inMemoryEntries}
          hint={`capacity ${data.cacheStats.ringBufferCapacity}`}
        />
        <StatBox
          label="DB Mode"
          value={data.cacheStats.dbAvailable ? 'pgvector' : 'in-memory'}
          accent={data.cacheStats.dbAvailable ? 'var(--success)' : 'var(--warning)'}
        />
        <StatBox label="Embedding Model" value={data.cacheStats.embeddingModel} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card title="By Source Type">
          {Object.keys(data.bySourceType).length === 0 ? (
            <EmptyState message="No data (DB required)" />
          ) : (
            <div className="space-y-2">
              {Object.entries(data.bySourceType)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <Bar key={k} label={k} count={v} max={maxSourceType} color="var(--info)" />
                ))}
            </div>
          )}
        </Card>

        <Card title="By Agent">
          {Object.keys(data.byAgent).length === 0 ? (
            <EmptyState message="No data (DB required)" />
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {Object.entries(data.byAgent)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <Bar key={k} label={k} count={v} max={maxAgent} color="var(--siren-red)" />
                ))}
            </div>
          )}
        </Card>

        <Card title="By Tag / Category">
          {Object.keys(data.byCategory).length === 0 ? (
            <EmptyState message="No tags yet" />
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {Object.entries(data.byCategory)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <Bar key={k} label={k} count={v} max={maxCategory} color="var(--success)" />
                ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Retrieval Frequency"
        subtitle="NOT instrumented — MemoryEngine.search() does not currently record retrieval metrics"
      >
        <div
          className="p-3 rounded-md text-[12px]"
          style={{
            backgroundColor: 'rgba(245, 158, 11, 0.05)',
            border: '1px solid rgba(245, 158, 11, 0.2)',
            color: 'var(--warning)',
          }}
        >
          {data.retrievalFrequency.note}
        </div>
      </Card>

      <Card
        title="Recent Memory Entries"
        subtitle={`Showing ${data.entries.length} of ${data.totalEntries} total`}
        right={<RefreshButton onClick={refresh} />}
      >
        {data.entries.length === 0 ? (
          <EmptyState message="No memory entries yet (run an agent to populate)" />
        ) : (
          <div className="space-y-2">
            {data.entries.map((e) => (
              <div
                key={e.id}
                className="p-3 rounded-md"
                style={{ backgroundColor: 'var(--surface-raised)' }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    {e.agentId && <Badge color="var(--info)" background="rgba(59, 130, 246, 0.1)">{e.agentId}</Badge>}
                    {e.sourceType && <Badge>{e.sourceType}</Badge>}
                  </div>
                  <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                    {formatRelative(e.createdAt)}
                  </span>
                </div>
                <div
                  className="text-[12px] font-mono"
                  style={{ color: 'var(--bright-silver)' }}
                >
                  {e.contentPreview}
                  {e.contentPreview.length >= 200 && '…'}
                </div>
                <div className="text-[10px] mt-1.5" style={{ color: 'var(--muted-silver)' }}>
                  id: {e.id}
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
