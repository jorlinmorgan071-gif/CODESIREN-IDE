// app/src/components/layout/SplitView.tsx
// Helper components for the three-way flexible layout in Home.tsx.
//
// SplitViewPicker: overlay that appears when the user initiates a split.
//   Lets them choose what goes in the non-chat side: Editor, Terminal,
//   Face, Dashboard, or Brain.
//
// SplitViewContent: renders the selected view in the non-chat side.

import { motion, AnimatePresence } from 'motion/react';
import { lazy, Suspense } from 'react';
import { Code, TerminalSquare, Radio, LayoutDashboard, Brain, X } from 'lucide-react';
import type { AppState } from '@/store/AppContext';

// Lazy-load the heavy views (Monaco, Three.js, etc.)
const CodeEditor = lazy(() => import('@/components/editor/CodeEditor').then((m) => ({ default: m.CodeEditor })));
const Terminal = lazy(() => import('@/components/terminal/Terminal').then((m) => ({ default: m.Terminal })));

interface ViewOption {
  id: AppState['splitView'];
  label: string;
  icon: typeof Code;
  desc: string;
}

const VIEW_OPTIONS: ViewOption[] = [
  { id: 'editor', label: 'Editor', icon: Code, desc: 'Code editor with Monaco' },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare, desc: 'Real PTY terminal' },
  { id: 'face', label: 'Face', icon: Radio, desc: 'Avatar face view' },
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, desc: 'Mission control' },
  { id: 'brain', label: 'Brain', icon: Brain, desc: 'Memory visualizer' },
];

interface SplitViewPickerProps {
  currentView: AppState['splitView'];
  onSelect: (view: AppState['splitView']) => void;
  onClose: () => void;
}

export function SplitViewPicker({ currentView, onSelect, onClose }: SplitViewPickerProps) {
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-40 flex items-center justify-center"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="rounded-xl p-4 max-w-md"
          style={{
            backgroundColor: 'var(--surface-raised)',
            border: '1px solid var(--border-subtle)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium" style={{ color: 'var(--bright-silver)' }}>
              Choose a view for the split
            </h3>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-white/5 transition-colors"
              style={{ color: 'var(--muted-silver)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {VIEW_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const isActive = currentView === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => onSelect(opt.id)}
                  className="flex items-center gap-2 p-3 rounded-lg text-left transition-colors hover:bg-white/5"
                  style={{
                    backgroundColor: isActive ? 'rgba(238, 28, 28, 0.1)' : 'transparent',
                    border: isActive ? '1px solid rgba(238, 28, 28, 0.3)' : '1px solid var(--border-subtle)',
                  }}
                >
                  <Icon
                    className="w-4 h-4 flex-shrink-0"
                    style={{ color: isActive ? 'var(--siren-red)' : 'var(--steel-silver)' }}
                  />
                  <div className="flex flex-col min-w-0">
                    <span
                      className="text-[11px] font-medium"
                      style={{ color: isActive ? 'var(--siren-red)' : 'var(--bright-silver)' }}
                    >
                      {opt.label}
                    </span>
                    <span className="text-[9px] truncate" style={{ color: 'var(--muted-silver)' }}>
                      {opt.desc}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

interface SplitViewContentProps {
  view: AppState['splitView'];
  bottomPanelVisible: boolean;
}

export function SplitViewContent({ view, bottomPanelVisible }: SplitViewContentProps) {
  switch (view) {
    case 'editor':
      return (
        <div className="h-full flex flex-col overflow-hidden">
          <Suspense fallback={<div className="flex-1" style={{ backgroundColor: 'var(--void-black)' }} />}>
            <CodeEditor />
          </Suspense>
          {bottomPanelVisible && (
            <Suspense fallback={null}>
              <Terminal />
            </Suspense>
          )}
        </div>
      );

    case 'terminal':
      return (
        <div className="h-full overflow-hidden">
          <Suspense fallback={null}>
            <Terminal />
          </Suspense>
        </div>
      );

    case 'face':
      // Face view is a separate route — show a placeholder with a link
      return (
        <div className="h-full flex items-center justify-center" style={{ backgroundColor: 'var(--void-black)' }}>
          <div className="text-center">
            <Radio className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--muted-silver)' }} />
            <p className="text-[11px]" style={{ color: 'var(--muted-silver)' }}>
              Face view — open in full screen via the Dock
            </p>
          </div>
        </div>
      );

    case 'dashboard':
      return (
        <div className="h-full flex items-center justify-center" style={{ backgroundColor: 'var(--void-black)' }}>
          <div className="text-center">
            <LayoutDashboard className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--muted-silver)' }} />
            <p className="text-[11px]" style={{ color: 'var(--muted-silver)' }}>
              Dashboard — open in full screen via the Dock
            </p>
          </div>
        </div>
      );

    case 'brain':
      return (
        <div className="h-full flex items-center justify-center" style={{ backgroundColor: 'var(--void-black)' }}>
          <div className="text-center">
            <Brain className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--muted-silver)' }} />
            <p className="text-[11px]" style={{ color: 'var(--muted-silver)' }}>
              Brain visualizer — open in full screen via the Dock
            </p>
          </div>
        </div>
      );

    default:
      return null;
  }
}
