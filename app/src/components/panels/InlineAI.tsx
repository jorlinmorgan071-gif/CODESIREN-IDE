import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '@/store/AppContext';
import { motion } from 'motion/react';
import {
  X,
  Move,
  Sparkles,
  RefreshCw,
  Gauge,
  FileCode,
  FileText,
  Languages,
  TestTube,
  Wand2,
} from 'lucide-react';

const quickActions = [
  { id: 'explain', label: 'Explain', icon: FileText, description: 'Explain this code' },
  { id: 'refactor', label: 'Refactor', icon: RefreshCw, description: 'Refactor for clarity' },
  { id: 'optimize', label: 'Optimize', icon: Gauge, description: 'Optimize performance' },
  { id: 'test', label: 'Generate Tests', icon: TestTube, description: 'Create unit tests' },
  { id: 'document', label: 'Document', icon: FileCode, description: 'Add documentation' },
  { id: 'convert', label: 'Convert', icon: Languages, description: 'Convert language' },
];

export function InlineAI() {
  const { state, toggleInlineAI, setInlineAIPosition } = useApp();
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.inline-action-btn')) return;
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - state.inlineAIPosition.x,
      y: e.clientY - state.inlineAIPosition.y,
    });
  }, [state.inlineAIPosition]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      setInlineAIPosition({
        x: e.clientX - dragOffset.x,
        y: e.clientY - dragOffset.y,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset, setInlineAIPosition]);

  const handleAction = (actionId: string) => {
    setActiveAction(actionId);
    setResponse(null);

    // Simulate AI response
    setTimeout(() => {
      const responses: Record<string, string> = {
        explain: 'This code defines a React functional component that renders a responsive navigation header. It uses useState to manage the mobile menu open/closed state, and conditionally renders the mobile navigation based on the isMenuOpen boolean.',
        refactor: 'I would extract the mobile menu into a separate component, use a custom hook for the menu state, and add proper TypeScript interfaces for the navigation items.',
        optimize: 'Consider memoizing the Header component with React.memo, using useCallback for the toggle handler, and implementing lazy loading for the mobile menu content.',
        test: 'I\'ll generate tests covering: rendering with title prop, mobile menu toggle functionality, accessibility attributes, and responsive behavior across breakpoints.',
        document: 'Adding JSDoc comments, describing props with @param tags, documenting the component\'s behavior, and including usage examples.',
        convert: 'I can convert this to a class component, or translate it to Vue SFC format. Which would you prefer?',
      };
      setResponse(responses[actionId] || 'Processing your request...');
      setActiveAction(null);
    }, 800);
  };

  if (!state.inlineAIVisible) return null;

  // Bug C fix: render via portal to document.body so the panel's
  // position:fixed escapes any ancestor with transform/filter/will-change
  // (motion.div animations, Dock springs, etc.) that would otherwise
  // contain the fixed positioning and cause the panel to render relative
  // to that ancestor instead of the viewport. The portal guarantees the
  // panel is always positioned relative to the viewport, regardless of
  // where <InlineAI /> is mounted in the React tree.
  return createPortal(
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className="fixed z-50 w-[280px] rounded-lg overflow-hidden"
      style={{
        left: state.inlineAIPosition.x,
        top: state.inlineAIPosition.y,
        backgroundColor: '#15151E',
        border: '1px solid #2A2A3C',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6), 0 0 1px rgba(200, 200, 220, 0.1)',
        cursor: isDragging ? 'grabbing' : 'default',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{
          backgroundColor: 'rgba(238, 28, 28, 0.08)',
          borderBottom: '1px solid var(--border-subtle)',
          cursor: 'grab',
        }}
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <Move className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} />
          <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
            Ariadne
          </span>
        </div>
        <button
          className="p-1 rounded transition-colors hover:bg-white/10"
          onClick={toggleInlineAI}
          style={{ color: 'var(--muted-silver)' }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Quick Actions Grid */}
      {!response && (
        <div className="p-3 grid grid-cols-2 gap-1.5">
          {quickActions.map((action) => {
            const Icon = action.icon;
            const isActive = activeAction === action.id;

            return (
              <button
                key={action.id}
                className="inline-action-btn flex items-center gap-2 px-2.5 py-2 rounded-md text-[11px] transition-all hover:bg-white/5 text-left"
                style={{
                  backgroundColor: isActive ? 'rgba(238, 28, 28, 0.1)' : 'transparent',
                  color: isActive ? 'var(--siren-red)' : 'var(--bright-silver)',
                  border: isActive ? '1px solid rgba(238, 28, 28, 0.3)' : '1px solid transparent',
                }}
                onClick={() => handleAction(action.id)}
                disabled={!!activeAction}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: isActive ? 'var(--siren-red)' : 'var(--steel-silver)' }} />
                <div className="min-w-0">
                  <div className="font-medium">{action.label}</div>
                  <div className="text-[9px] truncate" style={{ color: 'var(--muted-silver)' }}>
                    {action.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Loading state */}
      {activeAction && (
        <div className="p-4 flex items-center gap-2">
          <div className="w-4 h-4 rounded-full animate-agent-pulse" style={{ backgroundColor: 'var(--siren-red)' }} />
          <span className="text-[12px] animate-pulse" style={{ color: 'var(--steel-silver)' }}>
            Processing...
          </span>
        </div>
      )}

      {/* Response */}
      {response && (
        <div className="p-3">
          <div
            className="text-[12px] leading-relaxed p-2.5 rounded-md"
            style={{
              backgroundColor: 'rgba(238, 28, 28, 0.05)',
              borderLeft: '2px solid var(--siren-red)',
              color: 'var(--bright-silver)',
            }}
          >
            {response}
          </div>
          <button
            className="mt-2 text-[11px] px-3 py-1.5 rounded-md transition-colors hover:bg-white/5 flex items-center gap-1"
            style={{ color: 'var(--siren-red)' }}
            onClick={() => setResponse(null)}
          >
            <Wand2 className="w-3 h-3" />
            New Action
          </button>
        </div>
      )}

      {/* Attachments area */}
      <div
        className="px-3 py-2 flex items-center gap-2"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
          Attachments
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--surface-dark)', color: 'var(--steel-silver)' }}>
          Header.tsx
        </span>
      </div>
    </motion.div>,
    document.body,
  );
}
