// app/src/components/modals/ApprovalDialog.tsx
// Approval-gate fix: REAL approval dialog component.
//
// Listens for the `ghost:plan` WS event (already specced, never implemented
// for this purpose until now). Shows the proposed action, the
// validateShellCommand() result (where available), and Approve/Reject buttons.
//
// Approve/Reject call the new endpoints:
//   POST /api/ghost-mode/findings/:findingId/approve
//   POST /api/ghost-mode/findings/:findingId/reject
//
// The dialog NEVER auto-resolves itself. No countdown-to-auto-approve. No
// "remember my choice" default that quietly becomes auto-approve. The user
// MUST click a button — if they don't, the agent's 5-minute timeout fires
// and the task ends REFUSED (fail closed).
//
// Multiple pending approvals queue up — the dialog shows the most recent
// first, with a count of how many are waiting.

import { useEffect, useState, useCallback } from 'react';
import { wsClient } from '@/lib/ws';
import { getToken } from '@/lib/auth';
import { Shield, Check, X, Clock, AlertTriangle } from 'lucide-react';
import type { AgentEvent } from '@/types';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

interface GhostPlan {
  findingId: string;
  steps: string[];
  preview: string;
}

interface GhostDetection {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  agentId?: string;
  taskId?: string;
  userId?: string;
}

interface PendingApproval {
  plan: GhostPlan;
  receivedAt: number;
  detection?: GhostDetection;
}

