// app/src/components/sidebar/Sidebar.tsx
// Section 10 — Sidebar: collapse/expand, chat history with search,
// discover news feed (card-stack), images gallery, artifacts, recent chats,
// projects, settings. Single clickable logo toggles between icon rail and expanded panel.
// All colors theme-token driven.

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Search, Plus, ChevronLeft, Pin, Trash2, Edit3, FolderPlus,
  Image as ImageIcon, FileText, Newspaper, Clock, Folder, Settings as SettingsIcon,
  MessageSquare, X, Download, Sparkles, Hammer,
} from 'lucide-react';
import { useApp } from '@/store/AppContext';
import { useRelay } from '@/store/RelayContext';
import { CardStack, type CardStackItem } from '@/components/ui/card-stack';

// ── Types ────────────────────────────────────────────────────────────────

type SidebarSection = 'main' | 'history' | 'discover' | 'images' | 'artifacts' | 'recent' | 'projects' | 'settings' | 'builds';

interface SidebarProps {
  expanded: boolean;
  onToggle: () => void;
  onNavigate: (target: string) => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onSelectChat: (chatId: string) => void;
}

// ── Placeholder news data for Discover ───────────────────────────────────

const DISCOVER_ITEMS: CardStackItem[] = [
  { id: 1, title: 'AI Models Get Smaller, Faster', description: 'New quantization techniques cut model size by 80% with minimal quality loss.', tag: 'AI' },
  { id: 2, title: 'The Rise of Local-First AI', description: 'Why running models on your own hardware is making a comeback.', tag: 'Tech' },
  { id: 3, title: 'Code Generation Reaches New Milestone', description: 'Latest benchmarks show AI matching senior devs on real-world tasks.', tag: 'Dev' },
  { id: 4, title: 'Open Source LLMs Close the Gap', description: 'Community models now compete with proprietary giants on key metrics.', tag: 'Open Source' },
  { id: 5, title: 'The Future of IDEs', description: 'How AI-native editors are reshaping the developer experience.', tag: 'Dev Tools' },
];

// ── Main Sidebar component ───────────────────────────────────────────────

