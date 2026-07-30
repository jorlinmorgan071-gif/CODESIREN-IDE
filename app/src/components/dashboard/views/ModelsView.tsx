// app/src/components/dashboard/views/ModelsView.tsx
// Step 1 — Models view: engine status, available models, agent overrides.

import { useDashboardData, Card, LoadingState, ErrorState, RefreshButton, Badge, EmptyState } from '../shared';
import { dashboardApi, type ModelsOverview } from '@/lib/dashboardApi';

export function ModelsView() {
  const { data, loading, error, refresh } = useDashboardData<ModelsOverview>(
    () => dashboardApi.models(),
  );

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatBox
          label="Preferred Engine"
          value={data.preferredEngine}
          accent="var(--siren-red)"
        />
        <StatBox
          label="Ollama"
          value={data.engines.ollama.available ? 'Online' : 'Offline'}
          accent={data.engines.ollama.available ? 'var(--success)' : 'var(--siren-red)'}
        />
        <StatBox
          label="Ollama Models"
          value={data.engines.ollama.models.length}
          hint={data.engines.ollama.defaultModel}
        />
        <StatBox
          label="Agent Overrides"
          value={Object.keys(data.agentOverrides).length}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card
          title="Engines"
          right={<RefreshButton onClick={refresh} />}
        >
          <div className="space-y-2">
            <EngineRow
              name="Ollama (Local)"
              id="ollama"
              available={data.engines.ollama.available}
              detail={data.engines.ollama.available
                ? `host=${data.engines.ollama.host} · default=${data.engines.ollama.defaultModel}`
                : data.engines.ollama.error ?? 'unavailable'}
            />
            <EngineRow
              name="OpenRouter (Cloud)"
              id="openrouter"
              available={data.engines.openrouter.available}
              detail={data.engines.openrouter.available ? 'API key set' : 'no API key'}
            />
            <EngineRow
              name="OpenAI (Cloud)"
              id="openai"
              available={data.engines.openai.available}
              detail={data.engines.openai.available ? 'API key set' : 'no API key'}
            />
            <EngineRow
              name="Anthropic (Cloud)"
              id="anthropic"
              available={data.engines.anthropic.available}
              detail={data.engines.anthropic.available ? 'API key set' : 'no API key'}
            />
            <EngineRow
              name="Stub (No LLM)"
              id="stub"
              available={data.engines.stub.available}
              detail="synthetic output for testing"
            />
          </div>
        </Card>

        <Card title="Ollama Models">
          {!data.engines.ollama.available ? (
            <EmptyState message={data.engines.ollama.error ?? 'Ollama unavailable'} />
          ) : data.engines.ollama.models.length === 0 ? (
            <EmptyState message="No models installed — run `ollama pull llama3.2`" />
          ) : (
            <div className="space-y-1.5 max-h-96 overflow-y-auto">
              {data.engines.ollama.models.map((m) => (
                <div
                  key={m.name}
                  className="flex items-center justify-between p-2 rounded"
                  style={{ backgroundColor: 'var(--surface-raised)' }}
                >
                  <div>
                    <div className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>
                      {m.name}
                    </div>
                    {m.modifiedAt && (
                      <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                        {new Date(m.modifiedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {m.size && (
                      <span className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
                        {(m.size / 1024 / 1024 / 1024).toFixed(2)} GB
                      </span>
                    )}
                    {m.name === data.engines.ollama.defaultModel && (
                      <Badge color="var(--success)" background="rgba(34, 197, 94, 0.1)">active</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Agent Model Overrides">
        {Object.keys(data.agentOverrides).length === 0 ? (
          <EmptyState message="No per-agent overrides — all agents use the global default" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <th className="text-left px-3 py-2 text-[10px] uppercase" style={{ color: 'var(--muted-silver)' }}>Agent</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase" style={{ color: 'var(--muted-silver)' }}>Model</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase" style={{ color: 'var(--muted-silver)' }}>Source</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.agentOverrides).map(([agentId, info]) => (
                  <tr key={agentId} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td className="px-3 py-2" style={{ color: 'var(--bright-silver)' }}>{agentId}</td>
                    <td className="px-3 py-2" style={{ color: 'var(--bright-silver)' }}>{info.model}</td>
                    <td className="px-3 py-2"><Badge>{info.source}</Badge></td>
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

function EngineRow({ name, available, detail }: { name: string; id: string; available: boolean; detail: string }) {
  return (
    <div
      className="flex items-center justify-between p-2.5 rounded"
      style={{ backgroundColor: 'var(--surface-raised)' }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: available ? 'var(--success)' : 'var(--muted-silver)' }}
        />
        <div>
          <div className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>{name}</div>
          <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>{detail}</div>
        </div>
      </div>
      <Badge
        color={available ? 'var(--success)' : 'var(--muted-silver)'}
        background={available ? 'rgba(34, 197, 94, 0.1)' : 'var(--surface-dark)'}
      >
        {available ? 'available' : 'unavailable'}
      </Badge>
    </div>
  );
}
