// server/src/orchestrator/types.ts
// Shared types for the Agent Relay system.

import type { OrchestratorEngineId } from './engine.js';
import type { ApprovalMode } from './settings.js';

// ── Plan shape (directive Section 1.3) ───────────────────────────────────

export interface Milestone {
  id: string;                  // e.g. 'M01'
  title: string;
  description: string;
  assignedAgent: string;       // agent id from the roster
  dependsOn: string[];         // milestone ids that must complete first
  acceptanceCriteria: string[]; // what the reviewer checks for
}

export interface RelayPlan {
  projectName: string;
  summary: string;
  techStack: string[];
  milestones: Milestone[];
}

/** A plan may come from a configured model engine or the deterministic P1 policy router. */
export type PlanSource = OrchestratorEngineId | 'capability-policy';

// ── Plan record (DB row + runtime fields) ────────────────────────────────

export type PlanStatus =
  | 'draft' | 'approved' | 'running' | 'paused'
  | 'awaiting-user' | 'completed' | 'failed' | 'stopped';

export interface PlanRecord {
  id: string;
  sessionId: string;
  projectId: string | null;
  engine: PlanSource;
  approvalMode: ApprovalMode;
  status: PlanStatus;
  plan: RelayPlan;
  currentMilestoneId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Milestone log record ─────────────────────────────────────────────────

export type MilestoneLogStatus = 'running' | 'approved' | 'rejected' | 'corrected' | 'failed';

export interface OrchestratorDecision {
  approved: boolean;
  summary: string;
  issues: string[];            // empty if approved
  corrections: string;          // instruction to send back to agent if not approved
}

export interface MilestoneLog {
  id: string;
  planId: string;
  milestoneId: string;
  agentId: string;
  attempt: number;
  status: MilestoneLogStatus;
  agentResult: { summary: string; filesTouched?: string[] } | null;
  filesReviewed: string[];
  orchestratorDecision: OrchestratorDecision | null;
  startedAt: number;
  completedAt: number | null;
}

// ── Tier 1 chat ──────────────────────────────────────────────────────────

export type ChatTier = 'chat' | 'relay';