export function Sidebar({ expanded, onToggle, onNavigate, onOpenSettings, onNewChat, onSelectChat }: SidebarProps) {
  const { state } = useApp();
  const relay = useRelay();
  const [section, setSection] = useState<SidebarSection>('main');
  const [searchQuery, setSearchQuery] = useState('');
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);

  // Filtered chat sessions for history search
  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) return state.chatSessions;
    return state.chatSessions.filter(c =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [state.chatSessions, searchQuery]);

  // Recent chats — compact, max 5
  const recentChats = state.chatSessions.slice(0, 5);

  // ── Collapsed state: icon rail ────────────────────────────────────────
  if (!expanded) {
    return (
      <div
        className="w-12 flex flex-col items-center py-3 gap-2 shrink-0"
        style={{
          backgroundColor: 'var(--surface-dark)',
          borderRight: '1px solid var(--border-subtle)',
        }}
      >
        {/* Logo toggle — expands the sidebar */}
        <button
          onClick={onToggle}
          className="w-8 h-8 rounded flex items-center justify-center transition-all hover:scale-110"
          style={{ backgroundColor: 'var(--siren-red)' }}
          title="Expand sidebar"
        >
          <span className="text-white text-[10px] font-bold font-display">ZT</span>
        </button>

        <div className="w-6 h-px my-1" style={{ backgroundColor: 'var(--border-subtle)' }} />

        {/* Quick nav icons */}
        {[
          { icon: MessageSquare, label: 'Chat', action: () => onNavigate('chat') },
          { icon: Newspaper, label: 'Discover', action: () => { onToggle(); setSection('discover'); } },
          { icon: ImageIcon, label: 'Images', action: () => { onToggle(); setSection('images'); } },
          { icon: FileText, label: 'Artifacts', action: () => { onToggle(); setSection('artifacts'); } },
          { icon: Clock, label: 'Recent', action: () => { onToggle(); setSection('recent'); } },
          { icon: Folder, label: 'Projects', action: () => { onToggle(); setSection('projects'); } },
          { icon: SettingsIcon, label: 'Settings', action: onOpenSettings },
        ].map((item, i) => {
          const Icon = item.icon;
          return (
            <button
              key={i}
              onClick={item.action}
              className="w-8 h-8 flex items-center justify-center rounded-md transition-all hover:bg-white/5"
              style={{ color: 'var(--steel-silver)' }}
              title={item.label}
            >
              <Icon className="w-[18px] h-[18px]" />
            </button>
          );
        })}
      </div>
    );
  }

  // ── Expanded state: full panel ────────────────────────────────────────
  return (
    <>
      <motion.div
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: 280, opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="flex flex-col shrink-0 overflow-hidden"
        style={{
          backgroundColor: 'var(--surface-dark)',
          borderRight: '1px solid var(--border-subtle)',
        }}
      >
        {/* Header — logo toggle (collapses sidebar) + wordmark */}
        <div className="flex items-center gap-2 px-3 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <button
            onClick={onToggle}
            className="w-6 h-6 rounded flex items-center justify-center transition-all hover:scale-110 shrink-0"
            style={{ backgroundColor: 'var(--siren-red)' }}
            title="Collapse sidebar"
          >
            <span className="text-white text-[9px] font-bold font-display">ZT</span>
          </button>
          {section === 'main' && (
            <span className="text-xs font-medium" style={{ color: 'var(--bright-silver)' }}>
              Code Siren
            </span>
          )}
          {section !== 'main' && (
            <button
              onClick={() => setSection('main')}
              className="flex items-center gap-1 text-[11px] transition-colors"
              style={{ color: 'var(--steel-silver)' }}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Back
            </button>
          )}
        </div>

        {/* Section content */}
        <div className="flex-1 overflow-y-auto p-3">

          {/* ── Main section ─────────────────────────────────────────── */}
          {section === 'main' && (
            <div className="space-y-1">
              {/* New chat */}
              <button
                onClick={onNewChat}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-[12px] transition-colors hover:bg-[var(--surface-raised)]"
                style={{ color: 'var(--bright-silver)', border: '1px solid var(--border-subtle)' }}
              >
                <Plus className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
                New Chat
              </button>

              <div className="h-px my-2" style={{ backgroundColor: 'var(--border-subtle)' }} />

              {/* Section links */}
              {[
                { icon: MessageSquare, label: 'Chat History', section: 'history' as SidebarSection },
                { icon: Newspaper, label: 'Discover', section: 'discover' as SidebarSection },
                { icon: ImageIcon, label: 'Images', section: 'images' as SidebarSection },
                { icon: FileText, label: 'Artifacts', section: 'artifacts' as SidebarSection },
                { icon: Clock, label: 'Recent Chats', section: 'recent' as SidebarSection },
                { icon: Folder, label: 'Projects', section: 'projects' as SidebarSection },
                { icon: Hammer, label: 'Builds', section: 'builds' as SidebarSection, badge: relay.plans.filter(p => p.status === 'running' || p.status === 'awaiting-user').length },
                { icon: SettingsIcon, label: 'Settings', action: onOpenSettings },
              ].map((item, i) => {
                const Icon = item.icon;
                const itemBadge = (item as { badge?: number }).badge;
                return (
                  <button
                    key={i}
                    onClick={() => item.action ? item.action() : setSection(item.section!)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] transition-colors hover:bg-[var(--surface-raised)]"
                    style={{ color: 'var(--steel-silver)' }}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="flex-1 text-left">{item.label}</span>
                    {itemBadge && itemBadge > 0 ? (
                      <span
                        className="px-1.5 py-0.5 rounded-full text-[9px] font-bold leading-none"
                        style={{
                          backgroundColor: 'rgba(238, 28, 28, 0.15)',
                          color: 'var(--siren-red)',
                        }}
                      >
                        {itemBadge}
                      </span>
                    ) : null}
                  </button>
                );
              })}

              {/* Recent chats preview (compact 3) */}
              <div className="h-px my-2" style={{ backgroundColor: 'var(--border-subtle)' }} />
              <div className="text-[10px] uppercase tracking-wider px-3 mb-1" style={{ color: 'var(--muted-silver)' }}>
                Recent
              </div>
              {recentChats.slice(0, 3).map(chat => (
                <button
                  key={chat.id}
                  onClick={() => onSelectChat(chat.id)}
                  className="w-full text-left px-3 py-1.5 rounded-md text-[11px] truncate transition-colors hover:bg-[var(--surface-raised)]"
                  style={{ color: 'var(--steel-silver)' }}
                >
                  {chat.name}
                </button>
              ))}
            </div>
          )}

          {/* ── Chat History section ─────────────────────────────────── */}
          {section === 'history' && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                Chat History
              </div>
              {/* Search bar */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--muted-silver)' }} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search chats…"
                  className="w-full pl-8 pr-3 py-1.5 rounded-md text-[12px] zt-input"
                />
              </div>
              {/* Chat list */}
              <div className="space-y-0.5">
                {filteredChats.map(chat => (
                  <div
                    key={chat.id}
                    className="group flex items-center gap-2 px-2.5 py-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)] cursor-pointer"
                    onClick={() => onSelectChat(chat.id)}
                  >
                    <MessageSquare className="w-3 h-3 shrink-0" style={{ color: 'var(--muted-silver)' }} />
                    <span className="flex-1 text-[11px] truncate" style={{ color: 'var(--steel-silver)' }}>
                      {chat.name}
                    </span>
                    {/* Per-chat actions (show on hover) */}
                    <div className="hidden group-hover:flex items-center gap-0.5">
                      <button onClick={(e) => { e.stopPropagation(); }} className="p-0.5 rounded hover:bg-[var(--surface-dark)]" title="Pin"><Pin className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} /></button>
                      <button onClick={(e) => { e.stopPropagation(); }} className="p-0.5 rounded hover:bg-[var(--surface-dark)]" title="Rename"><Edit3 className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} /></button>
                      <button onClick={(e) => { e.stopPropagation(); }} className="p-0.5 rounded hover:bg-[var(--surface-dark)]" title="Add to project"><FolderPlus className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} /></button>
                      <button onClick={(e) => { e.stopPropagation(); }} className="p-0.5 rounded hover:bg-[var(--surface-dark)]" title="Delete"><Trash2 className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} /></button>
                    </div>
                  </div>
                ))}
                {filteredChats.length === 0 && (
                  <div className="text-[11px] text-center py-4" style={{ color: 'var(--muted-silver)' }}>
                    No chats found
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Discover section (card-stack news feed) ──────────────── */}
          {section === 'discover' && (
            <div className="overflow-hidden">
              <div className="text-[11px] font-semibold mb-3" style={{ color: 'var(--bright-silver)' }}>
                Discover
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
                <CardStack
                  items={DISCOVER_ITEMS}
                  cardWidth={220}
                  cardHeight={160}
                  autoAdvance
                  intervalMs={4000}
                  pauseOnHover
                  showDots
                />
              </div>
            </div>
          )}

          {/* ── Images section ───────────────────────────────────────── */}
          {section === 'images' && (
            <div>
              <div className="text-[11px] font-semibold mb-3" style={{ color: 'var(--bright-silver)' }}>
                Images
              </div>
              <div className="text-[10px] mb-2" style={{ color: 'var(--muted-silver)' }}>
                Double-click to open fullscreen
              </div>
              {/* Empty state — no AI-generated images yet */}
              <div className="flex flex-col items-center justify-center py-12">
                <ImageIcon className="w-8 h-8 mb-2" style={{ color: 'var(--muted-silver)' }} />
                <span className="text-[11px]" style={{ color: 'var(--muted-silver)' }}>
                  No images generated yet
                </span>
              </div>
            </div>
          )}

          {/* ── Artifacts section ────────────────────────────────────── */}
          {section === 'artifacts' && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                Artifacts
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--muted-silver)' }} />
                <input
                  type="text"
                  placeholder="Search files…"
                  className="w-full pl-8 pr-3 py-1.5 rounded-md text-[12px] zt-input"
                />
              </div>
              <div className="space-y-0.5">
                {state.editorTabs.map(tab => (
                  <div
                    key={tab.fileId}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)] cursor-pointer"
                  >
                    <FileText className="w-3 h-3 shrink-0" style={{ color: 'var(--muted-silver)' }} />
                    <span className="flex-1 text-[11px] truncate" style={{ color: 'var(--steel-silver)' }}>
                      {tab.fileName}
                    </span>
                  </div>
                ))}
                {state.editorTabs.length === 0 && (
                  <div className="text-[11px] text-center py-4" style={{ color: 'var(--muted-silver)' }}>
                    No files attached yet
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Recent chats (compact, no search) ────────────────────── */}
          {section === 'recent' && (
            <div className="space-y-1">
              <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--bright-silver)' }}>
                Recent Chats
              </div>
              {recentChats.map(chat => (
                <button
                  key={chat.id}
                  onClick={() => onSelectChat(chat.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11px] transition-colors hover:bg-[var(--surface-raised)]"
                  style={{ color: 'var(--steel-silver)' }}
                >
                  <Clock className="w-3 h-3 shrink-0" style={{ color: 'var(--muted-silver)' }} />
                  <span className="flex-1 truncate">{chat.name}</span>
                </button>
              ))}
              {recentChats.length === 0 && (
                <div className="text-[11px] text-center py-4" style={{ color: 'var(--muted-silver)' }}>
                  No recent chats
                </div>
              )}
            </div>
          )}

          {/* ── Projects section ─────────────────────────────────────── */}
          {section === 'projects' && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                Projects
              </div>
              <button
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-[12px] transition-colors hover:bg-[var(--surface-raised)]"
                style={{ color: 'var(--bright-silver)', border: '1px solid var(--border-subtle)' }}
              >
                <Plus className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
                New Project World
              </button>
              <div className="text-[11px] text-center py-4" style={{ color: 'var(--muted-silver)' }}>
                No projects created yet
              </div>
            </div>
          )}

          {/* Builds section — directive Section 2.4. Lists completed and
              in-progress relay plans. Clicking one opens the Plan Review
              panel which shows the full milestone-by-milestone report. */}
          {section === 'builds' && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                Builds
              </div>
              <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                Agent Relay execution history
              </div>
              <div className="h-px my-2" style={{ backgroundColor: 'var(--border-subtle)' }} />
              {relay.plans.length === 0 ? (
                <div className="text-[11px] text-center py-6" style={{ color: 'var(--muted-silver)' }}>
                  No builds yet.
                  <br />
                  Press <span style={{ color: 'var(--siren-red)' }}>Start Project</span> in the chat to begin.
                </div>
              ) : (
                relay.plans.map((plan) => {
                  const statusColor =
                    plan.status === 'running' ? '#22C55E' :
                    plan.status === 'awaiting-user' ? '#F59E0B' :
                    plan.status === 'completed' ? '#22C55E' :
                    plan.status === 'failed' ? '#EE1C1C' :
                    plan.status === 'stopped' ? '#8A8AA0' :
                    plan.status === 'paused' ? '#F59E0B' :
                    '#8A8AA0';
                  return (
                    <button
                      key={plan.id}
                      onClick={() => relay.openPlanReview(plan.id)}
                      className="w-full text-left p-2.5 rounded-md transition-colors hover:bg-[var(--surface-raised)]"
                      style={{ border: '1px solid var(--border-subtle)' }}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <div
                          className={`w-1.5 h-1.5 rounded-full ${plan.status === 'running' ? 'animate-agent-pulse' : ''}`}
                          style={{ backgroundColor: statusColor }}
                        />
                        <span className="text-[12px] font-medium truncate flex-1" style={{ color: 'var(--bright-silver)' }}>
                          {plan.projectName}
                        </span>
                      </div>
                      <div className="text-[10px] truncate mb-1" style={{ color: 'var(--steel-silver)' }}>
                        {plan.summary}
                      </div>
                      <div className="flex items-center justify-between text-[9px]" style={{ color: 'var(--muted-silver)' }}>
                        <span style={{ color: statusColor }}>{plan.status}</span>
                        <span>{plan.milestoneCount} milestones</span>
                        <span>{new Date(plan.createdAt).toLocaleDateString()}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      </motion.div>

      {/* Fullscreen image viewer (double-click to open) */}
      <AnimatePresence>
        {fullscreenImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.9)' }}
            onClick={() => setFullscreenImage(null)}
          >
            <button
              className="absolute top-4 right-4 p-2 rounded-full transition-colors hover:bg-white/10"
              style={{ color: 'var(--steel-silver)' }}
            >
              <X className="w-5 h-5" />
            </button>
            <img src={fullscreenImage} alt="Fullscreen" className="max-w-[90vw] max-h-[90vh] rounded-lg" />
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px]" style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--bright-silver)', border: '1px solid var(--border-subtle)' }}>
                <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
                Edit with AI
              </button>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px]" style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--bright-silver)', border: '1px solid var(--border-subtle)' }}>
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