export function ApprovalDialog() {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [submitting, setSubmitting] = useState<string | null>(null);  // findingId being submitted
  const [error, setError] = useState<string | null>(null);

  // Listen for ghost:plan WS events
  useEffect(() => {
    const detections = new Map<string, GhostDetection>();

    // Track ghost:detection events so we can correlate them with ghost:plan
    const offDetection = wsClient.on('ghost:detection' as never, (evt: AgentEvent) => {
      const d = evt.payload as GhostDetection;
      if (d?.id) {
        detections.set(d.id, d);
      }
    });

    const offPlan = wsClient.on('ghost:plan' as never, (evt: AgentEvent) => {
      const plan = evt.payload as GhostPlan;
      if (!plan?.findingId) return;

      // Don't add duplicates
      setPending((prev) => {
        if (prev.some((p) => p.plan.findingId === plan.findingId)) return prev;
        const detection = detections.get(plan.findingId);
        return [...prev, { plan, receivedAt: Date.now(), detection }];
      });
    });

    // If a finding gets resolved (ghost:fix = approved, ghost:rollback = rejected),
    // remove it from the pending list.
    const offFix = wsClient.on('ghost:fix' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { detectionId?: string };
      const findingId = payload?.detectionId;
      if (findingId) {
        setPending((prev) => prev.filter((p) => p.plan.findingId !== findingId));
      }
    });

    const offRollback = wsClient.on('ghost:rollback' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { detectionId?: string };
      const findingId = payload?.detectionId;
      if (findingId) {
        setPending((prev) => prev.filter((p) => p.plan.findingId !== findingId));
      }
    });

    return () => {
      offDetection();
      offPlan();
      offFix();
      offRollback();
    };
  }, []);

  const approve = useCallback(async (findingId: string) => {
    setSubmitting(findingId);
    setError(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/ghost-mode/findings/${findingId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // The ghost:fix WS event will remove this from pending
    } catch (err) {
      setError(`Approve failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(null);
    }
  }, []);

  const reject = useCallback(async (findingId: string) => {
    setSubmitting(findingId);
    setError(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/ghost-mode/findings/${findingId}/reject`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // The ghost:rollback WS event will remove this from pending
    } catch (err) {
      setError(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(null);
    }
  }, []);

  if (pending.length === 0) {
    return null;  // nothing to show
  }

  const current = pending[pending.length - 1];  // show most recent first
  const queueCount = pending.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)' }}
    >
      <div
        className="w-full max-w-lg rounded-lg overflow-hidden"
        style={{
          backgroundColor: 'var(--surface-dark, #0E0E14)',
          border: '1px solid var(--siren-red, #EE1C1C)',
          boxShadow: '0 0 40px rgba(238, 28, 28, 0.3)',
        }}
      >
        {/* Header */}
        <div
          className="px-4 py-3 flex items-center gap-2"
          style={{
            backgroundColor: 'rgba(238, 28, 28, 0.1)',
            borderBottom: '1px solid var(--border-subtle, #1E1E2A)',
          }}
        >
          <Shield className="w-4 h-4" style={{ color: 'var(--siren-red, #EE1C1C)' }} />
          <span
            className="text-[13px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--bright-silver, #C8C8DC)' }}
          >
            Approval Required
          </span>
          <span
            className="ml-auto text-[10px] px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: 'rgba(238, 28, 28, 0.15)',
              color: 'var(--siren-red, #EE1C1C)',
            }}
          >
            GHOST MODE
          </span>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {/* Severity + agent context */}
          {current.detection && (
            <div className="flex items-center gap-2 text-[11px]">
              <span
                className="px-1.5 py-0.5 rounded font-medium"
                style={{
                  backgroundColor:
                    current.detection.severity === 'high' ? 'rgba(238, 28, 28, 0.15)' :
                    current.detection.severity === 'medium' ? 'rgba(245, 158, 11, 0.15)' :
                    'rgba(59, 130, 246, 0.15)',
                  color:
                    current.detection.severity === 'high' ? 'var(--siren-red, #EE1C1C)' :
                    current.detection.severity === 'medium' ? 'var(--warning, #F59E0B)' :
                    'var(--info, #3B82F6)',
                }}
              >
                {current.detection.severity.toUpperCase()}
              </span>
              <span style={{ color: 'var(--steel-silver, #8A8AA0)' }}>
                {current.detection.type}
              </span>
              {current.detection.agentId && (
                <>
                  <span style={{ color: 'var(--muted-silver, #5A5A72)' }}>·</span>
                  <span style={{ color: 'var(--steel-silver, #8A8AA0)' }}>
                    {current.detection.agentId}
                  </span>
                </>
              )}
            </div>
          )}

          {/* The proposed action */}
          <div>
            <div
              className="text-[10px] uppercase tracking-wider mb-1"
              style={{ color: 'var(--muted-silver, #5A5A72)' }}
            >
              Proposed Action
            </div>
            <div
              className="p-3 rounded font-mono text-[12px] break-words"
              style={{
                backgroundColor: 'var(--surface-raised, #15151E)',
                border: '1px solid var(--border-subtle, #1E1E2A)',
                color: 'var(--bright-silver, #C8C8DC)',
              }}
            >
              {current.detection?.description ?? current.plan.preview}
            </div>
          </div>

          {/* Plan steps (if any) */}
          {current.plan.steps && current.plan.steps.length > 0 && (
            <div>
              <div
                className="text-[10px] uppercase tracking-wider mb-1"
                style={{ color: 'var(--muted-silver, #5A5A72)' }}
              >
                Plan
              </div>
              <ol className="space-y-1">
                {current.plan.steps.map((step, i) => (
                  <li
                    key={i}
                    className="text-[11px] flex gap-2"
                    style={{ color: 'var(--steel-silver, #8A8AA0)' }}
                  >
                    <span style={{ color: 'var(--muted-silver, #5A5A72)' }}>
                      {String(i + 1).padStart(2, '0')}.
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Timeout warning */}
          <div
            className="flex items-center gap-1.5 text-[10px]"
            style={{ color: 'var(--muted-silver, #5A5A72)' }}
          >
            <Clock className="w-3 h-3" />
            <span>
              If no decision within 5 minutes, the action is REFUSED (fail closed).
              No auto-approve. No "remember my choice".
            </span>
          </div>

          {/* Queue count */}
          {queueCount > 0 && (
            <div
              className="flex items-center gap-1.5 text-[10px]"
              style={{ color: 'var(--steel-silver, #8A8AA0)' }}
            >
              <AlertTriangle className="w-3 h-3" />
              <span>{queueCount} more approval(s) queued</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              className="p-2 rounded text-[11px]"
              style={{
                backgroundColor: 'rgba(238, 28, 28, 0.1)',
                border: '1px solid rgba(238, 28, 28, 0.3)',
                color: 'var(--siren-red, #EE1C1C)',
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Actions */}
        <div
          className="px-4 py-3 flex gap-2 justify-end"
          style={{ borderTop: '1px solid var(--border-subtle, #1E1E2A)' }}
        >
          <button
            onClick={() => reject(current.plan.findingId)}
            disabled={submitting === current.plan.findingId}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              backgroundColor: 'transparent',
              border: '1px solid var(--border-hover, #2A2A3C)',
              color: 'var(--steel-silver, #8A8AA0)',
            }}
          >
            <X className="w-3.5 h-3.5" />
            Reject
          </button>
          <button
            onClick={() => approve(current.plan.findingId)}
            disabled={submitting === current.plan.findingId}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              backgroundColor: 'var(--siren-red, #EE1C1C)',
              color: 'white',
              border: '1px solid var(--siren-red, #EE1C1C)',
            }}
          >
            <Check className="w-3.5 h-3.5" />
            {submitting === current.plan.findingId ? 'Submitting…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
