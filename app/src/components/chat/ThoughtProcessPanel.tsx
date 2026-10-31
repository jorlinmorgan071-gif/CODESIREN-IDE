// app/src/components/chat/ThoughtProcessPanel.tsx
// Live "Thought Process" panel — shows the AI's reasoning, tool calls, and
// command execution in real-time BEFORE the response appears.
//
// This is the panel you see in the reference image:
//   ┌─ Thought Process ──────────────────────┐
//   │ ● Analyzing your message          ✓    │
//   │ ● Generating response            ⠋     │
//   │ ● Ran: npm test                 ✓    │
//   └────────────────────────────────────────┘
//
// It listens to THREE event types:
//   1. agent:thinking — from tier1-chat (normal chat, no tools)
//   2. agent:step     — from agent dispatch (multi-step tasks with tools)
//   3. terminal:output — from the PTY terminal (command execution)
//
// The panel appears when the first thinking event arrives and fades out
// 2 seconds after the "complete" phase arrives.

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { wsClient } from '@/lib/ws';
import type { AgentEvent } from '@/types';
import { Brain, Loader2, CheckCircle, Terminal as TerminalIcon, Wrench } from 'lucide-react';

interface ThinkingStep {
  id: string;
  phase: string;
  message: string;
  status: 'running' | 'done' | 'error';
  kind?: 'thinking' | 'tool-call' | 'terminal' | 'file-change';
  ts: number;
}

interface ThoughtProcessPanelProps {
  taskId: string;
}

