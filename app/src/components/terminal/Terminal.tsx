import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '@/store/AppContext';
import {
  X,
  Plus,
  Trash2,
  Terminal as TerminalIcon,
  AlertCircle,
  MessageSquare,
  ChevronUp,
  ChevronDown,
  CheckCircle,
} from 'lucide-react';

// Terminal panel resize constraints (per Bug 4 spec):
//   min 80px, max 60% of viewport height, default 130px.
const TERMINAL_MIN_HEIGHT = 80;
const TERMINAL_DEFAULT_HEIGHT = 130;

function getMaxHeight(): number {
  return Math.floor(window.innerHeight * 0.6);
}

function clampHeight(h: number): number {
  return Math.max(TERMINAL_MIN_HEIGHT, Math.min(getMaxHeight(), h));
}

export function Terminal() {
  const { state, dispatch, setActiveTerminal, addTerminalLine } = useApp();
  const [input, setInput] = useState('');
  const idCounter = useRef(0);
  const [suggestion, setSuggestion] = useState('git commit -m "feat: update components"');
  const scrollRef = useRef<HTMLDivElement>(null);
  // Resizable panel state — persists during the session.
  const [height, setHeight] = useState<number>(TERMINAL_DEFAULT_HEIGHT);
  // Drag handle state — tracks an in-flight pointer drag.
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const activeSession = state.terminalSessions.find((s) => s.id === state.activeTerminalId);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeSession?.history]);

  // ── Drag handle: pointer events ────────────────────────────────────────
  // Drag the top edge UP to expand, DOWN to compress. Uses pointer capture
  // so the drag continues even if the cursor leaves the handle element.
  // Cleanup is defensive — both window listeners and the pointer-capture
  // release are removed on unmount.
  const handleDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = {
      startY: e.clientY,
      startHeight: height,
    };
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
  }, [height]);

  const handleDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    // Moving the cursor UP (negative delta) should EXPAND the panel,
    // so the new height = startHeight - (currentY - startY).
    const delta = e.clientY - drag.startY;
    const next = drag.startHeight - delta;
    setHeight(clampHeight(next));
  }, []);

  const handleDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current) {
      dragStateRef.current = null;
    }
    try {
      (e.target as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released — safe to ignore
    }
  }, []);

  if (!state.bottomPanelVisible) return null;

  const handleCommand = () => {
    if (!input.trim() || !activeSession) return;

    const newLine = {
      id: `tl-${idCounter.current++}`,
      type: 'input' as const,
      content: input,
      timestamp: new Date().toLocaleTimeString(),
    };

    addTerminalLine(activeSession.id, newLine);

    // Simulate command output
    setTimeout(() => {
      const responseLine = {
        id: `tl-${Date.now() + 1}`,
        type: 'output' as const,
        content: getSimulatedOutput(input),
        timestamp: new Date().toLocaleTimeString(),
      };
      addTerminalLine(activeSession.id, responseLine);
    }, 300);

    setInput('');
  };

  const getSimulatedOutput = (cmd: string): string => {
    const commands: Record<string, string> = {
      'ls': 'src/\tpublic/\tpackage.json\ttsconfig.json\tREADME.md',
      'pwd': '/home/dev/projects/ecommerce-platform',
      'whoami': 'dev',
      'date': new Date().toString(),
      'clear': '',
      'help': 'Available commands: ls, pwd, whoami, date, clear, git status, npm install, npm run dev',
    };

    if (cmd.startsWith('git ')) {
      return `On branch main\nYour branch is up to date with 'origin/main'.\n\nChanges not staged for commit:\n  modified:   src/components/Header.tsx\n  modified:   src/components/Button.tsx\n  modified:   src/pages/Dashboard.tsx\n\nno changes added to commit`;
    }

    if (cmd.startsWith('npm ')) {
      if (cmd.includes('dev')) {
        return '  VITE v5.0.0  ready in 420 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.100:5173/\n  ➜  press h + enter to show help';
      }
      if (cmd.includes('install')) {
        return 'added 42 packages in 3.2s\n\n13 packages are looking for funding\nrun `npm fund` for details';
      }
    }

    return commands[cmd] || `Command executed: ${cmd}`;
  };

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        height: `${height}px`,
        minHeight: `${TERMINAL_MIN_HEIGHT}px`,
        maxHeight: '60vh',
        backgroundColor: '#0A0A10',
        borderTop: '1px solid var(--border-subtle)',
      }}
    >
      {/* Drag handle — thin strip at the top edge of the terminal panel.
          Pointer-events drive the height state in handleDrag{Start,Move,End}. */}
      <div
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        tabIndex={0}
        title="Drag to resize terminal"
        style={{
          height: '5px',
          flexShrink: 0,
          cursor: 'row-resize',
          backgroundColor: 'var(--border-subtle)',
          position: 'relative',
        }}
      >
        {/* Visible grip line — centered 2px stripe that brightens on hover */}
        <div
          className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 transition-colors"
          style={{
            width: '40px',
            height: '2px',
            borderRadius: '1px',
            backgroundColor: 'var(--muted-silver)',
            opacity: 0.5,
          }}
        />
      </div>

      {/* Tab bar */}
      <div
        className="flex items-center justify-between px-2"
        style={{
          borderBottom: '1px solid var(--border-subtle)',
          minHeight: '28px',
        }}
      >
        <div className="flex items-center gap-0.5">
          {/* Panel tabs */}
          {(['terminal', 'problems', 'output', 'agent-chat'] as const).map((tab) => {
            const icons = {
              terminal: TerminalIcon,
              problems: AlertCircle,
              output: ChevronUp,
              'agent-chat': MessageSquare,
            };
            const labels = {
              terminal: 'Terminal',
              problems: 'Problems',
              output: 'Output',
              'agent-chat': 'Agent Chat',
            };
            const Icon = icons[tab];
            const isActive = state.activeBottomTab === tab;

            return (
              <button
                key={tab}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors rounded-t"
                style={{
                  backgroundColor: isActive ? '#0A0A10' : 'transparent',
                  color: isActive ? 'var(--bright-silver)' : 'var(--muted-silver)',
                  borderBottom: isActive ? '1px solid var(--siren-red)' : '1px solid transparent',
                }}
                onClick={() => dispatch({ type: 'SET_BOTTOM_TAB', payload: tab })}
              >
                <Icon className="w-3 h-3" />
                {labels[tab]}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded transition-colors hover:bg-white/5"
            style={{ color: 'var(--muted-silver)' }}
          >
            <Plus className="w-3 h-3" />
          </button>
          <button
            className="p-1 rounded transition-colors hover:bg-white/5"
            style={{ color: 'var(--muted-silver)' }}
            onClick={() => dispatch({ type: 'TOGGLE_BOTTOM_PANEL' })}
          >
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Terminal content */}
      {state.activeBottomTab === 'terminal' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Terminal tabs */}
          <div className="flex items-center gap-1 px-2 py-0.5">
            {state.terminalSessions.map((session) => (
              <button
                key={session.id}
                className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded transition-colors"
                style={{
                  backgroundColor: session.isActive ? 'rgba(238, 28, 28, 0.1)' : 'transparent',
                  color: session.isActive ? 'var(--bright-silver)' : 'var(--muted-silver)',
                }}
                onClick={() => setActiveTerminal(session.id)}
              >
                <TerminalIcon className="w-2.5 h-2.5" />
                {session.name}
                {session.isActive && (
                  <button
                    className="ml-1 hover:text-red-500"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </button>
            ))}
          </div>

          {/* Output */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3 py-1 font-code text-[12px] leading-relaxed"
          >
            {activeSession?.history.map((line) => (
              <div
                key={line.id}
                className="py-0.5"
                style={{
                  color:
                    line.type === 'input'
                      ? '#C8C8DC'
                      : line.type === 'error'
                      ? '#EE1C1C'
                      : line.type === 'system'
                      ? '#8A8AA0'
                      : '#22C55E',
                }}
              >
                {line.type === 'input' && (
                  <span style={{ color: 'var(--siren-red)' }}>$ </span>
                )}
                <pre className="whitespace-pre-wrap break-all" style={{ color: 'inherit' }}>
                  {line.content}
                </pre>
              </div>
            ))}
          </div>

          {/* AI Suggestion strip */}
          {suggestion && (
            <div
              className="flex items-center gap-2 px-3 py-1"
              style={{ backgroundColor: 'rgba(238, 28, 28, 0.05)', borderTop: '1px solid var(--border-subtle)' }}
            >
              <span className="text-[10px]" style={{ color: 'var(--siren-red)' }}>
                Suggestion:
              </span>
              <button
                className="text-[11px] px-2 py-0.5 rounded transition-colors hover:bg-white/5 font-code"
                style={{ color: 'var(--steel-silver)' }}
                onClick={() => {
                  setInput(suggestion);
                  setSuggestion('');
                }}
              >
                {suggestion}
              </button>
              <button
                className="ml-auto"
                onClick={() => setSuggestion('')}
                style={{ color: 'var(--muted-silver)' }}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Input */}
          <div
            className="flex items-center gap-2 px-3 py-1"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            <span style={{ color: 'var(--siren-red)' }}>$</span>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCommand();
              }}
              placeholder="Type a command..."
              className="flex-1 bg-transparent text-[12px] outline-none font-code"
              style={{ color: '#C8C8DC' }}
            />
            <button
              className="p-1 rounded transition-colors hover:bg-white/5"
              style={{ color: 'var(--muted-silver)' }}
              onClick={() => setSuggestion('')}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* Problems panel — Phase A: wired to state.problems from Monaco's
          live diagnostics. Falls back to a helpful empty state when there
          are no problems (replaces the old hardcoded demo data). */}
      {state.activeBottomTab === 'problems' && (
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <div className="space-y-1">
            {state.problems.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[11px]" style={{ color: 'var(--muted-silver)' }}>
                <CheckCircle className="w-3 h-3" style={{ color: '#22C55E' }} />
                <span>No problems detected in the active file.</span>
              </div>
            ) : (
              state.problems.map((issue, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2 py-1 rounded text-[11px]"
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor:
                        issue.severity === 'error'
                          ? '#EE1C1C'
                          : issue.severity === 'warning'
                          ? '#F59E0B'
                          : '#3B82F6',
                    }}
                  />
                  <span className="flex-shrink-0 w-16 text-right truncate" style={{ color: 'var(--muted-silver)' }} title={issue.file}>
                    {issue.file.split('/').pop()}
                  </span>
                  <span className="flex-1 truncate" style={{ color: 'var(--bright-silver)' }} title={issue.message}>
                    {issue.message}
                  </span>
                  <span className="ml-auto flex-shrink-0" style={{ color: 'var(--muted-silver)' }}>
                    Line {issue.line}:{issue.column}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Output panel */}
      {state.activeBottomTab === 'output' && (
        <div className="flex-1 overflow-y-auto px-3 py-2 font-code text-[12px]">
          <div style={{ color: '#22C55E' }}>
            <pre className="whitespace-pre-wrap">
              {`[10:32:01] VITE v5.0.0  ready in 420 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.100:5173/
  ➜  press h + enter to show help

[10:32:15] page reload src/components/Header.tsx
[10:32:16] page reload src/components/Button.tsx
[10:32:18] hmr update /src/pages/Dashboard.tsx

Build completed successfully in 312ms.`}
            </pre>
          </div>
        </div>
      )}

      {/* Agent chat panel */}
      {state.activeBottomTab === 'agent-chat' && (
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <div className="space-y-2">
            {state.agents.filter(a => a.status === 'working' || a.status === 'reviewing').map((agent) => (
              <div
                key={agent.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded"
                style={{ backgroundColor: 'var(--surface-raised)' }}
              >
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: `${agent.color}20` }}
                >
                  <span className="text-[10px]" style={{ color: agent.color }}>
                    {agent.name.charAt(0)}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                    {agent.name}
                  </div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--muted-silver)' }}>
                    {agent.currentTask}
                  </div>
                </div>
                <div
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0 animate-agent-pulse"
                  style={{ backgroundColor: agent.color }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
