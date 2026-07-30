import type { LucideIcon } from "lucide-react";
import { useState } from 'react';
import { useApp } from '@/store/AppContext';
import { useRelay } from '@/store/RelayContext';
import type { GhostMode, ThemeName } from '@/types';
import { themes } from '@/store/themes';
import {
  Eye,
  CheckCircle,
  Zap,
  Flame,
  ChevronUp,
  Bot,
  CircleDot,
  Palette,
  Loader2,
} from 'lucide-react';

const ghostModeConfig: Record<GhostMode, { icon: LucideIcon; label: string; color: string; description: string }> = {
  observation: { icon: Eye, label: 'Observation', color: '#8A8AA0', description: 'AI monitors and reports only' },
  approval: { icon: CheckCircle, label: 'Approval', color: '#F59E0B', description: 'AI prepares fixes, waits for approval' },
  auto: { icon: Zap, label: 'Auto-Amend', color: '#F97316', description: 'AI applies safe improvements silently' },
  autonomous: { icon: Flame, label: 'Autonomous', color: '#EE1C1C', description: 'Full AI autonomy with notifications' },
};

const ghostModes: GhostMode[] = ['observation', 'approval', 'auto', 'autonomous'];

export function StatusBar() {
  const { state, setGhostMode, setTheme } = useApp();
  const relay = useRelay();
  const [ghostDropdownOpen, setGhostDropdownOpen] = useState(false);
  const [themeDropdownOpen, setThemeDropdownOpen] = useState(false);

  const currentGhost = ghostModeConfig[state.ghostMode];
  const GhostIcon = currentGhost.icon;

  const activeAgents = state.agents.filter((a) => a.status === 'working' || a.status === 'reviewing');
  const mainAgent = activeAgents[0];

  return (
    <div
      className="h-9 flex items-center justify-between px-3 text-[11px]"
      style={{
        backgroundColor: '#0A0A10',
        borderTop: '1px solid var(--border-subtle)',
        color: 'var(--steel-silver)',
      }}
    >
      {/* Left — Zero Two Status */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <CircleDot className="w-3 h-3 animate-agent-pulse" style={{ color: 'var(--siren-red)' }} />
          <span style={{ color: 'var(--bright-silver)' }}>Zero Two</span>
          <span style={{ color: 'var(--muted-silver)' }}>v4.0</span>
        </div>

        {mainAgent && (
          <>
            <div className="w-px h-3" style={{ backgroundColor: 'var(--border-subtle)' }} />
            <div className="flex items-center gap-1.5">
              <Bot className="w-3 h-3" style={{ color: mainAgent.color }} />
              <span>
                {mainAgent.name}: {mainAgent.currentTask}
              </span>
              <div
                className="w-1.5 h-1.5 rounded-full animate-agent-pulse"
                style={{ backgroundColor: mainAgent.color }}
              />
            </div>
          </>
        )}

        {/* Agent Relay status — directive Section 2.3.
            Shows "Relay: {projectName} — {currentMilestone} — {agentId} working"
            when a relay is running. */}
        {relay.status === 'running' && relay.activeProjectName && (
          <>
            <div className="w-px h-3" style={{ backgroundColor: 'var(--border-subtle)' }} />
            <div className="flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--siren-red)' }} />
              <span style={{ color: 'var(--bright-silver)' }}>
                Relay: {relay.activeProjectName}
              </span>
              {relay.activeMilestoneTitle && (
                <span style={{ color: 'var(--steel-silver)' }}>
                  — {relay.activeMilestoneTitle.split('\n')[0]}
                </span>
              )}
              {relay.activeAgentId && (
                <span style={{ color: 'var(--muted-silver)' }}>
                  — {relay.activeAgentId} working
                </span>
              )}
            </div>
          </>
        )}
        {relay.status === 'awaiting-user' && relay.activeProjectName && (
          <>
            <div className="w-px h-3" style={{ backgroundColor: 'var(--border-subtle)' }} />
            <div className="flex items-center gap-1.5">
              <div
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ backgroundColor: '#F59E0B' }}
              />
              <span style={{ color: '#F59E0B' }}>
                Relay: {relay.activeProjectName} — awaiting your input
              </span>
            </div>
          </>
        )}
      </div>

      {/* Center — Active Agent Tasks */}
      <div className="flex items-center gap-3">
        <span>TypeScript</span>
        <span>UTF-8</span>
        <span>LF</span>
        <div className="w-px h-3" style={{ backgroundColor: 'var(--border-subtle)' }} />
        <span>{activeAgents.length} agents active</span>
      </div>

      {/* Right — Ghost Mode + Theme */}
      <div className="flex items-center gap-2">
        {/* Ghost Mode Toggle */}
        <div className="relative">
          <button
            className="flex items-center gap-1.5 px-2 py-1 rounded transition-colors hover:bg-white/5"
            onClick={() => setGhostDropdownOpen(!ghostDropdownOpen)}
          >
            <GhostIcon className="w-3 h-3" style={{ color: currentGhost.color }} />
            <span style={{ color: currentGhost.color }}>{currentGhost.label}</span>
            <ChevronUp className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} />
          </button>

          {ghostDropdownOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setGhostDropdownOpen(false)} />
              <div
                className="absolute bottom-full right-0 mb-1 py-1 rounded-md z-50 min-w-[200px]"
                style={{
                  backgroundColor: '#15151E',
                  border: '1px solid #2A2A3C',
                  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.6)',
                }}
              >
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
                  Ghost Mode
                </div>
                {ghostModes.map((mode) => {
                  const config = ghostModeConfig[mode];
                  const ModeIcon = config.icon;
                  return (
                    <button
                      key={mode}
                      className="w-full text-left px-3 py-2 text-[11px] transition-colors hover:bg-white/5 flex items-start gap-2"
                      onClick={() => {
                        setGhostMode(mode);
                        setGhostDropdownOpen(false);
                      }}
                    >
                      <ModeIcon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: config.color }} />
                      <div>
                        <div style={{ color: state.ghostMode === mode ? config.color : 'var(--bright-silver)' }}>
                          {config.label}
                        </div>
                        <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                          {config.description}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="w-px h-3" style={{ backgroundColor: 'var(--border-subtle)' }} />

        {/* Theme Selector */}
        <div className="relative">
          <button
            className="flex items-center gap-1.5 px-2 py-1 rounded transition-colors hover:bg-white/5"
            onClick={() => setThemeDropdownOpen(!themeDropdownOpen)}
          >
            <Palette className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
            <span>{themes[state.currentTheme].label}</span>
          </button>

          {themeDropdownOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setThemeDropdownOpen(false)} />
              <div
                className="absolute bottom-full right-0 mb-1 py-1 rounded-md z-50 min-w-[180px]"
                style={{
                  backgroundColor: '#15151E',
                  border: '1px solid #2A2A3C',
                  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.6)',
                }}
              >
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
                  Themes
                </div>
                {Object.values(themes).map((theme) => (
                  <button
                    key={theme.name}
                    className="w-full text-left px-3 py-1.5 text-[11px] transition-colors hover:bg-white/5 flex items-center gap-2"
                    onClick={() => {
                      setTheme(theme.name as ThemeName);
                      setThemeDropdownOpen(false);
                    }}
                  >
                    <div
                      className="w-3 h-3 rounded-full border"
                      style={{
                        backgroundColor: theme.colors.siren,
                        borderColor: state.currentTheme === theme.name ? 'var(--bright-silver)' : 'transparent',
                      }}
                    />
                    <span
                      style={{
                        color: state.currentTheme === theme.name ? 'var(--siren-red)' : 'var(--bright-silver)',
                      }}
                    >
                      {theme.label}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
