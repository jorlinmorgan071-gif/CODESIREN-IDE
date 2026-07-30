// app/src/components/dashboard/views/TracingView.tsx
// Step 3 — Trace Explorer: task ID, steps, tool calls, execution path, duration, errors.
// Filtering + search + JSON export.

import { useState, useMemo, useCallback } from 'react';
import {
  useDashboardData,
  Card,
  LoadingState,
  ErrorState,
  RefreshButton,
  Badge,
  EmptyState,
  outcomeColor,
  formatTimestamp,
} from '../shared';
import { dashboardApi, type TracesOverview, type TraceListItem } from '@/lib/dashboardApi';
import { Download, Search, X, ChevronRight } from 'lucide-react';

export function TracingView() {
  const [filters, setFilters] = useState<{
    agentId?: string;
    executionMode?: string;
    outcome?: string;
    search?: string;
  }>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const { data, loading, error, refresh } = useDashboardData<TracesOverview>(
    () => dashboardApi.traces(filters),
    [filters.agentId, filters.executionMode, filters.outcome, filters.search],
  );

  const selectedTrace = useMemo(() => {
    if (!selectedTaskId || !data) return null;
    return data.traces.find((t) => t.taskId === selectedTaskId) ?? null;
  }, [selectedTaskId, data]);

  const exportJson = useCallback(() => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code-siren-traces-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data]);

  const exportSingle = useCallback((trace: TraceListItem) => {
    const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trace-${trace.taskId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <div className="space-y-4">
      <Card title="Filters">
        <div className="grid grid-cols-4 gap-3">
          <FilterInput
            label="Agent ID"
            placeholder="e.g. architect-agent"
            value={filters.agentId ?? ''}
            onChange={(v) => setFilters((f) => ({ ...f, agentId: v || undefined }))}
          />
          <FilterSelect
            label="Execution Mode"
            value={filters.executionMode ?? ''}
            onChange={(v) => setFilters((f) => ({ ...f, executionMode: v || undefined }))}
            options={[
              { value: '', label: 'All' },
              { value: 'single-shot', label: 'single-shot' },
              { value: 'react', label: 'react' },
              { value: 'codeact', label: 'codeact' },
            ]}
          />
          <FilterSelect
            label="Outcome"
            value={filters.outcome ?? ''}
            onChange={(v) => setFilters((f) => ({ ...f, outcome: v || undefined }))}
            options={[
              { value: '', label: 'All' },
              { value: 'success', label: 'success' },
              { value: 'error', label: 'error' },
              { value: 'loop-blocked', label: 'loop-blocked' },
              { value: 'max-turns', label: 'max-turns' },
              { value: 'aborted', label: 'aborted' },
            ]}
          />
          <FilterInput
            label="Search"
            placeholder="search input / agent / domain / step labels"
            value={filters.search ?? ''}
            onChange={(v) => setFilters((f) => ({ ...f, search: v || undefined }))}
            icon={<Search className="w-3 h-3" />}
          />
        </div>
        <div className="flex justify-between items-center mt-3">
          <span className="text-[11px]" style={{ color: 'var(--muted-silver)' }}>
            {data ? `${data.total} matches · showing ${data.showing}` : 'loading…'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={exportJson}
              disabled={!data || data.traces.length === 0}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--steel-silver)' }}
              title="Export current results as JSON"
            >
              <Download className="w-3 h-3" />
              Export JSON
            </button>
            <RefreshButton onClick={refresh} />
          </div>
        </div>
      </Card>

      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} />
      ) : !data || data.traces.length === 0 ? (
        <Card><EmptyState message="No traces match the current filters" /></Card>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {/* Trace list */}
          <div className="col-span-1">
            <Card title="Traces" subtitle={`${data.showing} shown`}>
              <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
                {data.traces.map((t) => (
                  <button
                    key={t.taskId}
                    onClick={() => setSelectedTaskId(t.taskId)}
                    className="w-full text-left p-2 rounded transition-colors hover:bg-white/5"
                    style={{
                      backgroundColor: selectedTaskId === t.taskId ? 'rgba(238, 28, 28, 0.08)' : 'var(--surface-raised)',
                      borderLeft: selectedTaskId === t.taskId ? '2px solid var(--siren-red)' : '2px solid transparent',
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <code className="text-[10px] font-mono" style={{ color: 'var(--bright-silver)' }}>
                        {t.taskId.slice(0, 8)}
                      </code>
                      <span className="text-[9px]" style={{ color: outcomeColor(t.outcome) }}>
                        {t.outcome}
                      </span>
                    </div>
                    <div className="text-[10px] truncate" style={{ color: 'var(--steel-silver)' }}>
                      {t.input.slice(0, 60)}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 text-[9px]" style={{ color: 'var(--muted-silver)' }}>
                      <span>{t.agentId}</span>
                      <span>·</span>
                      <span>{t.executionMode}</span>
                      <span>·</span>
                      <span>{t.totalDurationHuman}</span>
                    </div>
                  </button>
                ))}
              </div>
            </Card>
          </div>

          {/* Trace detail */}
          <div className="col-span-2">
            {selectedTrace ? (
              <Card
                title={`Trace ${selectedTrace.taskId.slice(0, 8)}`}
                subtitle={`${selectedTrace.agentId} · ${selectedTrace.executionMode} · ${selectedTrace.totalDurationHuman}`}
                right={
                  <button
                    onClick={() => exportSingle(selectedTrace)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors hover:bg-white/5"
                    style={{ color: 'var(--steel-silver)' }}
                    title="Export this trace as JSON"
                  >
                    <Download className="w-3 h-3" />
                    Export
                  </button>
                }
              >
                <div className="space-y-3">
                  <div className="grid grid-cols-4 gap-2">
                    <DetailStat label="Started" value={formatTimestamp(selectedTrace.startedAt)} />
                    <DetailStat label="Duration" value={selectedTrace.totalDurationHuman} />
                    <DetailStat label="Turns" value={String(selectedTrace.turns)} />
                    <DetailStat label="Steps" value={String(selectedTrace.stepsCount)} />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <DetailStat label="Agent" value={selectedTrace.agentId} />
                    <DetailStat label="Domain" value={selectedTrace.domain} />
                    <DetailStat
                      label="Outcome"
                      value={selectedTrace.outcome}
                      color={outcomeColor(selectedTrace.outcome)}
                    />
                  </div>

                  {selectedTrace.errorMessage && (
                    <div
                      className="p-2 rounded text-[11px]"
                      style={{
                        backgroundColor: 'rgba(238, 28, 28, 0.05)',
                        border: '1px solid rgba(238, 28, 28, 0.2)',
                        color: 'var(--siren-red)',
                      }}
                    >
                      {selectedTrace.errorMessage}
                    </div>
                  )}

                  <div>
                    <SectionLabel>Input</SectionLabel>
                    <pre
                      className="p-2 rounded text-[11px] font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto"
                      style={{
                        backgroundColor: 'var(--surface-raised)',
                        color: 'var(--bright-silver)',
                      }}
                    >
                      {selectedTrace.input}
                    </pre>
                  </div>

                  {selectedTrace.output && (
                    <div>
                      <SectionLabel>Output</SectionLabel>
                      <pre
                        className="p-2 rounded text-[11px] font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto"
                        style={{
                          backgroundColor: 'var(--surface-raised)',
                          color: 'var(--steel-silver)',
                        }}
                      >
                        {selectedTrace.output}
                      </pre>
                    </div>
                  )}

                  <div>
                    <SectionLabel>Execution Path — {selectedTrace.steps.length} steps</SectionLabel>
                    <div className="space-y-1.5">
                      {selectedTrace.steps.map((s, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-2 p-2 rounded"
                          style={{ backgroundColor: 'var(--surface-raised)' }}
                        >
                          <div className="flex items-center gap-1 shrink-0">
                            <span
                              className="text-[10px] font-mono"
                              style={{ color: 'var(--muted-silver)' }}
                            >
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <ChevronRight className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge
                                color={stepKindColor(s.kind)}
                                background={`${stepKindColor(s.kind)}20`}
                              >
                                {s.kind}
                              </Badge>
                              <span className="text-[11px]" style={{ color: 'var(--bright-silver)' }}>
                                {s.label}
                              </span>
                              {s.durationMs !== undefined && (
                                <span className="text-[10px] ml-auto" style={{ color: 'var(--muted-silver)' }}>
                                  {s.durationMs}ms
                                </span>
                              )}
                            </div>
                            <div className="text-[9px] mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                              {new Date(s.ts).toISOString()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {selectedTrace.toolResults.length > 0 && (
                    <div>
                      <SectionLabel>Tool Calls — {selectedTrace.toolResults.length}</SectionLabel>
                      <div className="space-y-1.5">
                        {selectedTrace.toolResults.map((tr, i) => (
                          <div
                            key={i}
                            className="p-2 rounded"
                            style={{ backgroundColor: 'var(--surface-raised)' }}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <code className="text-[11px] font-mono" style={{ color: 'var(--siren-red)' }}>
                                {tr.name}
                              </code>
                              <Badge
                                color={tr.success ? 'var(--success)' : 'var(--siren-red)'}
                                background={tr.success ? 'rgba(34, 197, 94, 0.1)' : 'rgba(238, 28, 28, 0.1)'}
                              >
                                {tr.success ? 'success' : 'failed'}
                              </Badge>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-[10px]">
                              <div>
                                <span style={{ color: 'var(--muted-silver)' }}>args:</span>
                                <pre
                                  className="font-mono whitespace-pre-wrap break-words mt-0.5 max-h-20 overflow-y-auto"
                                  style={{ color: 'var(--steel-silver)' }}
                                >
                                  {JSON.stringify(tr.args, null, 2)}
                                </pre>
                              </div>
                              <div>
                                <span style={{ color: 'var(--muted-silver)' }}>result:</span>
                                <pre
                                  className="font-mono whitespace-pre-wrap break-words mt-0.5 max-h-20 overflow-y-auto"
                                  style={{ color: 'var(--steel-silver)' }}
                                >
                                  {typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            ) : (
              <Card title="Trace Detail">
                <EmptyState message="Select a trace to see execution path, steps, and tool calls" />
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function stepKindColor(kind: string): string {
  switch (kind) {
    case 'llm-call': return 'var(--info)';
    case 'tool-call': return 'var(--siren-red)';
    case 'code-exec': return '#F97316';
    case 'parse': return 'var(--warning)';
    case 'loop-guard': return 'var(--siren-red)';
    case 'done': return 'var(--success)';
    case 'error': return 'var(--siren-red)';
    default: return 'var(--steel-silver)';
  }
}

function FilterInput({
  label,
  placeholder,
  value,
  onChange,
  icon,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider mb-1 block" style={{ color: 'var(--muted-silver)' }}>
        {label}
      </label>
      <div className="relative">
        {icon && (
          <div className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted-silver)' }}>
            {icon}
          </div>
        )}
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 rounded text-[12px] zt-input"
          style={{ paddingLeft: icon ? '24px' : '8px' }}
        />
        {value && (
          <button
            onClick={() => onChange('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--muted-silver)' }}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider mb-1 block" style={{ color: 'var(--muted-silver)' }}>
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 rounded text-[12px] zt-input"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} style={{ backgroundColor: 'var(--surface-raised)' }}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function DetailStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      className="p-2 rounded"
      style={{ backgroundColor: 'var(--surface-raised)' }}
    >
      <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--muted-silver)' }}>
        {label}
      </div>
      <div className="text-[11px] truncate" style={{ color: color ?? 'var(--bright-silver)' }} title={value}>
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[10px] uppercase tracking-wider mb-1.5 mt-3"
      style={{ color: 'var(--muted-silver)' }}
    >
      {children}
    </div>
  );
}
