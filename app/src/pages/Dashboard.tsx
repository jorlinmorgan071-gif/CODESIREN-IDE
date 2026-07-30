// app/src/pages/Dashboard.tsx
// Phase 4 — Control Center. Read-only dashboard with 9 views.
// No backend behavior changes. No mutation. Aggregation + visualization only.

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { DashboardSidebar, type DashboardView } from '@/components/dashboard/DashboardSidebar';
import { SystemView } from '@/components/dashboard/views/SystemView';
import { AgentsView } from '@/components/dashboard/views/AgentsView';
import { ExecutionView } from '@/components/dashboard/views/ExecutionView';
import { MemoryView } from '@/components/dashboard/views/MemoryView';
import { SecurityView } from '@/components/dashboard/views/SecurityView';
import { ModelsView } from '@/components/dashboard/views/ModelsView';
import { ToolsView } from '@/components/dashboard/views/ToolsView';
import { TracingView } from '@/components/dashboard/views/TracingView';
import { PerformanceView } from '@/components/dashboard/views/PerformanceView';

export default function Dashboard() {
  const [view, setView] = useState<DashboardView>('system');
  const navigate = useNavigate();
  const exit = useCallback(() => navigate('/'), [navigate]);

  return (
    <div
      className="h-screen w-screen flex overflow-hidden"
      style={{ backgroundColor: 'var(--void-black)' }}
    >
      <DashboardSidebar active={view} onChange={setView} onExit={exit} />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div
          className="h-10 px-5 flex items-center justify-between shrink-0"
          style={{
            backgroundColor: '#0A0A10',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div className="flex items-center gap-2">
            <h1
              className="text-[13px] font-semibold uppercase tracking-wider"
              style={{ color: 'var(--bright-silver)' }}
            >
              {view}
            </h1>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: 'rgba(34, 197, 94, 0.1)',
                color: 'var(--success)',
              }}
            >
              READ-ONLY
            </span>
          </div>
          <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
            Phase 4 · Observability + Control Center
          </span>
        </div>

        {/* View body */}
        <div className="flex-1 overflow-auto p-5">
          {view === 'system'      && <SystemView />}
          {view === 'agents'      && <AgentsView />}
          {view === 'execution'   && <ExecutionView />}
          {view === 'memory'      && <MemoryView />}
          {view === 'security'    && <SecurityView />}
          {view === 'models'      && <ModelsView />}
          {view === 'tools'       && <ToolsView />}
          {view === 'tracing'     && <TracingView />}
          {view === 'performance' && <PerformanceView />}
        </div>
      </div>
    </div>
  );
}