export function ThoughtProcessPanel({ taskId }: ThoughtProcessPanelProps) {
  const [steps, setSteps] = useState<ThinkingStep[]>([]);
  const [visible, setVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // ── Handler for agent:thinking (normal chat) ────────────────────────
    const handleThinking = (event: AgentEvent) => {
      const payload = event.payload as { taskId?: string; phase: string; message: string; ts: number };
      if (payload.taskId && payload.taskId !== taskId) return;

      setVisible(true);
      // Clear any pending hide timer — we're active again
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      setSteps((prev) => {
        // If this phase already exists, update it; otherwise add it
        const existing = prev.find((s) => s.phase === payload.phase);
        const status = payload.phase === 'complete' ? 'done' : 'running';

        // Mark ALL previous steps as done when a new phase starts
        const updated = prev.map((s) => ({
          ...s,
          status: s.status === 'running' ? 'done' as const : s.status,
        }));

        if (existing) {
          return updated.map((s) =>
            s.phase === payload.phase
              ? { ...s, message: payload.message, status, ts: payload.ts }
              : s
          );
        }
        return [...updated, {
          id: `think-${payload.ts}`,
          phase: payload.phase,
          message: payload.message,
          status,
          kind: 'thinking',
          ts: payload.ts,
        }];
      });

      // Auto-hide 2s after "complete" phase
      if (payload.phase === 'complete') {
        hideTimerRef.current = setTimeout(() => setVisible(false), 2000);
      }
    };

    // ── Handler for agent:step (agent tasks with tools) ────────────────
    const handleStep = (event: AgentEvent) => {
      const payload = event.payload as {
        taskId: string;
        agentId: string;
        step: { label: string; status: string; kind?: string; ts: number };
      };
      if (payload.taskId !== taskId) return;

      setVisible(true);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      const kind = payload.step.kind as ThinkingStep['kind'];
      setSteps((prev) => {
        const existing = prev.find((s) => s.message === payload.step.label);
        const status = payload.step.status === 'succeeded' ? 'done' :
                       payload.step.status === 'failed' ? 'error' :
                       payload.step.status === 'skipped' ? 'done' : 'running';

        if (existing) {
          return prev.map((s) =>
            s.message === payload.step.label
              ? { ...s, status, kind: kind ?? s.kind }
              : s
          );
        }
        return [...prev, {
          id: `step-${payload.step.ts}`,
          phase: payload.step.kind ?? 'step',
          message: payload.step.label,
          status,
          kind: kind ?? 'thinking',
          ts: payload.step.ts,
        }];
      });

      // Auto-hide if all steps are done
      if (payload.step.status === 'succeeded' || payload.step.status === 'failed') {
        setSteps((prev) => {
          const allDone = prev.every((s) => s.status === 'done' || s.status === 'error');
          if (allDone && prev.length > 0) {
            hideTimerRef.current = setTimeout(() => setVisible(false), 2000);
          }
          return prev;
        });
      }
    };

    const offThinking = wsClient.on('agent:thinking', handleThinking);
    const offStep = wsClient.on('agent:step', handleStep);

    return () => {
      offThinking();
      offStep();
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [taskId]);

  // Note: terminal command execution is shown by the Terminal component
  // itself (real PTY output). This panel focuses on AI thinking + tool calls.

  return (
    <AnimatePresence>
      {visible && steps.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="mb-3 mx-2 rounded-lg overflow-hidden"
          style={{
            backgroundColor: 'rgba(10, 10, 16, 0.9)',
            border: '1px solid rgba(238, 28, 28, 0.15)',
            backdropFilter: 'blur(8px)',
          }}
        >
          {/* Header: "Thought Process" with pulsing brain icon */}
          <div
            className="px-3 py-2 flex items-center gap-2"
            style={{ borderBottom: '1px solid rgba(238, 28, 28, 0.1)' }}
          >
            <motion.div
              animate={{ opacity: [0.6, 1, 0.6] }}
              transition={{ repeat: Infinity, duration: 2 }}
            >
              <Brain className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
            </motion.div>
            <span
              className="text-[10px] uppercase tracking-wider font-medium"
              style={{ color: 'var(--steel-silver)' }}
            >
              Thought Process
            </span>
            <span className="text-[9px]" style={{ color: 'var(--muted-silver)' }}>
              {steps.filter((s) => s.status === 'done').length}/{steps.length}
            </span>
          </div>

          {/* Step list with staggered animation */}
          <div className="px-3 py-2 space-y-1">
            {steps.map((step, i) => (
              <motion.div
                key={step.id}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: i * 0.05 }}
                className="flex items-center gap-2 text-[11px]"
              >
                {/* Status icon */}
                <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                  {step.status === 'done' && (
                    <CheckCircle className="w-3 h-3" style={{ color: '#22C55E' }} />
                  )}
                  {step.status === 'running' && (
                    <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--siren-red)' }} />
                  )}
                  {step.status === 'error' && (
                    <span style={{ color: 'var(--siren-red)' }}>✗</span>
                  )}
                </span>

                {/* Kind icon (tool-call, terminal, etc.) */}
                {step.kind === 'tool-call' && (
                  <Wrench className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
                )}
                {step.kind === 'terminal' && (
                  <TerminalIcon className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
                )}
                {step.kind === 'thinking' && (
                  <Brain className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} />
                )}

                {/* Message */}
                <span
                  className="flex-1 truncate font-code"
                  style={{
                    color: step.status === 'done' ? 'var(--steel-silver)' :
                           step.status === 'running' ? 'var(--bright-silver)' :
                           'var(--siren-red)',
                  }}
                >
                  {step.message}
                </span>

                {/* Running shimmer effect */}
                {step.status === 'running' && (
                  <motion.span
                    animate={{ opacity: [0.3, 0.8, 0.3] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="text-[9px] px-1.5 py-0.5 rounded font-mono"
                    style={{ backgroundColor: 'rgba(238, 28, 28, 0.08)', color: 'var(--siren-red)' }}
                  >
                    running
                  </motion.span>
                )}
              </motion.div>
            ))}
          </div>

          {/* Bottom progress shimmer */}
          {steps.some((s) => s.status === 'running') && (
            <motion.div
              className="h-0.5"
              style={{
                background: 'linear-gradient(90deg, transparent, var(--siren-red), transparent)',
              }}
              animate={{ x: ['-100%', '100%'] }}
              transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
