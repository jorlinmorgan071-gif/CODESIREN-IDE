// app/src/components/chat/RecoveryPanel.tsx
// Phase 4/5 — Recovery Panel: listens for task:stale-detected + task:recovery-needed
// WS events and renders the diagnostic panel (halt reason, resumption point,
// global-switch vs single-agent-switch choice).
//
// This is the actual visual signal the user sees when a task stalls or fails:
// a panel appears in the chat showing what happened + offering recovery options.

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { wsClient } from '@/lib/ws';
import type { AgentEvent, AgentEventName } from '@/types';
import { AlertTriangle, Loader2, X, ArrowRightCircle } from 'lucide-react';

interface DiagnosticData {
  taskId: string;
  agentId: string;
  haltReason: string;
  errorMessage: string;
  remediation: string;
  currentProvider: string;
  currentModel: string;
  availableAlternatives: Array<{
    providerId: string;
    providerName: string;
    modelId: string;
    modelName: string;
    isFree: boolean;
    contextWindow: number;
  }>;
  resumptionPoint: {
    shouldResume: boolean;
    resumeFromStep: number | null;
    reason: string;
    completedSteps: number;
    totalSteps: number;
  };
}

export function RecoveryPanel() {
  const [diagnostic, setDiagnostic] = useState<DiagnosticData | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchResult, setSwitchResult] = useState<string | null>(null);

  useEffect(() => {
    // Listen for task:recovery-needed (Phase 4's recovery flow)
    const handleRecoveryNeeded = (evt: AgentEvent) => {
      const data = evt.payload as unknown as DiagnosticData;
      setDiagnostic(data);
      setSwitchResult(null);
    };

    // Also listen for task:stale-detected (Phase 3's stale detector)
    const handleStaleDetected = (evt: AgentEvent) => {
      const data = evt.payload as {
        taskId: string;
        agentId: string;
        goal: string;
        previouslyStatus: string;
        resumeFromStep: number | null;
        resumeReason: string;
      };

      // Build a lightweight diagnostic from the stale detection
      setDiagnostic({
        taskId: data.taskId,
        agentId: data.agentId,
        haltReason: 'stale-detected',
        errorMessage: `Task was ${data.previouslyStatus} and went stale. It may have been interrupted by a crash or network failure.`,
        remediation: 'You can resume this task with the same provider or switch to a different one. The task state (completed steps, changed files) has been preserved.',
        currentProvider: 'unknown',
        currentModel: 'unknown',
        availableAlternatives: [],
        resumptionPoint: {
          shouldResume: true,
          resumeFromStep: data.resumeFromStep,
          reason: data.resumeReason,
          completedSteps: 0,
          totalSteps: 0,
        },
      });
      setSwitchResult(null);
    };

    const offRecovery = wsClient.on('task:recovery-needed' as AgentEventName, handleRecoveryNeeded);
    const offStale = wsClient.on('task:stale-detected' as AgentEventName, handleStaleDetected);

    return () => {
      offRecovery();
      offStale();
    };
  }, []);

  const handleSwitch = async (providerId: string, modelId: string) => {
    if (!diagnostic) return;
    setSwitching(true);
    try {
      const result = await fetch(`${import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api'}/models/routing/agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('code_siren_jwt')}`,
        },
        body: JSON.stringify({
          agentId: diagnostic.agentId,
          providerId,
          modelId,
        }),
      });
      if (result.ok) {
        setSwitchResult(`Switched to ${providerId}/${modelId}. The task will resume from step ${(diagnostic.resumptionPoint.resumeFromStep ?? 0) + 1}.`);
      } else {
        const err = await result.json();
        setSwitchResult(`Switch failed: ${err.error}`);
      }
    } catch (err: unknown) {
      setSwitchResult(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSwitching(false);
    }
  };

  const handleClose = () => {
    setDiagnostic(null);
    setSwitchResult(null);
  };

  return (
    <AnimatePresence>
      {diagnostic && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="mb-3 mx-2 rounded-lg overflow-hidden"
          style={{
            backgroundColor: 'rgba(238, 28, 28, 0.06)',
            border: '1px solid rgba(238, 28, 28, 0.3)',
          }}
        >
          {/* Header */}
          <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(238, 28, 28, 0.2)' }}>
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
              <span className="text-[12px] font-medium" style={{ color: 'var(--siren-red)' }}>
                Task Interrupted
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(238, 28, 28, 0.1)', color: 'var(--siren-red)' }}>
                {diagnostic.haltReason}
              </span>
            </div>
            <button onClick={handleClose} style={{ color: 'var(--muted-silver)' }}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Body */}
          <div className="px-3 py-3 space-y-3">
            {/* Error info */}
            <div>
              <p className="text-[11px]" style={{ color: 'var(--bright-silver)' }}>
                {diagnostic.errorMessage}
              </p>
              {diagnostic.remediation && (
                <p className="text-[10px] mt-1" style={{ color: 'var(--steel-silver)' }}>
                  {diagnostic.remediation}
                </p>
              )}
            </div>

            {/* Resumption point */}
            {diagnostic.resumptionPoint.shouldResume && (
              <div className="px-2 py-1.5 rounded" style={{ backgroundColor: 'var(--surface-dark)' }}>
                <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
                  Resumption Point
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--bright-silver)' }}>
                  {diagnostic.resumptionPoint.reason}
                </div>
                {diagnostic.resumptionPoint.totalSteps > 0 && (
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                    {diagnostic.resumptionPoint.completedSteps}/{diagnostic.resumptionPoint.totalSteps} steps completed
                  </div>
                )}
              </div>
            )}

            {/* Alternatives */}
            {diagnostic.availableAlternatives.length > 0 && !switchResult && (
              <div>
                <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--steel-silver)' }}>
                  Switch to a different provider
                </div>
                <div className="space-y-1">
                  {diagnostic.availableAlternatives.slice(0, 3).map((alt) => (
                    <button
                      key={`${alt.providerId}-${alt.modelId}`}
                      onClick={() => handleSwitch(alt.providerId, alt.modelId)}
                      disabled={switching}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors disabled:opacity-60"
                      style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
                    >
                      {switching ? (
                        <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--steel-silver)' }} />
                      ) : (
                        <ArrowRightCircle className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px]" style={{ color: 'var(--bright-silver)' }}>
                          {alt.modelName}
                        </div>
                        <div className="text-[9px]" style={{ color: 'var(--muted-silver)' }}>
                          {alt.providerName}
                          {alt.isFree && ' · Free'}
                          {alt.contextWindow > 0 && ` · ${(alt.contextWindow / 1000).toFixed(0)}K context`}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Switch result */}
            {switchResult && (
              <div className="px-2 py-1.5 rounded text-[11px]" style={{ backgroundColor: 'var(--surface-dark)', color: 'var(--bright-silver)' }}>
                {switchResult}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
