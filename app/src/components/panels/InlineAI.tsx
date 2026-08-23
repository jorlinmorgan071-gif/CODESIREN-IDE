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
  Check,
  XCircle,
} from 'lucide-react';
import { getToken } from '@/lib/auth';
import { api } from '@/lib/api';
import { summarizeChangeImpact, type ChangeImpactAnalysis } from '@/lib/change-impact';
import { getActiveEditorContent } from '@/components/editor/CodeEditor';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

// Phase B: Editor Actions — 'explain' + edit-family (refactor/document/optimize/convert)
// are functional. 'test' (Generate Tests) is honestly disabled — needs writeProjectFile() gate.
const quickActions = [
  { id: 'explain', label: 'Explain', icon: FileText, description: 'Explain this code', available: true },
  { id: 'refactor', label: 'Refactor', icon: RefreshCw, description: 'Refactor for clarity', available: true },
  { id: 'optimize', label: 'Optimize', icon: Gauge, description: 'Optimize performance', available: true },
  { id: 'test', label: 'Generate Tests', icon: TestTube, description: 'Create unit tests', available: false },
  { id: 'document', label: 'Document', icon: FileCode, description: 'Add documentation', available: true },
  { id: 'convert', label: 'Convert', icon: Languages, description: 'Convert language', available: true },
];

// Modes that produce a code edit (vs. explain which is read-only)
const EDIT_MODES = new Set(['refactor', 'optimize', 'document', 'convert']);

interface DiffPreview {
  originalCode: string;
  resultCode: string;
  mode: string;
  selectionRange: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  fileId?: string;
  path?: string;
  transactionId?: string;
  editorContent?: string;
  impact?: ChangeImpactAnalysis;
}

