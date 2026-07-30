// server/src/orchestrator/plans-repo.ts
// Persistence layer for relay plans + milestone logs.
//
// Two backends:
//   1. Postgres (when available) — relay_plans + relay_milestone_logs tables
//   2. In-memory Maps (fallback) — Step 0 proof works without Postgres
//
// Per directive Section 6: this is purely additive — no existing table
// is touched. The migration is in db/migrations/009_agent_relay.sql.

import { v4 as uuid } from 'uuid';
import { query, isDbAvailable, memGet, memSet, memHas } from '../db/client.js';
import type {
  PlanRecord, MilestoneLog, RelayPlan, Milestone,
  OrchestratorDecision, PlanStatus, MilestoneLogStatus,
} from './types.js';
import type { OrchestratorEngineId } from './engine.js';
import type { ApprovalMode } from './settings.js';

// ── In-memory keys (used only when Postgres is unavailable) ──────────────

const MEM_PLANS_KEY = 'orchestrator:plans';
const MEM_LOGS_KEY = 'orchestrator:milestone-logs';

interface MemStore {
  plans: Map<string, PlanRecord>;
  logs: MilestoneLog[];
}

function getMemStore(): MemStore {
  if (!memHas(MEM_PLANS_KEY)) {
    memSet(MEM_PLANS_KEY, { plans: new Map(), logs: [] } satisfies MemStore);
  }
  return memGet<MemStore>(MEM_PLANS_KEY)!;
}

// ── Plan repository ──────────────────────────────────────────────────────

export async function createPlan(params: {
  sessionId: string;
  engine: OrchestratorEngineId;
  approvalMode: ApprovalMode;
  plan: RelayPlan;
}): Promise<PlanRecord> {
  const id = uuid();
  const now = Date.now();
  const record: PlanRecord = {
    id,
    sessionId: params.sessionId,
    projectId: null,
    engine: params.engine,
    approvalMode: params.approvalMode,
    status: 'draft',
    plan: params.plan,
    currentMilestoneId: null,
    createdAt: now,
    updatedAt: now,
  };

  if (isDbAvailable()) {
    try {
      await query(
        `INSERT INTO relay_plans
           (id, session_id, project_id, engine, approval_mode, status, plan_json, current_milestone_id, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $4, 'draft', $5, NULL, NOW(), NOW())`,
        [id, params.sessionId, params.engine, params.approvalMode, JSON.stringify(params.plan)],
      );
    } catch (err) {
      console.warn(`[orchestrator:repo] DB insert failed, falling back to memory: ${err instanceof Error ? err.message : err}`);
      getMemStore().plans.set(id, record);
    }
  } else {
    getMemStore().plans.set(id, record);
  }

  return record;
}

