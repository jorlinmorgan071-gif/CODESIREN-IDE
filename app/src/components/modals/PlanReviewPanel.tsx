// app/src/components/modals/PlanReviewPanel.tsx
// Directive Section 2.2 — Plan Review panel.
//
// Full-screen modal that shows the generated plan: project name + summary,
// editable milestone list, approval mode toggle, two action buttons.
//
// On open, fetches the latest plan from the orchestrator endpoint. The user
// can edit titles/descriptions/assigned agent/acceptance criteria inline,
// toggle approval mode, then click "Approve & Start Build" to kick off
// the relay execution loop.

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Loader2, AlertTriangle, Plus, Trash2, GripVertical,
  Play, ChevronRight, FileCode,
} from 'lucide-react';
import { api } from '@/lib/api';
import type {
  OrchestratorPlan, Milestone, PlanStatus, MilestoneLog,
} from '@/types';

interface PlanReviewPanelProps {
  open: boolean;
  planId: string | null;
  onClose: () => void;
  onApproved?: (planId: string) => void;
}

// Agent roster — same list as the backend's AVAILABLE_AGENTS in relay-loop.ts.
// Used to populate the assigned-agent dropdown per milestone.
const AGENT_OPTIONS = [
  { id: 'architect-agent', label: 'Architect', color: '#EE1C1C' },
  { id: 'frontend-agent', label: 'Frontend', color: '#22C55E' },
  { id: 'backend-agent', label: 'Backend', color: '#3B82F6' },
  { id: 'database-agent', label: 'Database', color: '#F59E0B' },
  { id: 'qa-tester-agent', label: 'QA Tester', color: '#8B5CF6' },
  { id: 'security-agent', label: 'Security', color: '#EE1C1C' },
  { id: 'devops-agent', label: 'DevOps', color: '#06B6D4' },
  { id: 'documentation-agent', label: 'Documentation', color: '#10B981' },
  { id: 'performance-agent', label: 'Performance', color: '#F97316' },
  { id: 'terminal-agent', label: 'Terminal', color: '#A855F7' },
  { id: 'ui-designer-agent', label: 'UI Designer', color: '#EC4899' },
  { id: 'research-agent', label: 'Research', color: '#6366F1' },
  { id: 'deployment-agent', label: 'Deployment', color: '#D946EF' },
  { id: 'code-review-agent', label: 'Code Review', color: '#EF4444' },
];

const STATUS_COLOR: Record<PlanStatus, string> = {
  draft: '#8A8AA0',
  approved: '#3B82F6',
  running: '#22C55E',
  paused: '#F59E0B',
  'awaiting-user': '#F59E0B',
  completed: '#22C55E',
  failed: '#EE1C1C',
  stopped: '#8A8AA0',
};