export function InlineAI() {
  const { state, toggleInlineAI, setInlineAIPosition, dispatch } = useApp();
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffPreview, setDiffPreview] = useState<DiffPreview | null>(null);
  const [applyStatus, setApplyStatus] = useState<'idle' | 'applied' | 'rejected'>('idle');
  const panelRef = useRef<HTMLDivElement>(null);

  // Listen for 'code-siren:explain' from Monaco context menu + edit-family requests
  useEffect(() => {
    const handleExplainRequest = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        code: string;
        language?: string;
        editMode?: string;
        fileId?: string;
        path?: string;
        editorContent?: string;
        selectionRange?: DiffPreview['selectionRange'];
      };
      if (!detail?.code) return;

      // If editMode is present, route to the refactor endpoint instead of explain
      if (detail.editMode && EDIT_MODES.has(detail.editMode)) {
        void runRefactor(detail.code, detail.editMode, detail.language, detail.selectionRange, detail.fileId, detail.path, detail.editorContent);
      } else {
        void runExplain(detail.code, detail.language);
      }
    };
    window.addEventListener('code-siren:explain', handleExplainRequest);
    return () => window.removeEventListener('code-siren:explain', handleExplainRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for vision results from ScreenIntelligence (screen share / drag-and-drop / paste)
  useEffect(() => {
    const handleVisionResult = (e: Event) => {
      const detail = (e as CustomEvent).detail as { analysis?: string; error?: string };
      setDiffPreview(null);
      setApplyStatus('idle');
      if (detail?.error) {
        setError(detail.error);
        setResponse(null);
      } else if (detail?.analysis) {
        setResponse(detail.analysis);
        setError(null);
      }
    };
    window.addEventListener('code-siren:vision-result', handleVisionResult);
    return () => window.removeEventListener('code-siren:vision-result', handleVisionResult);
  }, []);

  const runExplain = useCallback(async (code: string, language?: string) => {
    setActiveAction('explain');
    setResponse(null);
    setError(null);
    setDiffPreview(null);
    setApplyStatus('idle');
    try {
      const token = getToken() ?? '';
      const res = await fetch(`${API_BASE}/orchestrator/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code, language }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Request failed' })) as { error: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { explanation: string };
      setResponse(data.explanation || '(no explanation returned)');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveAction(null);
    }
  }, []);

  const runRefactor = useCallback(async (code: string, mode: string, language?: string, selectionRange?: DiffPreview['selectionRange'], fileId?: string, path?: string, editorContent?: string) => {
    if (!path || !fileId || editorContent === undefined) {
      setError('This editor tab is not bound to a real workspace-relative path. Code Siren will not apply a filesystem change until one is selected.');
      return;
    }
    setActiveAction(mode);
    setResponse(null);
    setError(null);
    setDiffPreview(null);
    setApplyStatus('idle');
    try {
      const token = getToken() ?? '';
      const res = await fetch(`${API_BASE}/orchestrator/refactor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code, mode, targetLanguage: mode === 'convert' ? language : undefined }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Request failed' })) as { error: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { result: string };
      if (!data.result || data.result.startsWith('(operation timed out')) {
        throw new Error(data.result || 'Empty result');
      }
      // Plan the server-owned patch before showing an approval affordance.
      const transaction = await api.planChange({
        path,
        before: code,
        after: data.result,
        expectedContent: editorContent,
        mode: mode as 'refactor' | 'document' | 'optimize' | 'convert',
      });
      setDiffPreview({
        originalCode: code,
        resultCode: data.result,
        mode,
        selectionRange: selectionRange ?? { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 0 },
        fileId,
        path,
        transactionId: transaction.transactionId,
        editorContent,
        impact: transaction.impact,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveAction(null);
    }
  }, []);

  const handleAccept = useCallback(async () => {
    if (!diffPreview?.transactionId || !diffPreview.fileId) return;
    try {
      if (getActiveEditorContent() !== diffPreview.editorContent) {
        throw new Error('The editor buffer changed after planning. Reload the server diff and plan a new transaction before approval.');
      }
      const applied = await api.approveChange(diffPreview.transactionId);
      if (applied.status !== 'applied' || !applied.content || applied.verification?.status !== 'passed') {
        throw new Error(applied.reason ?? 'Change transaction did not reconcile the workspace file');
      }
      dispatch({ type: 'RECONCILE_FILE_CONTENT', payload: { fileId: diffPreview.fileId, content: applied.content } });
      setApplyStatus('applied');
      setDiffPreview(null);
      setTimeout(() => {
        setApplyStatus('idle');
        setResponse(`Applied and verified: ${applied.verification?.detail}`);
      }, 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [diffPreview, dispatch]);

  const handleReject = useCallback(() => {
    setApplyStatus('rejected');
    setDiffPreview(null);
    setTimeout(() => {
      setApplyStatus('idle');
      setResponse(null);
    }, 1500);
  }, []);

  const handleAction = (actionId: string) => {
    if (!quickActions.find(a => a.id === actionId)?.available) return;

    if (actionId === 'explain') {
      // Request selection from editor, then runExplain will fire via the custom event
      window.dispatchEvent(new CustomEvent('code-siren:request-selection'));
      return;
    }

    if (EDIT_MODES.has(actionId)) {
      // For edit modes, we need both the selection text AND the range.
      // Dispatch a request that asks the editor to send back code + range.
      window.dispatchEvent(new CustomEvent('code-siren:request-selection-for-edit', {
        detail: { mode: actionId },
      }));
      return;
    }
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
    const handleMouseUp = () => setIsDragging(false);
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
      className="fixed z-50 w-[380px] rounded-lg overflow-hidden"
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
        style={{ backgroundColor: 'rgba(238, 28, 28, 0.08)', borderBottom: '1px solid var(--border-subtle)', cursor: 'grab' }}
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <Move className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} />
          <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>Ariadne</span>
        </div>
        <button className="p-1 rounded transition-colors hover:bg-white/10" onClick={toggleInlineAI} style={{ color: 'var(--muted-silver)' }}>
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Quick Actions Grid */}
      {!response && !error && !activeAction && !diffPreview && applyStatus === 'idle' && (
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
                  <div className="text-[9px] truncate" style={{ color: 'var(--muted-silver)' }}>{action.description}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Loading state */}
      {activeAction && (
        <div className="p-4 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[12px]" style={{ color: 'var(--steel-silver)' }}>
            {activeAction === 'explain' ? 'Explaining code...' : `${activeAction}ing code...`}
          </span>
        </div>
      )}

      {/* Explain response (read-only) */}
      {response && !diffPreview && (
        <div className="p-3">
          <div className="text-[12px] leading-relaxed p-2.5 rounded-md whitespace-pre-wrap" style={{ backgroundColor: 'rgba(238, 28, 28, 0.05)', borderLeft: '2px solid var(--siren-red)', color: 'var(--bright-silver)' }}>
            {response}
          </div>
          <button className="mt-2 text-[11px] px-3 py-1.5 rounded-md transition-colors hover:bg-white/5 flex items-center gap-1" style={{ color: 'var(--siren-red)' }} onClick={() => setResponse(null)}>
            <Wand2 className="w-3 h-3" /> New Action
          </button>
        </div>
      )}

      {/* Diff preview + Accept/Reject */}
      {diffPreview && (
        <div className="p-3 space-y-3">
          <div className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
            {diffPreview.mode === 'refactor' ? 'Refactored' : diffPreview.mode === 'document' ? 'Documented' : diffPreview.mode === 'optimize' ? 'Optimized' : 'Converted'} Code Preview
          </div>
          {/* Original */}
          <div>
            <div className="text-[10px] mb-1" style={{ color: 'var(--muted-silver)' }}>ORIGINAL</div>
            <pre className="text-[10px] p-2 rounded-md overflow-auto max-h-24" style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', color: 'var(--steel-silver)' }}>
              {diffPreview.originalCode}
            </pre>
          </div>
          {/* Result */}
          <div>
            <div className="text-[10px] mb-1" style={{ color: 'var(--siren-red)' }}>RESULT</div>
            <pre className="text-[10px] p-2 rounded-md overflow-auto max-h-32" style={{ backgroundColor: 'rgba(238, 28, 28, 0.05)', border: '1px solid rgba(238, 28, 28, 0.2)', color: 'var(--bright-silver)' }}>
              {diffPreview.resultCode}
            </pre>
          </div>
          {diffPreview.impact && (
            <section aria-label="Changed-surface impact analysis" className="p-2 rounded-md space-y-1.5" style={{ backgroundColor: 'rgba(255,255,255,0.025)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-[10px] font-medium" style={{ color: 'var(--steel-silver)' }}>CHANGED-SURFACE ANALYSIS</div>
              <p className="text-[10px] leading-relaxed" style={{ color: 'var(--muted-silver)' }}>
                {summarizeChangeImpact(diffPreview.impact)}
              </p>
              {diffPreview.impact.status === 'available' && (
                <>
                  {diffPreview.impact.dependents.length > 0 && <div className="text-[9px]" style={{ color: 'var(--muted-silver)' }}>Direct dependents: {diffPreview.impact.dependents.map((entry) => entry.path).join(', ')}</div>}
                  {diffPreview.impact.routes.length > 0 && <div className="text-[9px]" style={{ color: 'var(--muted-silver)' }}>Static routes: {diffPreview.impact.routes.map((entry) => `${entry.method} ${entry.path}`).join(', ')}</div>}
                  {diffPreview.impact.tests.length > 0 && <div className="text-[9px]" style={{ color: 'var(--muted-silver)' }}>Affected tests: {diffPreview.impact.tests.map((entry) => entry.path).join(', ')}</div>}
                  <div className="text-[9px] pt-1" style={{ color: 'var(--steel-silver)' }}>DECLARED VERIFICATION — NOT RUN</div>
                  {diffPreview.impact.verification.length > 0
                    ? diffPreview.impact.verification.map((entry) => <code key={`${entry.packagePath}:${entry.command}`} className="block text-[9px] break-all" style={{ color: 'var(--muted-silver)' }}>{entry.packagePath}$ {entry.command}</code>)
                    : <div className="text-[9px]" style={{ color: 'var(--muted-silver)' }}>No package script could be declared from the affected surface.</div>}
                </>
              )}
            </section>
          )}
          {/* Accept/Reject */}
          <div className="flex gap-2">
            <button
              onClick={handleAccept}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-medium transition-all"
              style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.4)', color: '#22c55e' }}
            >
              <Check className="w-3.5 h-3.5" /> Accept
            </button>
            <button
              onClick={handleReject}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-medium transition-all"
              style={{ backgroundColor: 'rgba(238, 28, 28, 0.15)', border: '1px solid rgba(238, 28, 28, 0.4)', color: 'var(--siren-red)' }}
            >
              <XCircle className="w-3.5 h-3.5" /> Reject
            </button>
          </div>
          <div className="text-[10px] text-center" style={{ color: 'var(--muted-silver)' }}>
            Accept applies the edit (Ctrl+Z to revert). Reject discards it.
          </div>
        </div>
      )}

      {/* Applied/Rejected confirmation */}
      {applyStatus !== 'idle' && !diffPreview && (
        <div className="p-4 flex items-center gap-2">
          {applyStatus === 'applied' ? (
            <>
              <Check className="w-4 h-4" style={{ color: '#22c55e' }} />
              <span className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>Applied! Ctrl+Z to revert.</span>
            </>
          ) : (
            <>
              <XCircle className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
              <span className="text-[12px]" style={{ color: 'var(--steel-silver)' }}>Rejected. Editor unchanged.</span>
            </>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-3">
          <div className="text-[12px] p-2.5 rounded-md" style={{ backgroundColor: 'rgba(238, 28, 28, 0.1)', border: '1px solid rgba(238, 28, 28, 0.3)', color: 'var(--siren-red)' }}>
            {error}
          </div>
          <button className="mt-2 text-[11px] px-3 py-1.5 rounded-md transition-colors hover:bg-white/5" style={{ color: 'var(--steel-silver)' }} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </motion.div>,
    document.body,
  );
}
