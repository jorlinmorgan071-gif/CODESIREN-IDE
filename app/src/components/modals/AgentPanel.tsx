import { useState } from 'react';
import { useApp } from '@/store/AppContext';
import { motion, AnimatePresence } from 'motion/react';
import { api } from '@/lib/api';
import {
  X,
  Bot,
  Eye,
  CheckCircle,
  Zap,
  BarChart3,
  Activity,
  Users,
  MessageSquare,
  Brain,
  ThumbsUp,
  ThumbsDown,
  MinusCircle,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

const statusIcons = {
  idle: Eye,
  working: Zap,
  reviewing: CheckCircle,
  debating: MessageSquare,
};

const statusColors = {
  idle: '#5A5A72',
  working: '#22C55E',
  reviewing: '#F59E0B',
  debating: '#3B82F6',
};

// Meeting Room result shape — mirrors what api.startMeeting returns.
type MeetingProposal = {
  agentId: string;
  agentName: string;
  domain: string;
  color: string;
  trustScore: number;
  text: string;
  vote: 'approve' | 'abstain' | 'reject';
};
type MeetingResult = {
  meetingId: string;
  topic: string;
  decision: 'approved' | 'rejected' | 'inconclusive';
  tally: { approve: number; abstain: number; reject: number };
  quorum: number;
  participants: Array<{
    id: string;
    name: string;
    domain: string;
    color: string;
    trustScore: number;
  }>;
  proposals: MeetingProposal[];
  startedAt: number;
  completedAt: number;
};

const voteIcon = {
  approve: ThumbsUp,
  abstain: MinusCircle,
  reject: ThumbsDown,
};
const voteColor = {
  approve: '#22C55E',
  abstain: '#F59E0B',
  reject: '#EE1C1C',
};
const decisionLabel = {
  approved: 'Approved — proceed',
  rejected: 'Rejected — do not proceed',
  inconclusive: 'Inconclusive — no quorum',
};
const decisionColor = {
  approved: '#22C55E',
  rejected: '#EE1C1C',
  inconclusive: '#F59E0B',
};

export function AgentPanel() {
  const { state, toggleAgentPanel } = useApp();
  const [meeting, setMeeting] = useState<MeetingResult | null>(null);
  const [meetingLoading, setMeetingLoading] = useState(false);
  const [meetingError, setMeetingError] = useState<string | null>(null);

  if (!state.agentPanelVisible) return null;

  const activeAgents = state.agents.filter((a) => a.status === 'working' || a.status === 'reviewing');
  const idleAgents = state.agents.filter((a) => a.status === 'idle');

  const handleOpenMeeting = async () => {
    setMeetingLoading(true);
    setMeetingError(null);
    try {
      const result = await api.startMeeting('Coordinate next iteration', 3);
      setMeeting(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMeetingError(msg);
    } finally {
      setMeetingLoading(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        onClick={toggleAgentPanel}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="w-[800px] max-h-[600px] rounded-xl overflow-hidden flex flex-col"
          style={{
            backgroundColor: '#15151E',
            border: '1px solid #2A2A3C',
            boxShadow: '0 8px 48px rgba(0, 0, 0, 0.8)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: 'rgba(238, 28, 28, 0.15)' }}
              >
                <Users className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
              </div>
              <div>
                <h2 className="text-[16px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                  Agent Workforce
                </h2>
                <p className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                  {activeAgents.length} active of {state.agents.length} total agents
                </p>
              </div>
            </div>
            <button
              className="p-2 rounded-lg transition-colors hover:bg-white/5"
              onClick={toggleAgentPanel}
              style={{ color: 'var(--muted-silver)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Stats Bar */}
          <div className="flex items-center gap-6 px-5 py-3" style={{ backgroundColor: 'rgba(238, 28, 28, 0.03)' }}>
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5" style={{ color: '#22C55E' }} />
              <span className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                {activeAgents.length} Working
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Eye className="w-3.5 h-3.5" style={{ color: 'var(--muted-silver)' }} />
              <span className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                {idleAgents.length} Idle
              </span>
            </div>
            <div className="flex items-center gap-2">
              <BarChart3 className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
              <span className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                Avg Trust: {Math.round(state.agents.reduce((a, b) => a + b.trustScore, 0) / state.agents.length)}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Brain className="w-3.5 h-3.5" style={{ color: '#3B82F6' }} />
              <span className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                Meeting Simulation: {meetingLoading ? 'In session' : meeting ? 'Completed' : 'Ready'}
              </span>
            </div>
          </div>

          {/* Agent Grid OR Meeting Result */}
          <div className="flex-1 overflow-y-auto p-5">
            {meeting ? (
              <div className="flex flex-col gap-3">
                {/* Decision banner */}
                <div
                  className="rounded-lg px-4 py-3 flex items-center justify-between"
                  style={{
                    backgroundColor: `${decisionColor[meeting.decision]}12`,
                    border: `1px solid ${decisionColor[meeting.decision]}40`,
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <CheckCircle className="w-4 h-4" style={{ color: decisionColor[meeting.decision] }} />
                    <div>
                      <div className="text-[12px] font-semibold" style={{ color: decisionColor[meeting.decision] }}>
                        Decision: {decisionLabel[meeting.decision]}
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
                        Topic: {meeting.topic} · Quorum: {meeting.quorum} · {meeting.proposals.length} participants
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span style={{ color: '#22C55E' }}>{meeting.tally.approve} approve</span>
                    <span style={{ color: '#F59E0B' }}>{meeting.tally.abstain} abstain</span>
                    <span style={{ color: '#EE1C1C' }}>{meeting.tally.reject} reject</span>
                  </div>
                </div>

                {/* Proposals */}
                {meeting.proposals.map((p) => {
                  const VoteIcon = voteIcon[p.vote];
                  return (
                    <div
                      key={p.agentId}
                      className="p-3 rounded-lg"
                      style={{
                        backgroundColor: 'var(--surface-dark)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ backgroundColor: `${p.color}15` }}
                        >
                          <Bot className="w-4 h-4" style={{ color: p.color }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                              {p.agentName}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <VoteIcon className="w-3 h-3" style={{ color: voteColor[p.vote] }} />
                              <span className="text-[10px] uppercase font-medium" style={{ color: voteColor[p.vote] }}>
                                {p.vote}
                              </span>
                            </div>
                          </div>
                          <div className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
                            {p.domain} · Trust {p.trustScore}%
                          </div>
                          <p className="text-[11px] mt-1.5" style={{ color: 'var(--bright-silver)' }}>
                            {p.text}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}

                <button
                  onClick={() => setMeeting(null)}
                  className="self-start mt-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:opacity-90"
                  style={{
                    backgroundColor: 'var(--surface-dark)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--bright-silver)',
                  }}
                >
                  ← Back to agent roster
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {state.agents.map((agent) => {
                  const StatusIcon = statusIcons[agent.status];
                  const statusColor = statusColors[agent.status];

                  return (
                    <div
                      key={agent.id}
                      className="p-3 rounded-lg transition-colors hover:bg-white/[0.02]"
                      style={{
                        backgroundColor: agent.status !== 'idle' ? `${agent.color}08` : 'var(--surface-dark)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div className="flex items-start gap-3">
                        {/* Icon */}
                        <div
                          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ backgroundColor: `${agent.color}15` }}
                        >
                          <Bot className="w-4 h-4" style={{ color: agent.color }} />
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-[13px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                              {agent.name}
                            </span>
                            <div className="flex items-center gap-1">
                              <div
                                className={`w-1.5 h-1.5 rounded-full ${agent.status !== 'idle' ? 'animate-agent-pulse' : ''}`}
                                style={{ backgroundColor: statusColor }}
                              />
                              <StatusIcon className="w-3 h-3" style={{ color: statusColor }} />
                            </div>
                          </div>

                          <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--steel-silver)' }}>
                            {agent.specialization}
                          </p>

                          {agent.currentTask && (
                            <p className="text-[10px] mt-1 truncate" style={{ color: agent.color }}>
                              {agent.currentTask}
                            </p>
                          )}

                          {/* Trust Score */}
                          <div className="mt-2 flex items-center gap-2">
                            <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                              Trust
                            </span>
                            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--border-subtle)' }}>
                              <div
                                className="h-full rounded-full transition-all duration-700"
                                style={{
                                  width: `${agent.trustScore}%`,
                                  backgroundColor: agent.trustScore > 90 ? '#22C55E' : agent.trustScore > 70 ? '#F59E0B' : '#EE1C1C',
                                }}
                              />
                            </div>
                            <span className="text-[10px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                              {agent.trustScore}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div
            className="px-5 py-3 flex items-center justify-between"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
              {meeting
                ? `Meeting ${meeting.meetingId} · ${new Date(meeting.completedAt).toLocaleTimeString()}`
                : 'Meeting simulation — deterministic proposals, no LLM calls. Useful for visualizing quorum, not real agent deliberation.'}
            </span>
            {meetingError && (
              <div className="flex items-center gap-1.5 mr-2 text-[10px]" style={{ color: '#EE1C1C' }}>
                <AlertTriangle className="w-3 h-3" />
                <span>{meetingError}</span>
              </div>
            )}
            <button
              onClick={handleOpenMeeting}
              disabled={meetingLoading}
              className="px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5"
              style={{
                backgroundColor: 'var(--siren-red)',
                color: 'white',
              }}
            >
              {meetingLoading ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Running simulation...
                </>
              ) : meeting ? (
                'Re-run Simulation'
              ) : (
                'Run Meeting Simulation'
              )}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