const STATUS_LABEL: Record<PlanStatus, string> = {
  draft: 'Draft — awaiting approval',
  approved: 'Approved — relay starting',
  running: 'Running',
  paused: 'Paused',
  'awaiting-user': 'Awaiting your input',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

export function PlanReviewPanel({ open, planId, onClose, onApproved }: PlanReviewPanelProps) {
  const [plan, setPlan] = useState<OrchestratorPlan | null>(null);
  const [status, setStatus] = useState<PlanStatus>('draft');
  const [approvalMode, setApprovalMode] = useState<'auto' | 'default'>('default');
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [milestoneLogs, setMilestoneLogs] = useState<MilestoneLog[]>([]);

  const fetchPlan = useCallback(async () => {
    if (!planId) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await api.getPlanDetail(planId);
      setPlan(detail.plan);
      setStatus(detail.status);
      setApprovalMode(detail.approvalMode);
      setMilestoneLogs(detail.milestoneLogs ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => {
    if (open && planId) {
      fetchPlan();
    }
  }, [open, planId, fetchPlan]);

  const handleApprove = async () => {
    if (!planId || !plan) return;
    setApproving(true);
    setError(null);
    try {
      await api.approvePlan(planId, {
        approvalMode,
        milestones: plan.milestones,
      });
      onApproved?.(planId);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setApproving(false);
    }
  };

  const updateMilestone = (id: string, patch: Partial<Milestone>) => {
    if (!plan) return;
    setPlan({
      ...plan,
      milestones: plan.milestones.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  };

  const addMilestone = () => {
    if (!plan) return;
    const nextId = `M${String(plan.milestones.length + 1).padStart(2, '0')}`;
    setPlan({
      ...plan,
      milestones: [
        ...plan.milestones,
        {
          id: nextId,
          title: `New Milestone ${plan.milestones.length + 1}`,
          description: '',
          assignedAgent: 'architect-agent',
          dependsOn: [],
          acceptanceCriteria: [],
        },
      ],
    });
  };

  const removeMilestone = (id: string) => {
    if (!plan) return;
    setPlan({
      ...plan,
      milestones: plan.milestones.filter((m) => m.id !== id),
    });
  };

  const addCriterion = (milestoneId: string) => {
    if (!plan) return;
    setPlan({
      ...plan,
      milestones: plan.milestones.map((m) =>
        m.id === milestoneId
          ? { ...m, acceptanceCriteria: [...m.acceptanceCriteria, ''] }
          : m,
      ),
    });
  };

  const updateCriterion = (milestoneId: string, idx: number, value: string) => {
    if (!plan) return;
    setPlan({
      ...plan,
      milestones: plan.milestones.map((m) =>
        m.id === milestoneId
          ? {
              ...m,
              acceptanceCriteria: m.acceptanceCriteria.map((c, i) => (i === idx ? value : c)),
            }
          : m,
      ),
    });
  };

  const removeCriterion = (milestoneId: string, idx: number) => {
    if (!plan) return;
    setPlan({
      ...plan,
      milestones: plan.milestones.map((m) =>
        m.id === milestoneId
          ? { ...m, acceptanceCriteria: m.acceptanceCriteria.filter((_, i) => i !== idx) }
          : m,
      ),
    });
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="w-full max-w-5xl max-h-[90vh] rounded-xl overflow-hidden flex flex-col"
            style={{
              backgroundColor: '#0F0F18',
              border: '1px solid #2A2A3C',
              boxShadow: '0 16px 64px rgba(0, 0, 0, 0.8)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-4 shrink-0"
              style={{ borderBottom: '1px solid var(--border-subtle)' }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: 'rgba(238, 28, 28, 0.15)' }}
                >
                  <FileCode className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
                </div>
                <div>
                  <h2 className="text-[16px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                    Plan Review
                  </h2>
                  <p className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                    {plan ? plan.projectName : 'Loading…'} · {plan ? `${plan.milestones.length} milestones` : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {plan && (
                  <div
                    className="px-2.5 py-1 rounded-md text-[10px] font-medium uppercase tracking-wider"
                    style={{
                      backgroundColor: `${STATUS_COLOR[status]}15`,
                      color: STATUS_COLOR[status],
                      border: `1px solid ${STATUS_COLOR[status]}40`,
                    }}
                  >
                    {STATUS_LABEL[status]}
                  </div>
                )}
                <button
                  className="p-2 rounded-lg transition-colors hover:bg-white/5"
                  onClick={onClose}
                  style={{ color: 'var(--muted-silver)' }}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--steel-silver)' }} />
                  <span className="ml-3 text-[12px]" style={{ color: 'var(--steel-silver)' }}>
                    Loading plan…
                  </span>
                </div>
              ) : error ? (
                <div
                  className="flex items-center gap-2 p-3 rounded-md"
                  style={{
                    backgroundColor: 'rgba(238, 28, 28, 0.05)',
                    border: '1px solid rgba(238, 28, 28, 0.3)',
                  }}
                >
                  <AlertTriangle className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
                  <span className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>{error}</span>
                  <button
                    className="ml-auto text-[11px] underline"
                    style={{ color: 'var(--siren-red)' }}
                    onClick={fetchPlan}
                  >
                    Retry
                  </button>
                </div>
              ) : plan ? (
                <div className="flex flex-col gap-5">
                  {/* Project summary */}
                  <div
                    className="p-4 rounded-lg"
                    style={{
                      backgroundColor: 'var(--surface-dark)',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <input
                      type="text"
                      value={plan.projectName}
                      onChange={(e) => setPlan({ ...plan, projectName: e.target.value })}
                      className="w-full bg-transparent text-[15px] font-semibold outline-none mb-2"
                      style={{ color: 'var(--bright-silver)' }}
                    />
                    <textarea
                      value={plan.summary}
                      onChange={(e) => setPlan({ ...plan, summary: e.target.value })}
                      rows={2}
                      className="w-full bg-transparent text-[12px] outline-none resize-none"
                      style={{ color: 'var(--steel-silver)' }}
                    />
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {plan.techStack.map((tech, i) => (
                        <span
                          key={i}
                          className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{
                            backgroundColor: 'rgba(238, 28, 28, 0.08)',
                            color: 'var(--siren-red)',
                          }}
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Approval mode toggle */}
                  <div
                    className="flex items-center justify-between p-3 rounded-lg"
                    style={{
                      backgroundColor: 'var(--surface-dark)',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div>
                      <div className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                        Approval mode
                      </div>
                      <div className="text-[11px]" style={{ color: 'var(--muted-silver)' }}>
                        {approvalMode === 'auto'
                          ? 'Orchestrator reviews each milestone and advances automatically'
                          : 'Orchestrator pauses after each milestone for your approval'}
                      </div>
                    </div>
                    <div className="flex gap-1 p-1 rounded-md" style={{ backgroundColor: 'var(--surface-raised)' }}>
                      <button
                        className="px-3 py-1 rounded text-[11px] font-medium transition-colors"
                        style={{
                          backgroundColor: approvalMode === 'default' ? 'var(--siren-red)' : 'transparent',
                          color: approvalMode === 'default' ? 'white' : 'var(--steel-silver)',
                        }}
                        onClick={() => setApprovalMode('default')}
                      >
                        Default
                      </button>
                      <button
                        className="px-3 py-1 rounded text-[11px] font-medium transition-colors"
                        style={{
                          backgroundColor: approvalMode === 'auto' ? 'var(--siren-red)' : 'transparent',
                          color: approvalMode === 'auto' ? 'white' : 'var(--steel-silver)',
                        }}
                        onClick={() => setApprovalMode('auto')}
                      >
                        Auto
                      </button>
                    </div>
                  </div>

                  {/* Milestones */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-[13px] font-semibold uppercase tracking-wider" style={{ color: 'var(--bright-silver)' }}>
                        Milestones ({plan.milestones.length})
                      </h3>
                      <button
                        onClick={addMilestone}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors hover:bg-white/5"
                        style={{ color: 'var(--siren-red)', border: '1px solid var(--border-subtle)' }}
                      >
                        <Plus className="w-3 h-3" />
                        Add milestone
                      </button>
                    </div>
                    <div className="flex flex-col gap-3">
                      {plan.milestones.map((milestone) => {
                        const logsForMilestone = milestoneLogs.filter((l) => l.milestoneId === milestone.id);
                        return (
                          <div
                            key={milestone.id}
                            className="p-4 rounded-lg"
                            style={{
                              backgroundColor: 'var(--surface-dark)',
                              border: '1px solid var(--border-subtle)',
                            }}
                          >
                            <div className="flex items-start gap-3">
                              <GripVertical className="w-4 h-4 mt-2 flex-shrink-0" style={{ color: 'var(--muted-silver)' }} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-2">
                                  <span
                                    className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                                    style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--muted-silver)' }}
                                  >
                                    {milestone.id}
                                  </span>
                                  <input
                                    type="text"
                                    value={milestone.title}
                                    onChange={(e) => updateMilestone(milestone.id, { title: e.target.value })}
                                    className="flex-1 bg-transparent text-[13px] font-medium outline-none"
                                    style={{ color: 'var(--bright-silver)' }}
                                  />
                                  <button
                                    onClick={() => removeMilestone(milestone.id)}
                                    className="p-1 rounded transition-colors hover:bg-white/5"
                                    style={{ color: 'var(--muted-silver)' }}
                                    title="Remove milestone"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                                <textarea
                                  value={milestone.description}
                                  onChange={(e) => updateMilestone(milestone.id, { description: e.target.value })}
                                  rows={2}
                                  placeholder="Milestone description…"
                                  className="w-full bg-transparent text-[12px] outline-none resize-none mb-3"
                                  style={{ color: 'var(--steel-silver)' }}
                                />
                                <div className="grid grid-cols-2 gap-3 mb-3">
                                  <div>
                                    <label className="text-[10px] uppercase tracking-wider mb-1 block" style={{ color: 'var(--muted-silver)' }}>
                                      Assigned agent
                                    </label>
                                    <select
                                      value={milestone.assignedAgent}
                                      onChange={(e) => updateMilestone(milestone.id, { assignedAgent: e.target.value })}
                                      className="w-full bg-transparent text-[12px] outline-none rounded px-2 py-1"
                                      style={{
                                        color: 'var(--bright-silver)',
                                        backgroundColor: 'var(--surface-raised)',
                                        border: '1px solid var(--border-subtle)',
                                      }}
                                    >
                                      {AGENT_OPTIONS.map((a) => (
                                        <option key={a.id} value={a.id} style={{ backgroundColor: '#15151E' }}>
                                          {a.label} ({a.id})
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <div>
                                    <label className="text-[10px] uppercase tracking-wider mb-1 block" style={{ color: 'var(--muted-silver)' }}>
                                      Depends on
                                    </label>
                                    <input
                                      type="text"
                                      value={milestone.dependsOn.join(', ')}
                                      onChange={(e) => updateMilestone(milestone.id, {
                                        dependsOn: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                                      })}
                                      placeholder="comma-separated milestone ids, e.g. M01, M02"
                                      className="w-full bg-transparent text-[12px] outline-none rounded px-2 py-1"
                                      style={{
                                        color: 'var(--bright-silver)',
                                        backgroundColor: 'var(--surface-raised)',
                                        border: '1px solid var(--border-subtle)',
                                      }}
                                    />
                                  </div>
                                </div>
                                <div>
                                  <div className="flex items-center justify-between mb-1">
                                    <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--muted-silver)' }}>
                                      Acceptance criteria
                                    </label>
                                    <button
                                      onClick={() => addCriterion(milestone.id)}
                                      className="text-[10px] flex items-center gap-1"
                                      style={{ color: 'var(--siren-red)' }}
                                    >
                                      <Plus className="w-2.5 h-2.5" />
                                      Add
                                    </button>
                                  </div>
                                  <div className="flex flex-col gap-1">
                                    {milestone.acceptanceCriteria.map((crit, cidx) => (
                                      <div key={cidx} className="flex items-center gap-1.5">
                                        <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--muted-silver)' }} />
                                        <input
                                          type="text"
                                          value={crit}
                                          onChange={(e) => updateCriterion(milestone.id, cidx, e.target.value)}
                                          className="flex-1 bg-transparent text-[11px] outline-none px-1.5 py-1 rounded"
                                          style={{
                                            color: 'var(--bright-silver)',
                                            backgroundColor: 'var(--surface-raised)',
                                            border: '1px solid var(--border-subtle)',
                                          }}
                                        />
                                        <button
                                          onClick={() => removeCriterion(milestone.id, cidx)}
                                          className="p-0.5 rounded hover:bg-white/5"
                                          style={{ color: 'var(--muted-silver)' }}
                                        >
                                          <X className="w-2.5 h-2.5" />
                                        </button>
                                      </div>
                                    ))}
                                    {milestone.acceptanceCriteria.length === 0 && (
                                      <span className="text-[10px] italic" style={{ color: 'var(--muted-silver)' }}>
                                        No acceptance criteria defined — orchestrator will auto-approve
                                      </span>
                                    )}
                                  </div>
                                </div>
                                {/* Milestone logs (visible when relay has run this milestone) */}
                                {logsForMilestone.length > 0 && (
                                  <div
                                    className="mt-3 pt-3"
                                    style={{ borderTop: '1px solid var(--border-subtle)' }}
                                  >
                                    <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>
                                      Execution log ({logsForMilestone.length} {logsForMilestone.length === 1 ? 'attempt' : 'attempts'})
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                      {logsForMilestone.map((log) => (
                                        <div
                                          key={log.id}
                                          className="text-[11px] flex items-start gap-2"
                                          style={{ color: 'var(--steel-silver)' }}
                                        >
                                          <span
                                            className="px-1.5 py-0.5 rounded text-[9px] uppercase font-medium flex-shrink-0"
                                            style={{
                                              backgroundColor:
                                                log.status === 'approved' ? 'rgba(34, 197, 94, 0.15)' :
                                                log.status === 'rejected' ? 'rgba(238, 28, 28, 0.15)' :
                                                log.status === 'failed' ? 'rgba(238, 28, 28, 0.15)' :
                                                log.status === 'corrected' ? 'rgba(245, 158, 11, 0.15)' :
                                                'rgba(138, 138, 160, 0.15)',
                                              color:
                                                log.status === 'approved' ? '#22C55E' :
                                                log.status === 'rejected' || log.status === 'failed' ? '#EE1C1C' :
                                                log.status === 'corrected' ? '#F59E0B' :
                                                '#8A8AA0',
                                            }}
                                          >
                                            attempt {log.attempt}
                                          </span>
                                          <span className="flex-1">
                                            {log.orchestratorDecision?.summary ?? log.agentResult?.summary ?? '(no summary)'}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Footer */}
            <div
              className="px-5 py-3 flex items-center justify-between shrink-0"
              style={{ borderTop: '1px solid var(--border-subtle)' }}
            >
              <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                {plan
                  ? `${plan.milestones.length} milestones · ${approvalMode === 'auto' ? 'auto-approve' : 'default approval'}`
                  : ''}
              </span>
              {error && (
                <div className="flex items-center gap-1.5 mr-2 text-[10px]" style={{ color: '#EE1C1C' }}>
                  <AlertTriangle className="w-3 h-3" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:opacity-90"
                  style={{
                    backgroundColor: 'var(--surface-dark)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--bright-silver)',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleApprove}
                  disabled={!plan || approving || status !== 'draft' && status !== 'failed' && status !== 'stopped'}
                  className="px-4 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5"
                  style={{
                    backgroundColor: 'var(--siren-red)',
                    color: 'white',
                  }}
                >
                  {approving ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Starting…
                    </>
                  ) : (
                    <>
                      <Play className="w-3 h-3" />
                      Approve &amp; Start Build
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