export async function getPlan(planId: string): Promise<PlanRecord | null> {
  if (isDbAvailable()) {
    try {
      const rows = await query<{
        id: string; session_id: string; project_id: string | null;
        engine: OrchestratorEngineId; approval_mode: ApprovalMode; status: PlanStatus;
        plan_json: RelayPlan | string; current_milestone_id: string | null;
        created_at: Date; updated_at: Date;
      }>(
        `SELECT id, session_id, project_id, engine, approval_mode, status,
                plan_json, current_milestone_id, created_at, updated_at
         FROM relay_plans WHERE id = $1`,
        [planId],
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      const planJson = typeof r.plan_json === 'string' ? JSON.parse(r.plan_json) as RelayPlan : r.plan_json;
      return {
        id: r.id, sessionId: r.session_id, projectId: r.project_id,
        engine: r.engine, approvalMode: r.approval_mode, status: r.status,
        plan: planJson, currentMilestoneId: r.current_milestone_id,
        createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime(),
      };
    } catch (err) {
      console.warn(`[orchestrator:repo] DB get failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const mem = getMemStore().plans.get(planId);
  return mem ?? null;
}

export async function updatePlan(planId: string, patch: Partial<PlanRecord>): Promise<PlanRecord | null> {
  const current = await getPlan(planId);
  if (!current) return null;
  const next: PlanRecord = { ...current, ...patch, updatedAt: Date.now() };

  if (isDbAvailable()) {
    try {
      const setClauses: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [];
      let i = 1;
      if (patch.status) { setClauses.push(`status = $${i++}`); params.push(patch.status); }
      if (patch.plan) { setClauses.push(`plan_json = $${i++}`); params.push(JSON.stringify(patch.plan)); }
      if (patch.currentMilestoneId !== undefined) { setClauses.push(`current_milestone_id = $${i++}`); params.push(patch.currentMilestoneId); }
      if (patch.projectId !== undefined) { setClauses.push(`project_id = $${i++}`); params.push(patch.projectId); }
      if (patch.approvalMode) { setClauses.push(`approval_mode = $${i++}`); params.push(patch.approvalMode); }
      params.push(planId);
      await query(
        `UPDATE relay_plans SET ${setClauses.join(', ')} WHERE id = $${i}`,
        params,
      );
    } catch (err) {
      console.warn(`[orchestrator:repo] DB update failed: ${err instanceof Error ? err.message : err}`);
      getMemStore().plans.set(planId, next);
    }
  } else {
    getMemStore().plans.set(planId, next);
  }

  return next;
}

export async function listPlans(limit = 50): Promise<PlanRecord[]> {
  if (isDbAvailable()) {
    try {
      const rows = await query<{ id: string }>(`SELECT id FROM relay_plans ORDER BY created_at DESC LIMIT $1`, [limit]);
      const plans: PlanRecord[] = [];
      for (const r of rows) {
        const p = await getPlan(r.id);
        if (p) plans.push(p);
      }
      return plans;
    } catch (err) {
      console.warn(`[orchestrator:repo] DB list failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  const mem = getMemStore();
  return [...mem.plans.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function listPlansBySession(sessionId: string): Promise<PlanRecord[]> {
  if (isDbAvailable()) {
    try {
      const rows = await query<{ id: string }>(
        `SELECT id FROM relay_plans WHERE session_id = $1 ORDER BY created_at DESC`, [sessionId],
      );
      const plans: PlanRecord[] = [];
      for (const r of rows) {
        const p = await getPlan(r.id);
        if (p) plans.push(p);
      }
      return plans;
    } catch (err) {
      console.warn(`[orchestrator:repo] DB list-by-session failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  const mem = getMemStore();
  return [...mem.plans.values()].filter((p) => p.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt);
}

// ── Milestone log repository ─────────────────────────────────────────────

export async function createMilestoneLog(params: {
  planId: string;
  milestoneId: string;
  agentId: string;
  attempt: number;
}): Promise<MilestoneLog> {
  const id = uuid();
  const now = Date.now();
  const log: MilestoneLog = {
    id,
    planId: params.planId,
    milestoneId: params.milestoneId,
    agentId: params.agentId,
    attempt: params.attempt,
    status: 'running',
    agentResult: null,
    filesReviewed: [],
    orchestratorDecision: null,
    startedAt: now,
    completedAt: null,
  };

  if (isDbAvailable()) {
    try {
      await query(
        `INSERT INTO relay_milestone_logs
           (id, plan_id, milestone_id, agent_id, attempt, status, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', NOW())`,
        [id, params.planId, params.milestoneId, params.agentId, params.attempt],
      );
    } catch (err) {
      console.warn(`[orchestrator:repo] DB milestone log insert failed: ${err instanceof Error ? err.message : err}`);
      getMemStore().logs.push(log);
    }
  } else {
    getMemStore().logs.push(log);
  }

  return log;
}

export async function updateMilestoneLog(logId: string, patch: {
  status?: MilestoneLogStatus;
  agentResult?: { summary: string; filesTouched?: string[] };
  filesReviewed?: string[];
  orchestratorDecision?: OrchestratorDecision;
  completedAt?: number;
}): Promise<void> {
  if (isDbAvailable()) {
    try {
      const setClauses: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (patch.status) { setClauses.push(`status = $${i++}`); params.push(patch.status); }
      if (patch.agentResult) { setClauses.push(`agent_result = $${i++}`); params.push(JSON.stringify(patch.agentResult)); }
      if (patch.filesReviewed) { setClauses.push(`files_reviewed = $${i++}`); params.push(patch.filesReviewed); }
      if (patch.orchestratorDecision) { setClauses.push(`orchestrator_decision = $${i++}`); params.push(JSON.stringify(patch.orchestratorDecision)); }
      if (patch.completedAt) { setClauses.push(`completed_at = NOW()`); }
      params.push(logId);
      if (setClauses.length > 0) {
        await query(
          `UPDATE relay_milestone_logs SET ${setClauses.join(', ')} WHERE id = $${i}`,
          params,
        );
      }
    } catch (err) {
      console.warn(`[orchestrator:repo] DB milestone log update failed: ${err instanceof Error ? err.message : err}`);
      const store = getMemStore();
      const idx = store.logs.findIndex((l) => l.id === logId);
      if (idx !== -1) {
        store.logs[idx] = { ...store.logs[idx], ...patch };
      }
    }
  } else {
    const store = getMemStore();
    const idx = store.logs.findIndex((l) => l.id === logId);
    if (idx !== -1) {
      store.logs[idx] = { ...store.logs[idx], ...patch };
    }
  }
}

export async function listMilestoneLogs(planId: string): Promise<MilestoneLog[]> {
  if (isDbAvailable()) {
    try {
      const rows = await query<{
        id: string; plan_id: string; milestone_id: string; agent_id: string;
        attempt: number; status: MilestoneLogStatus;
        agent_result: { summary: string; filesTouched?: string[] } | string | null;
        files_reviewed: string[] | null;
        orchestrator_decision: OrchestratorDecision | string | null;
        started_at: Date; completed_at: Date | null;
      }>(
        `SELECT id, plan_id, milestone_id, agent_id, attempt, status,
                agent_result, files_reviewed, orchestrator_decision,
                started_at, completed_at
         FROM relay_milestone_logs
         WHERE plan_id = $1
         ORDER BY started_at ASC`,
        [planId],
      );
      return rows.map((r) => ({
        id: r.id,
        planId: r.plan_id,
        milestoneId: r.milestone_id,
        agentId: r.agent_id,
        attempt: r.attempt,
        status: r.status,
        agentResult: r.agent_result
          ? (typeof r.agent_result === 'string' ? JSON.parse(r.agent_result) : r.agent_result)
          : null,
        filesReviewed: r.files_reviewed ?? [],
        orchestratorDecision: r.orchestrator_decision
          ? (typeof r.orchestrator_decision === 'string' ? JSON.parse(r.orchestrator_decision) : r.orchestrator_decision)
          : null,
        startedAt: r.started_at.getTime(),
        completedAt: r.completed_at ? r.completed_at.getTime() : null,
      }));
    } catch (err) {
      console.warn(`[orchestrator:repo] DB milestone log list failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return getMemStore().logs.filter((l) => l.planId === planId);
}

// ── Topological sort (directive Section 1.5) ────────────────────────────

export function topologicalSort(milestones: Milestone[]): Milestone[] {
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const visited = new Set<string>();
  const result: Milestone[] = [];

  function visit(id: string, path: string[]): void {
    if (visited.has(id)) return;
    if (path.includes(id)) {
      throw new Error(`topologicalSort: cycle detected — ${[...path, id].join(' → ')}`);
    }
    const m = byId.get(id);
    if (!m) {
      throw new Error(`topologicalSort: unknown milestone id "${id}" referenced in dependsOn`);
    }
    for (const dep of m.dependsOn) {
      visit(dep, [...path, id]);
    }
    visited.add(id);
    result.push(m);
  }

  for (const m of milestones) {
    visit(m.id, []);
  }
  return result;
}
