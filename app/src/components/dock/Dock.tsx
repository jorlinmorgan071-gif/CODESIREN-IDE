// app/src/components/dock/Dock.tsx
// Section 5 — Dock: floating glass pill container, per-item hover lift,
// tooltip-on-hover, and reflection/mirror effect beneath.
// All colors theme-token driven so the dock visibly changes with every theme switch.

import { useState } from 'react';
import { motion } from 'motion/react';
import {
  MessageSquare, Code, TerminalSquare, Bot, LayoutDashboard, Settings, Brain, Radio,
} from 'lucide-react';
import { PremiumTooltip } from '@/components/ui/premium-tooltip';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useRelay } from '@/store/RelayContext';

export type DockItem = {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  onClick: () => void;
  active?: boolean;
};

interface DockProps {
  onNavigate: (target: string) => void;
  activeView?: string;
}

export function Dock({ onNavigate, activeView }: DockProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { isActive: voiceActive } = useVoiceSession();
  // Agent Relay — directive Section 2.3: show a pulsing badge on the Editor
  // dock item with the current milestone number (e.g. "M03/08") while a
  // relay is running.
  const relay = useRelay();
  const relayActive = relay.status === 'running' || relay.status === 'awaiting-user';
  const relayBadge = relayActive && relay.activePlanId
    ? `${relay.completedMilestones + 1}/${relay.totalMilestones}`
    : null;

  const items: DockItem[] = [
    { id: 'chat', label: 'Chat', icon: MessageSquare, onClick: () => onNavigate('chat') },
    { id: 'editor', label: 'Editor', icon: Code, onClick: () => onNavigate('editor') },
    { id: 'terminal', label: 'Terminal', icon: TerminalSquare, onClick: () => onNavigate('terminal') },
    { id: 'agents', label: 'Agents', icon: Bot, onClick: () => onNavigate('agents') },
    { id: 'brain', label: 'Brain', icon: Brain, onClick: () => onNavigate('brain') },
    { id: 'face', label: 'Face', icon: Radio, onClick: () => onNavigate('face') },
    { id: 'dashboard', label: 'Mission Control', icon: LayoutDashboard, onClick: () => onNavigate('dashboard') },
    { id: 'settings', label: 'Settings', icon: Settings, onClick: () => onNavigate('settings') },
  ];

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center">
      {/* Persistent mic-status indicator (Section 6) — visible regardless of which tab is open */}
      {voiceActive && (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full mb-1.5"
          style={{
            backgroundColor: 'rgba(238, 28, 28, 0.15)',
            border: '1px solid rgba(238, 28, 28, 0.3)',
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ backgroundColor: 'var(--siren-red)' }}
          />
          <span className="text-[9px] font-medium" style={{ color: 'var(--siren-red)' }}>
            VOICE SESSION LIVE
          </span>
        </div>
      )}

      {/* Dock pill */}
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3, type: 'spring', stiffness: 300, damping: 25 }}
        className="dock-glass rounded-2xl px-3 py-2 flex items-center gap-1"
      >
        {items.map((item) => {
          const Icon = item.icon;
          const isHovered = hoveredId === item.id;
          const isActive = activeView === item.id;

          return (
            <PremiumTooltip key={item.id} text={item.label} position="top" delay={false}>
              <motion.button
                onClick={item.onClick}
                onHoverStart={() => setHoveredId(item.id)}
                onHoverEnd={() => setHoveredId(null)}
                whileHover={{ scale: 1.2, y: -6 }}
                whileTap={{ scale: 1.1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                // Bug E fix — INSTANT background-color transition (duration-75)
                // gives immediate visual feedback the moment the cursor enters,
                // BEFORE the motion.spring scale animation catches up. The
                // spring (stiffness:400, damping:20) takes ~150-250ms to
                // visibly move; the bg-color change happens in <75ms so the
                // user sees an instant response. Background color is driven
                // by isHovered state (set via onHoverStart/onHoverEnd), NOT by
                // the active state — active state has its own subtler bg.
                className="relative w-10 h-10 rounded-xl flex items-center justify-center transition-colors duration-75"
                style={{
                  backgroundColor: isActive
                    ? 'rgba(238, 28, 28, 0.12)'
                    : isHovered
                      ? 'rgba(238, 28, 28, 0.08)'
                      : 'transparent',
                }}
              >
                {/* Active indicator dot */}
                {isActive && (
                  <div
                    className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
                    style={{ backgroundColor: 'var(--siren-red)' }}
                  />
                )}
                <Icon
                  className="w-5 h-5"
                  style={{
                    color: isActive ? 'var(--siren-red)' : isHovered ? 'var(--bright-silver)' : 'var(--steel-silver)',
                  }}
                />
                {/* Agent Relay badge — directive Section 2.3. Pulsing red badge
                    on the Editor dock item showing current milestone / total. */}
                {item.id === 'editor' && relayBadge && (
                  <div
                    className="absolute -top-1 -right-1 px-1.5 py-0.5 rounded-full text-[8px] font-bold leading-none animate-agent-pulse"
                    style={{
                      backgroundColor: 'var(--siren-red)',
                      color: 'white',
                      boxShadow: '0 0 8px rgba(238, 28, 28, 0.6)',
                      minWidth: '20px',
                      textAlign: 'center',
                    }}
                  >
                    {relayBadge}
                  </div>
                )}
              </motion.button>
            </PremiumTooltip>
          );
        })}
      </motion.div>

      {/* Reflection/mirror effect beneath dock */}
      <div
        className="dock-reflection rounded-2xl mt-0.5"
        style={{ width: 280, height: 24 }}
      />
    </div>
  );
}
