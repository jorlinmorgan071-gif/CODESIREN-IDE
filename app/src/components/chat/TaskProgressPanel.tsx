// app/src/components/chat/TaskProgressPanel.tsx
// Phase 5 — Visual Progress Panel: the "observable window into the execution engine."
//
// Renders real-time agent task steps as a visual tracker in the chat:
//
//   ● Planning                         ✓
//   ● Repository analysis              ✓
//   ● Context retrieval                ✓
//   ● Editing auth/service.ts          ● (running)
//   ● Running tests                    ○ (pending)
//   ● Security verification            ○ (pending)
//
// Steps arrive via WS 'agent:step' events, broadcast by addStep() in traces.ts.
// Each step has a status: planned → running → succeeded/failed/skipped.
//
// The panel also shows the current agent name + action summary, so the user
// always knows what's happening without reading the full chat stream.

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { wsClient } from '@/lib/ws';
import type { AgentEvent } from '@/types';
import { CheckCircle, Loader2, Circle, XCircle, FileCode, Terminal, Shield, Cpu, Wrench } from 'lucide-react';

interface StepInfo {
  label: string;
  status: 'planned' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'unverified';
  kind?: string;
  ts: number;
}

interface TaskProgressPanelProps {
  taskId: string;
}

export function TaskProgressPanel({ taskId }: TaskProgressPanelProps) {
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = (event: AgentEvent) => {
      const payload = event.payload as {
        traceId: string;
        taskId: string;
        agentId: string;
        step: { label: string; status: string; kind?: string; ts: number };
      };

      if (payload.taskId !== taskId) return;

      setAgentId(payload.agentId);
      setVisible(true);

      setSteps((prev) => {
        // Deduplicate: if a step with the same label already exists, update it
        const existing = prev.find((s) => s.label === payload.step.label);
        if (existing) {
          return prev.map((s) =>
            s.label === payload.step.label
              ? { ...s, status: payload.step.status as StepInfo['status'], kind: payload.step.kind, ts: payload.step.ts }
              : s
          );
        }
        return [...prev, {
          label: payload.step.label,
          status: payload.step.status as StepInfo['status'],
          kind: payload.step.kind,
          ts: payload.step.ts,
        }];
      });

      // Hide the panel when the last step succeeds or fails
      if (payload.step.status === 'succeeded' || payload.step.status === 'failed') {
        // Check if this is likely the last step (simple heuristic: wait 2s then fade)
        // The panel will be unmounted by the parent when the task completes
      }
    };

    const offHandler = wsClient.on('agent:step', handler);
    return () => { offHandler(); };
  }, [taskId]);

  // Auto-hide after all steps complete (last step succeeded + 3s grace period)
  useEffect(() => {
    if (steps.length === 0) return;
    const allDone = steps.every((s) => s.status === 'succeeded' || s.status === 'failed' || s.status === 'skipped');
    if (allDone && steps.length > 0) {
      const timer = setTimeout(() => setVisible(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [steps]);

  if (!visible || steps.length === 0) return null;

  const completedCount = steps.filter((s) => s.status === 'succeeded').length;
  const totalCount = steps.length;
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // Pick icon based on step kind
  function getStepIcon(kind?: string) {
    switch (kind) {
      case 'tool-call': return <Wrench className="w-3 h-3" />;
      case 'thinking': return <Cpu className="w-3 h-3" />;
      case 'loop-guard': return <Shield className="w-3 h-3" />;
      case 'file-change': return <FileCode className="w-3 h-3" />;
      case 'terminal': return <Terminal className="w-3 h-3" />;
      default: return null;
    }
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-3 mx-2 rounded-lg overflow-hidden"
          style={{
            backgroundColor: 'var(--surface-dark)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {/* Header: agent name + progress bar */}
          <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--steel-silver)' }}>
                {agentId ? agentId.replace('-agent', '').replace('-', ' ') : 'Agent'}
              </span>
              <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                {completedCount}/{totalCount} steps
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-24 h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-raised)' }}>
                <motion.div
                  className="h-full"
                  style={{ backgroundColor: 'var(--siren-red)' }}
                  animate={{ width: `${percent}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
              <span className="text-[10px] font-mono" style={{ color: 'var(--steel-silver)' }}>
                {percent}%
              </span>
            </div>
          </div>

          {/* Step list */}
          <div className="px-3 py-2 space-y-1">
            {steps.map((step, i) => (
              <motion.div
                key={`${step.label}-${i}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, delay: i * 0.05 }}
                className="flex items-center gap-2 text-[11px]"
              >
                {/* Status indicator */}
                <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                  {step.status === 'succeeded' && (
                    <CheckCircle className="w-3 h-3" style={{ color: '#22C55E' }} />
                  )}
                  {step.status === 'running' && (
                    <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--siren-red)' }} />
                  )}
                  {step.status === 'failed' && (
                    <XCircle className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
                  )}
                  {step.status === 'planned' && (
                    <Circle className="w-3 h-3" style={{ color: 'var(--muted-silver)' }} />
                  )}
                  {step.status === 'skipped' && (
                    <Circle className="w-3 h-3" style={{ color: 'var(--muted-silver)', opacity: 0.4 }} />
                  )}
                </span>

                {/* Step icon */}
                {getStepIcon(step.kind) && (
                  <span style={{ color: 'var(--steel-silver)' }}>
                    {getStepIcon(step.kind)}
                  </span>
                )}

                {/* Label */}
                <span
                  style={{
                    color: step.status === 'succeeded' ? 'var(--bright-silver)' :
                           step.status === 'running' ? 'var(--bright-silver)' :
                           step.status === 'failed' ? 'var(--siren-red)' :
                           'var(--muted-silver)',
                    fontWeight: step.status === 'running' ? 500 : 400,
                  }}
                  className="flex-1 truncate"
                >
                  {step.label}
                </span>

                {/* Status badge */}
                {step.status === 'running' && (
                  <motion.span
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="text-[9px] px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: 'rgba(238, 28, 28, 0.1)', color: 'var(--siren-red)' }}
                  >
                    running
                  </motion.span>
                )}
                {step.status === 'succeeded' && (
                  <span className="text-[9px]" style={{ color: '#22C55E' }}>✓</span>
                )}
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
