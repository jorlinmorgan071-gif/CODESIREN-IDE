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
  Loader2,
} from 'lucide-react';
import { getToken } from '@/lib/auth';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

// Phase B: Editor Actions — only 'explain' is functional.
// The other 5 are honestly marked "coming soon" — NOT silently faking it.
const quickActions = [
  { id: 'explain', label: 'Explain', icon: FileText, description: 'Explain this code', available: true },
  { id: 'refactor', label: 'Refactor', icon: RefreshCw, description: 'Refactor for clarity', available: false },
  { id: 'optimize', label: 'Optimize', icon: Gauge, description: 'Optimize performance', available: false },
  { id: 'test', label: 'Generate Tests', icon: TestTube, description: 'Create unit tests', available: false },
  { id: 'document', label: 'Document', icon: FileCode, description: 'Add documentation', available: false },
  { id: 'convert', label: 'Convert', icon: Languages, description: 'Convert language', available: false },
];

export function InlineAI() {
  const { state, toggleInlineAI, setInlineAIPosition } = useApp();
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Phase B: Listen for 'code-siren:explain' custom events from Monaco's
  // context menu action. When fired, automatically trigger the Explain flow
  // with the selected code.
  useEffect(() => {
    const handleExplainRequest = (e: Event) => {
      const detail = (e as CustomEvent).detail as { code: string; language?: string };
      if (detail?.code) {
        void runExplain(detail.code, detail.language);
      }
    };
    window.addEventListener('code-siren:explain', handleExplainRequest);
    return () => window.removeEventListener('code-siren:explain', handleExplainRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runExplain = useCallback(async (code: string, language?: string) => {
    setActiveAction('explain');
    setResponse(null);
    setError(null);

    try {
      const token = getToken() ?? '';
      const res = await fetch(`${API_BASE}/orchestrator/explain`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code, language }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Request failed' })) as { error: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as { explanation: string };
      setResponse(data.explanation || '(no explanation returned)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setActiveAction(null);
    }
  }, []);

  const handleAction = (actionId: string) => {
    if (actionId === 'explain') {
      // For the Explain button click (without a selection from the editor),
      // we need the selected text. We dispatch a request to the editor to
      // send us its selection via the same custom event mechanism.
      // The editor listens for this and fires back 'code-siren:explain'.
      window.dispatchEvent(new CustomEvent('code-siren:request-selection'));
      return;
    }
    // Other actions are not yet functional — don't fake it
  };

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

  if (!state.inlineAIVisible) return null;

  return createPortal(
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className="fixed z-50 w-[320px] rounded-lg overflow-hidden"
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
      {!response && !error && !activeAction && (
        <div className="p-3 grid grid-cols-2 gap-1.5">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                className="inline-action-btn flex items-center gap-2 px-2.5 py-2 rounded-md text-[11px] transition-all hover:bg-white/5 text-left"
                style={{
                  color: action.available ? 'var(--bright-silver)' : 'var(--muted-silver)',
                  border: '1px solid transparent',
                  opacity: action.available ? 1 : 0.5,
                  cursor: action.available ? 'pointer' : 'not-allowed',
                }}
                onClick={() => action.available && handleAction(action.id)}
                disabled={!action.available}
                title={action.available ? action.description : 'Coming soon — not yet functional'}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: action.available ? 'var(--steel-silver)' : 'var(--muted-silver)' }} />
                <div className="min-w-0">
                  <div className="font-medium">
                    {action.label}
                    {!action.available && <span className="text-[8px] ml-1" style={{ color: 'var(--muted-silver)' }}>soon</span>}
                  </div>
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
      {activeAction === 'explain' && (
        <div className="p-4 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[12px]" style={{ color: 'var(--steel-silver)' }}>
            Explaining code...
          </span>
        </div>
      )}

      {/* Response */}
      {response && (
        <div className="p-3">
          <div
            className="text-[12px] leading-relaxed p-2.5 rounded-md whitespace-pre-wrap"
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

      {/* Error */}
      {error && (
        <div className="p-3">
          <div
            className="text-[12px] p-2.5 rounded-md"
            style={{
              backgroundColor: 'rgba(238, 28, 28, 0.1)',
              border: '1px solid rgba(238, 28, 28, 0.3)',
              color: 'var(--siren-red)',
            }}
          >
            {error}
          </div>
          <button
            className="mt-2 text-[11px] px-3 py-1.5 rounded-md transition-colors hover:bg-white/5"
            style={{ color: 'var(--steel-silver)' }}
            onClick={() => { setError(null); }}
          >
            Dismiss
          </button>
        </div>
      )}
    </motion.div>,
    document.body,
  );
}
