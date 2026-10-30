// app/src/components/terminal/Terminal.tsx
// Real terminal — uses xterm.js + node-pty (via WebSocket) for a live shell.
//
// Security: all commands are validated server-side via validateShellCommand()
// before they reach the shell. Blocked commands show a red error in the terminal.
//
// The terminal connects to the server's WS endpoint, creates a PTY session,
// and streams input/output bidirectionally.

import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '@/store/AppContext';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { wsClient } from '@/lib/ws';
import type { AgentEvent } from '@/types';
import {
  Terminal as TerminalIcon,
  ChevronDown,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';

import '@xterm/xterm/css/xterm.css';

// Terminal panel resize constraints
const TERMINAL_MIN_HEIGHT = 80;
const TERMINAL_DEFAULT_HEIGHT = 200;

function getMaxHeight(): number {
  return Math.floor(window.innerHeight * 0.6);
}

function clampHeight(h: number): number {
  return Math.max(TERMINAL_MIN_HEIGHT, Math.min(getMaxHeight(), h));
}

export function Terminal() {
  const { state, dispatch } = useApp();
  const termContainerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [height, setHeight] = useState<number>(TERMINAL_DEFAULT_HEIGHT);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('connecting');
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // ── Initialize xterm.js + connect to WS PTY ──────────────────────────
  useEffect(() => {
    if (!state.bottomPanelVisible) return;
    if (state.activeBottomTab !== 'terminal') return;
    if (xtermRef.current) return; // already initialized

    // Create xterm instance
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0A0A10',
        foreground: '#C8C8DC',
        cursor: '#EE1C1C',
        cursorAccent: '#0A0A10',
        selectionBackground: 'rgba(238, 28, 28, 0.3)',
        black: '#000000',
        red: '#EE1C1C',
        green: '#22C55E',
        yellow: '#F59E0B',
        blue: '#3B82F6',
        magenta: '#EC4899',
        cyan: '#06B6D4',
        white: '#C8C8DC',
        brightBlack: '#6B7280',
        brightRed: '#F87171',
        brightGreen: '#4ADE80',
        brightYellow: '#FBBF24',
        brightBlue: '#60A5FA',
        brightMagenta: '#F472B6',
        brightCyan: '#22D3EE',
        brightWhite: '#F9FAFB',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainerRef.current!);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Connect to the PTY via WebSocket
    wsClient.send('terminal:create', {});

    // ── Handle terminal:ready (session created) ──────────────────────
    const offReady = wsClient.on('terminal:ready', (event: AgentEvent) => {
      const payload = event.payload as { sessionId: string; buffer?: string };
      sessionIdRef.current = payload.sessionId;
      if (payload.buffer) {
        term.write(payload.buffer);
      }
      setStatus('connected');
      term.focus();

      // Send initial resize
      const { cols, rows } = term;
      wsClient.send('terminal:resize', { sessionId: payload.sessionId, cols, rows });
    });

    // ── Handle terminal:output (streamed from PTY) ─────────────────────
    const offOutput = wsClient.on('terminal:output', (event: AgentEvent) => {
      const payload = event.payload as { sessionId: string; data: string };
      if (payload.sessionId === sessionIdRef.current) {
        term.write(payload.data);
      }
    });

    // ── Handle terminal:suggest (AI command suggestions) ──────────────
    const offSuggest = wsClient.on('terminal:suggest', (event: AgentEvent) => {
      const payload = event.payload as { command: string };
      // Show as a dim suggestion line above the prompt
      if (payload.command) {
        term.write(`\r\n\x1b[2m💡 Suggestion: ${payload.command}\x1b[0m\r\n`);
      }
    });

    // ── Input handler: send keystrokes to PTY ──────────────────────────
    const inputDisposable = term.onData((data: string) => {
      if (sessionIdRef.current) {
        wsClient.send('terminal:input', { sessionId: sessionIdRef.current, data });
      }
    });

    // ── Resize handler ─────────────────────────────────────────────────
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current) {
        try {
          fitAddonRef.current.fit();
          if (sessionIdRef.current) {
            const { cols, rows } = xtermRef.current;
            wsClient.send('terminal:resize', { sessionId: sessionIdRef.current, cols, rows });
          }
        } catch {
          // ignore fit errors during unmount
        }
      }
    });
    resizeObserver.observe(termContainerRef.current!);

    // Cleanup
    return () => {
      offReady();
      offOutput();
      offSuggest();
      inputDisposable.dispose();
      resizeObserver.disconnect();
      if (sessionIdRef.current) {
        wsClient.send('terminal:kill', { sessionId: sessionIdRef.current });
        sessionIdRef.current = null;
      }
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [state.bottomPanelVisible, state.activeBottomTab]);

  // ── Drag handle: pointer events ────────────────────────────────────────
  const handleDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = { startY: e.clientY, startHeight: height };
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
  }, [height]);

  const handleDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
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
      // pointer already released
    }
  }, []);

  if (!state.bottomPanelVisible) return null;

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
      {/* Drag handle */}
      <div
        className="h-1 cursor-row-resize hover:bg-red-500/20 transition-colors"
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        style={{ touchAction: 'none' }}
      />

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          className={`px-2 py-0.5 text-[10px] rounded transition-colors flex items-center gap-1 ${state.activeBottomTab === 'terminal' ? 'bg-red-500/10 text-bright-silver' : 'text-muted-silver'}`}
          onClick={() => dispatch({ type: 'SET_BOTTOM_TAB', payload: 'terminal' })}
        >
          <TerminalIcon className="w-2.5 h-2.5" />
          Terminal
          {status === 'connected' && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          )}
          {status === 'connecting' && (
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
          )}
        </button>
        <button
          className={`px-2 py-0.5 text-[10px] rounded transition-colors ${state.activeBottomTab === 'problems' ? 'bg-red-500/10 text-bright-silver' : 'text-muted-silver'}`}
          onClick={() => dispatch({ type: 'SET_BOTTOM_TAB', payload: 'problems' })}
        >
          Problems
        </button>
        <button
          className={`px-2 py-0.5 text-[10px] rounded transition-colors ${state.activeBottomTab === 'output' ? 'bg-red-500/10 text-bright-silver' : 'text-muted-silver'}`}
          onClick={() => dispatch({ type: 'SET_BOTTOM_TAB', payload: 'output' })}
        >
          Output
        </button>
        <button
          className={`px-2 py-0.5 text-[10px] rounded transition-colors ${state.activeBottomTab === 'agent-chat' ? 'bg-red-500/10 text-bright-silver' : 'text-muted-silver'}`}
          onClick={() => dispatch({ type: 'SET_BOTTOM_TAB', payload: 'agent-chat' })}
        >
          Agent
        </button>
        <button
          className="ml-auto p-1 hover:bg-white/5 rounded"
          onClick={() => dispatch({ type: 'TOGGLE_BOTTOM_PANEL' })}
        >
          <ChevronDown className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} />
        </button>
      </div>

      {/* Terminal content */}
      {state.activeBottomTab === 'terminal' && (
        <div className="flex-1 relative overflow-hidden">
          {/* xterm container */}
          <div
            ref={termContainerRef}
            className="w-full h-full"
            style={{ padding: '4px 8px' }}
          />

          {/* Status overlay (shown while connecting or on error) */}
          {status === 'connecting' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted-silver)' }}>
                <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                Connecting to terminal...
              </div>
            </div>
          )}
          {status === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex items-center gap-2 text-[11px] px-3 py-2 rounded" style={{ color: 'var(--siren-red)', backgroundColor: 'rgba(238, 28, 28, 0.06)' }}>
                <AlertCircle className="w-3 h-3" />
                Terminal connection failed
              </div>
            </div>
          )}
        </div>
      )}

      {/* Problems panel */}
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
                <div key={i} className="flex items-center gap-2 px-2 py-1 rounded text-[11px]">
                  <div
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: issue.severity === 'error' ? '#EE1C1C' : issue.severity === 'warning' ? '#F59E0B' : '#3B82F6',
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
          <div className="rounded px-3 py-2 text-[11px]" style={{ backgroundColor: 'rgba(238, 28, 28, 0.06)', color: 'var(--steel-silver)' }}>
            <strong style={{ color: 'var(--siren-red)' }}>Output unavailable.</strong>{' '}
            Build output will appear here when a build is running.
          </div>
        </div>
      )}

      {/* Agent chat panel */}
      {state.activeBottomTab === 'agent-chat' && (
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <div className="space-y-2">
            {state.agents.filter(a => a.status === 'working' || a.status === 'reviewing').map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 px-2 py-1.5 rounded" style={{ backgroundColor: 'var(--surface-raised)' }}>
                <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ backgroundColor: `${agent.color}20` }}>
                  <span className="text-[10px]" style={{ color: agent.color }}>{agent.name.charAt(0)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>{agent.name}</div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--muted-silver)' }}>{agent.currentTask}</div>
                </div>
                <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 animate-agent-pulse" style={{ backgroundColor: agent.color }} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
