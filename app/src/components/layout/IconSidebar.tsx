import type { LucideIcon } from "lucide-react";
import { useApp } from '@/store/AppContext';
import type { SidebarTab } from '@/types';
import {
  FolderOpen,
  Search,
  GitBranch,
  Bot,
  Puzzle,
  Settings,
  PanelLeft,
  MessageSquare,
} from 'lucide-react';

const sidebarItems: { id: SidebarTab; icon: LucideIcon; label: string }[] = [
  { id: 'explorer', icon: FolderOpen, label: 'Explorer' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'git', icon: GitBranch, label: 'Source Control' },
  { id: 'agents', icon: Bot, label: 'Agents' },
  { id: 'extensions', icon: Puzzle, label: 'Extensions' },
  { id: 'settings', icon: Settings, label: 'Settings' },
];

export function IconSidebar() {
  const { state, dispatch, toggleAgentPanel, toggleSettings } = useApp();

  const handleTabClick = (tab: SidebarTab) => {
    if (tab === 'agents') {
      toggleAgentPanel();
      return;
    }
    if (tab === 'settings') {
      toggleSettings();
      return;
    }
    dispatch({ type: 'SET_SIDEBAR_TAB', payload: tab });
    if (!state.explorerVisible) {
      dispatch({ type: 'TOGGLE_EXPLORER' });
    }
  };

  return (
    <div
      className="w-11 flex flex-col items-center py-2 gap-1"
      style={{
        backgroundColor: 'var(--surface-dark)',
        borderRight: '1px solid var(--border-subtle)',
      }}
    >
      {sidebarItems.map((item) => {
        const Icon = item.icon;
        const isActive = state.activeSidebarTab === item.id && item.id !== 'agents' && item.id !== 'settings';
        const isAgentsActive = item.id === 'agents' && state.agentPanelVisible;
        const isSettingsActive = item.id === 'settings' && state.settingsVisible;
        const active = isActive || isAgentsActive || isSettingsActive;

        return (
          <button
            key={item.id}
            className="relative w-8 h-8 flex items-center justify-center rounded-md transition-all duration-150 group"
            style={{
              backgroundColor: active ? 'rgba(238, 28, 28, 0.12)' : 'transparent',
              color: active ? 'var(--siren-red)' : 'var(--steel-silver)',
            }}
            onClick={() => handleTabClick(item.id)}
            title={item.label}
          >
            {active && (
              <div
                className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-r-full"
                style={{ backgroundColor: 'var(--siren-red)' }}
              />
            )}
            <Icon className="w-[18px] h-[18px]" />
            {/* Tooltip */}
            <div
              className="absolute left-full ml-2 px-2 py-1 rounded text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50"
              style={{
                backgroundColor: '#15151E',
                border: '1px solid #2A2A3C',
                color: 'var(--bright-silver)',
              }}
            >
              {item.label}
            </div>
          </button>
        );
      })}

      <div className="flex-1" />

      {/* Toggle explorer panel */}
      <button
        className="w-8 h-8 flex items-center justify-center rounded-md transition-all duration-150 mb-1"
        style={{
          backgroundColor: state.explorerVisible ? 'rgba(238, 28, 28, 0.08)' : 'transparent',
          color: state.explorerVisible ? 'var(--siren-red)' : 'var(--steel-silver)',
        }}
        onClick={() => dispatch({ type: 'TOGGLE_EXPLORER' })}
        title="Toggle Explorer"
      >
        <PanelLeft className="w-[18px] h-[18px]" />
      </button>

      {/* Toggle chat panel */}
      <button
        className="w-8 h-8 flex items-center justify-center rounded-md transition-all duration-150"
        style={{
          backgroundColor: state.chatPanelVisible ? 'rgba(238, 28, 28, 0.08)' : 'transparent',
          color: state.chatPanelVisible ? 'var(--siren-red)' : 'var(--steel-silver)',
        }}
        onClick={() => dispatch({ type: 'TOGGLE_CHAT_PANEL' })}
        title="Toggle Chat"
      >
        <MessageSquare className="w-[18px] h-[18px]" />
      </button>
    </div>
  );
}
