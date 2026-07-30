// app/src/components/dashboard/DashboardSidebar.tsx
import type { LucideIcon } from "lucide-react";
// Sidebar navigation for the Control Center — 9 views (8 from Step 1 + Performance from Step 6).

import {
  Activity,
  Bot,
  Cpu,
  Database,
  Gauge,
  ScrollText,
  Shield,
  TerminalSquare,
  Wrench,
  ArrowLeft,
} from 'lucide-react';

export type DashboardView =
  | 'system'
  | 'agents'
  | 'execution'
  | 'memory'
  | 'security'
  | 'models'
  | 'tools'
  | 'tracing'
  | 'performance';

interface SidebarItem {
  id: DashboardView;
  label: string;
  icon: LucideIcon;
  step: string;
}

const items: SidebarItem[] = [
  { id: 'system',     label: 'System',     icon: Activity,      step: '1' },
  { id: 'agents',     label: 'Agents',     icon: Bot,           step: '2' },
  { id: 'execution',  label: 'Execution',  icon: Cpu,           step: '1' },
  { id: 'memory',     label: 'Memory',     icon: Database,      step: '4' },
  { id: 'security',   label: 'Security',   icon: Shield,        step: '5' },
  { id: 'models',     label: 'Models',     icon: Gauge,         step: '1' },
  { id: 'tools',      label: 'Tools',      icon: Wrench,        step: '1' },
  { id: 'tracing',    label: 'Tracing',    icon: ScrollText,    step: '3' },
  { id: 'performance',label: 'Performance',icon: TerminalSquare,step: '6' },
];

interface Props {
  active: DashboardView;
  onChange: (view: DashboardView) => void;
  onExit: () => void;
}

export function DashboardSidebar({ active, onChange, onExit }: Props) {
  return (
    <div
      className="w-52 flex flex-col shrink-0"
      style={{
        backgroundColor: 'var(--surface-dark)',
        borderRight: '1px solid var(--border-subtle)',
      }}
    >
      <div
        className="px-4 py-3 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div
          className="w-5 h-5 rounded flex items-center justify-center"
          style={{ backgroundColor: 'var(--siren-red)' }}
        >
          <span className="text-white text-[10px] font-bold">ZT</span>
        </div>
        <div className="flex flex-col">
          <span
            className="text-[11px] font-semibold"
            style={{ color: 'var(--bright-silver)' }}
          >
            Control Center
          </span>
          <span className="text-[9px]" style={{ color: 'var(--steel-silver)' }}>
            Read-only · Phase 4
          </span>
        </div>
      </div>

      <nav className="flex-1 py-2 overflow-y-auto">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/5"
              style={{
                backgroundColor: isActive ? 'rgba(238, 28, 28, 0.08)' : 'transparent',
                borderLeft: isActive ? '2px solid var(--siren-red)' : '2px solid transparent',
              }}
            >
              <Icon
                className="w-4 h-4"
                style={{ color: isActive ? 'var(--siren-red)' : 'var(--steel-silver)' }}
              />
              <span
                className="text-[12px]"
                style={{ color: isActive ? 'var(--bright-silver)' : 'var(--steel-silver)' }}
              >
                {item.label}
              </span>
              <span
                className="ml-auto text-[9px] px-1 rounded"
                style={{
                  backgroundColor: 'var(--surface-raised)',
                  color: 'var(--muted-silver)',
                }}
              >
                {item.step}
              </span>
            </button>
          );
        })}
      </nav>

      <div
        className="p-3"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        <button
          onClick={onExit}
          className="w-full flex items-center gap-2 px-3 py-2 rounded transition-colors hover:bg-white/5"
          style={{ color: 'var(--steel-silver)' }}
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="text-[12px]">Back to IDE</span>
        </button>
      </div>
    </div>
  );
}
