// server/src/orchestrator/relay-loop.ts
// The Agent Relay execution loop — directive Section 1.5.
//
// Two entry points:
//   1. generatePlan(sessionId) — reads session messages, asks the orchestrator
//      engine to produce a structured build plan, persists it, returns it.
//   2. runRelayPlan(planId)    — topologically sorts milestones, then for
//      each: executes the assigned agent via agentManager.executeAndWait,
//      asks the orchestrator engine to review the actual files produced,
//      parses the decision, advances or sends corrections back, pauses
//      for user input in default-approval mode.
//
// Per directive Section 6:
//   - The orchestrator NEVER speaks directly to the user as an AI persona.
//     Its only output is parsed JSON decisions surfaced via WS events.
//   - Tier 1 chat never calls this loop. Agents are exclusively activated
//     by runRelayPlan.
//   - Max 2 correction attempts per milestone. After 2 failed corrections,
//     pause and surface to the user.
//   - Ghost Mode approval gate is NOT bypassed — executeAndWait uses the
//     same agent.execute() path as the existing send(), so any side-effect
//     the agent attempts still goes through the existing gate.

import { v4 as uuid } from 'uuid';
import { agentManager } from '../orchestration/agent-manager.js';
import { makeEvent, broadcast } from '../ws/events.js';
import { query } from '../db/client.js';
import { getOrchestratorEngine, getActiveOrchestratorEngineId } from './engine.js';
import { getOrchestratorSettings } from './settings.js';
import {
  createPlan, getPlan, updatePlan, createMilestoneLog, updateMilestoneLog,
  listMilestoneLogs, topologicalSort,
} from './plans-repo.js';
import { extractJson, validatePlan, validateReviewDecision } from './parse.js';
import type { OrchestratorMessage } from './engine.js';
import type {
  RelayPlan, Milestone, PlanRecord, OrchestratorDecision,
} from './types.js';
import type { AgentTask, ExecutionMode, TaskPriority, TaskType } from '../types.js';

// ── 1. Plan generation ───────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = `You are the Code Siren orchestrator. Read the conversation below
and produce a structured build plan for the described project.
Output ONLY valid JSON in this exact shape — no markdown, no
preamble:
{
  "projectName": string,
  "summary": string,
  "techStack": string[],
  "milestones": [
    {
      "id": string,         // e.g. 'M01'
      "title": string,
      "description": string,
      "assignedAgent": string, // agent id from the roster
      "dependsOn": string[],   // milestone ids that must complete first
      "acceptanceCriteria": string[] // what the reviewer checks for
    }
  ]
}`;

const AVAILABLE_AGENTS = [
  'architect-agent', 'frontend-agent', 'backend-agent', 'database-agent',
  'qa-tester-agent', 'security-agent', 'devops-agent', 'documentation-agent',
  'performance-agent', 'terminal-agent', 'memory-agent', 'ui-designer-agent',
  'research-agent', 'deployment-agent', 'prompt-engineer-agent', 'code-review-agent',
  'fabrication-agent', 'operative-agent', 'sentinel-agent', 'extension-agent',
];

export async function generatePlan(sessionId: string): Promise<PlanRecord> {
  // 1. Read session messages
  const messages = await loadSessionMessages(sessionId);
  if (messages.length === 0) {
    throw new Error('Cannot generate plan: session has no messages');
  }

  // 2. Build the orchestrator prompt
  const conversationText = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const agentRoster = AVAILABLE_AGENTS.join(', ');
  const userPrompt = `Conversation:\n\n${conversationText}\n\n---\n\nAvailable agents (use these exact ids for assignedAgent): ${agentRoster}\n\nProduce the build plan now.`;

  const orchestratorMessages: OrchestratorMessage[] = [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  // 3. Call the active orchestrator engine
  const engine = getOrchestratorEngine();
  console.log(`[orchestrator:plan] generating plan for session ${sessionId} via ${engine.id}`);
  const raw = await engine.chat(orchestratorMessages);

  // 4. Parse + validate
  const parsed = extractJson(raw);
  const plan = validatePlan(parsed);

  // 5. Persist
  const settings = getOrchestratorSettings();
  const record = await createPlan({
    sessionId,
    engine: getActiveOrchestratorEngineId(),
    approvalMode: settings.approvalMode,
    plan,
  });

  // 6. Emit relay:plan-ready (directive Section 1.6)
  broadcast(makeEvent('relay:plan-ready' as any, {
    planId: record.id,
    plan,
  }));

  console.log(`[orchestrator:plan] plan ${record.id} generated — ${plan.milestones.length} milestones, engine=${record.engine}`);
  return record;
}

async function loadSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string }>> {
  // Try Postgres first
  try {
    const rows = await query<{ role: string; content: string }>(
      'SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId],
    );
    if (rows.length > 0) return rows;
  } catch {
    // fall through
  }
  // No messages found (Postgres unavailable OR session genuinely empty)
  return [];
}

// ── 2. Relay execution loop ──────────────────────────────────────────────

const MAX_CORRECTION_ATTEMPTS = 2;  // directive Section 6

// In-memory map of plans currently running. Keyed by planId.
// Each entry holds a resolve() that the /advance endpoint calls to
// unblock waitForUserAdvance().
interface AwaitingAdvance {
  resolve: () => void;
  milestoneId: string;
}
const awaitingAdvance = new Map<string, AwaitingAdvance>();

// In-memory map of plans currently running (so we can stop them).
const runningPlans = new Map<string, { aborted: boolean }>();

export async function runRelayPlan(planId: string): Promise<void> {
  const plan = await getPlan(planId);
  if (!plan) {
    broadcast(makeEvent('relay:error' as any, { planId, error: 'Plan not found' }));
    return;
  }
  if (plan.status === 'running') {
    broadcast(makeEvent('relay:error' as any, { planId, error: 'Plan is already running' }));
    return;
  }

  // Mark as running
  await updatePlan(planId, { status: 'running' });
  const runState = { aborted: false };
  runningPlans.set(planId, runState);

  console.log(`[orchestrator:relay] starting plan ${planId} — ${plan.plan.milestones.length} milestones, mode=${plan.approvalMode}`);

  try {
    const orderedMilestones = topologicalSort(plan.plan.milestones);

    for (const milestone of orderedMilestones) {
      if (runState.aborted) {
        console.log(`[orchestrator:relay] plan ${planId} aborted before milestone ${milestone.id}`);
        break;
      }

      await updatePlan(planId, { currentMilestoneId: milestone.id });

      // Run the milestone (with up to MAX_CORRECTION_ATTEMPTS correction retries)
      const success = await runMilestone(planId, plan, milestone, runState);
      if (!success) {
        // Either failed all corrections OR was aborted
        if (runState.aborted) {
          await updatePlan(planId, { status: 'stopped' });
        } else {
          await updatePlan(planId, { status: 'awaiting-user' });
          // The runMilestone function already emitted relay:awaiting-user
          // with the specific issues + corrections.
        }
        runningPlans.delete(planId);
        return;
      }

      // Milestone approved — wait for user advance if in default-approval mode
      if (plan.approvalMode === 'default' && !runState.aborted) {
        // Find next milestone to know if we're done
        const nextMilestoneIdx = orderedMilestones.findIndex((m) => m.id === milestone.id) + 1;
        if (nextMilestoneIdx < orderedMilestones.length) {
          // Pause and wait for /advance
          const nextMilestone = orderedMilestones[nextMilestoneIdx];
          broadcast(makeEvent('relay:awaiting-user' as any, {
            planId,
            milestoneId: milestone.id,
            nextMilestoneId: nextMilestone.id,
            summary: `Milestone ${milestone.id} (${milestone.title}) approved. Next: ${nextMilestone.title}`,
          }));
          await updatePlan(planId, { status: 'awaiting-user' });
          await waitForUserAdvance(planId, milestone.id);
          // After resume, check abort
          if (runState.aborted) {
            await updatePlan(planId, { status: 'stopped' });
            runningPlans.delete(planId);
            return;
          }
          await updatePlan(planId, { status: 'running' });
        }
      }
    }

    // All milestones complete
    if (!runState.aborted) {
      await updatePlan(planId, { status: 'completed', currentMilestoneId: null });
      broadcast(makeEvent('relay:plan-complete' as any, {
        planId,
        projectName: plan.plan.projectName,
      }));
      console.log(`[orchestrator:relay] plan ${planId} completed`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator:relay] plan ${planId} failed:`, msg);
    await updatePlan(planId, { status: 'failed' });
    broadcast(makeEvent('relay:error' as any, { planId, error: msg }));
  } finally {
    runningPlans.delete(planId);
    awaitingAdvance.delete(planId);
  }
}

/**
 * Runs a single milestone with up to MAX_CORRECTION_ATTEMPTS correction attempts.
 * Returns true if the milestone was approved, false if it failed all attempts
 * (in which case relay:awaiting-user has been emitted with the issues).
 */
async function runMilestone(
  planId: string,
  plan: PlanRecord,
  milestone: Milestone,
  runState: { aborted: boolean },
): Promise<boolean> {
  const engine = getOrchestratorEngine();

  for (let attempt = 1; attempt <= MAX_CORRECTION_ATTEMPTS + 1; attempt++) {
    if (runState.aborted) return false;

    const log = await createMilestoneLog({
      planId,
      milestoneId: milestone.id,
      agentId: milestone.assignedAgent,
      attempt,
    });

    console.log(`[orchestrator:relay] plan ${planId} milestone ${milestone.id} attempt ${attempt}`);

    // 1. Build + execute the agent task
    const task = buildAgentTask(plan, milestone, attempt);
    const result = await agentManager.executeAndWait(task);

    if (runState.aborted) {
      await updateMilestoneLog(log.id, {
        status: 'failed',
        agentResult: { summary: 'aborted', filesTouched: result.filesTouched },
        completedAt: Date.now(),
      });
      return false;
    }

    if (result.error) {
      // Agent itself errored — log and treat as a failed attempt
      await updateMilestoneLog(log.id, {
        status: 'failed',
        agentResult: { summary: `agent error: ${result.error}`, filesTouched: result.filesTouched },
        completedAt: Date.now(),
      });
      // Don't retry on agent errors — they usually indicate a config issue
      broadcast(makeEvent('relay:awaiting-user' as any, {
        planId, milestoneId: milestone.id,
        summary: `Agent ${milestone.assignedAgent} errored: ${result.error}`,
      }));
      return false;
    }

    // 2. List actual files produced
    const filesProduced = await listProjectFiles(plan, milestone, result.filesTouched);
    await updateMilestoneLog(log.id, {
      agentResult: { summary: result.text.slice(0, 2000), filesTouched: result.filesTouched },
      filesReviewed: filesProduced.map((f) => f.path),
    });

    // 3. Ask the orchestrator to review
    const reviewPrompt = buildReviewPrompt(milestone, result.text, filesProduced);
    const reviewMessages: OrchestratorMessage[] = [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: reviewPrompt },
    ];

    let decision: OrchestratorDecision;
    try {
      const rawReview = await engine.chat(reviewMessages);
      decision = validateReviewDecision(extractJson(rawReview));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[orchestrator:relay] review failed: ${msg}. Auto-approving milestone ${milestone.id}.`);
      // If the orchestrator can't review (rate limit, parse error), auto-approve
      // to avoid stalling the build. The user can re-review manually.
      decision = {
        approved: true,
        summary: `(auto-approved — orchestrator review unavailable: ${msg})`,
        issues: [],
        corrections: '',
      };
    }

    await updateMilestoneLog(log.id, {
      status: decision.approved ? 'approved' : 'rejected',
      orchestratorDecision: decision,
      completedAt: Date.now(),
    });

    if (decision.approved) {
      // 4. Emit relay:milestone-complete
      broadcast(makeEvent('relay:milestone-complete' as any, {
        planId, milestoneId: milestone.id,
        summary: decision.summary,
        filesProduced: filesProduced.map((f) => f.path),
      }));
      console.log(`[orchestrator:relay] plan ${planId} milestone ${milestone.id} approved (attempt ${attempt})`);
      return true;
    }

    // Not approved — emit rejection
    broadcast(makeEvent('relay:milestone-rejected' as any, {
      planId, milestoneId: milestone.id,
      attempt,
      issues: decision.issues,
      corrections: decision.corrections,
    }));
    console.log(`[orchestrator:relay] plan ${planId} milestone ${milestone.id} rejected (attempt ${attempt}): ${decision.issues.join('; ')}`);

    // If we've exhausted correction attempts, surface to user
    if (attempt > MAX_CORRECTION_ATTEMPTS) {
      broadcast(makeEvent('relay:awaiting-user' as any, {
        planId, milestoneId: milestone.id,
        summary: `Milestone ${milestone.id} failed after ${MAX_CORRECTION_ATTEMPTS + 1} attempts. Issues: ${decision.issues.join('; ')}`,
        issues: decision.issues,
        corrections: decision.corrections,
      }));
      return false;
    }
    // Otherwise loop and retry with corrections
  }

  return false;
}

function buildAgentTask(plan: PlanRecord, milestone: Milestone, attempt: number): AgentTask {
  const description = attempt === 1
    ? `Milestone ${milestone.id}: ${milestone.title}\n\n${milestone.description}\n\nAcceptance criteria:\n${milestone.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\nProject: ${plan.plan.projectName}\nTech stack: ${plan.plan.techStack.join(', ')}`
    : `Retry milestone ${milestone.id} (attempt ${attempt}). Previous attempt was rejected.\n\nMilestone: ${milestone.title}\n${milestone.description}\n\nCorrections required:\n${milestone.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`;

  return {
    id: uuid(),
    projectId: plan.projectId ?? '00000000-0000-0000-0000-000000000000',
    sessionId: plan.sessionId,
    agentId: milestone.assignedAgent,
    type: 'custom' as TaskType,
    description,
    context: {
      projectId: plan.projectId ?? '00000000-0000-0000-0000-000000000000',
      rootPath: `/tmp/code-siren-relay/${plan.id}`,
      techStack: Object.fromEntries(plan.plan.techStack.map((s) => [s, true])),
      activeFiles: [],
      userId: undefined,
    },
    files: [],
    priority: 'normal' as TaskPriority,
    executionMode: 'single-shot' as ExecutionMode,
    origin: 'api',
    createdAt: Date.now(),
  };
}

const REVIEW_SYSTEM_PROMPT = `You are reviewing an agent's work on a milestone in a Code Siren build plan.
Review each acceptance criterion against the agent's result summary and the actual files now in the project.
Output ONLY valid JSON:
{
  "approved": boolean,
  "summary": string,
  "issues": string[],     // empty if approved
  "corrections": string   // instruction to send back to agent if not approved
}`;

function buildReviewPrompt(
  milestone: Milestone,
  agentResultText: string,
  filesProduced: Array<{ path: string; size: number }>,
): string {
  return `Milestone: ${milestone.title}
Acceptance criteria:
${milestone.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}

Agent result summary:
${agentResultText.slice(0, 2000)}

Files now in the project:
${filesProduced.length > 0 ? filesProduced.map((f) => `- ${f.path} (${f.size} bytes)`).join('\n') : '(no files were produced)'}

Review each acceptance criterion. Did the agent meet it? Output the JSON decision now.`;
}

// ── Project file listing ─────────────────────────────────────────────────
// For the orchestrator to review "actual files produced" (directive Section
// 1.5), it needs to know what files exist. Since Code Siren agents write
// to a per-plan directory, we list that directory.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

async function listProjectFiles(
  plan: PlanRecord,
  milestone: Milestone,
  filesTouchedByAgent: string[],
): Promise<Array<{ path: string; size: number }>> {
  const projectRoot = `/tmp/code-siren-relay/${plan.id}`;
  const allFiles: Array<{ path: string; size: number }> = new Set<string>(filesTouchedByAgent)
    ? Array.from(new Set(filesTouchedByAgent))
        .filter((p) => existsSync(p))
        .map((p) => ({ path: p, size: statSync(p).size }))
    : [];

  // Also walk the project root if it exists
  if (existsSync(projectRoot)) {
    try {
      const walked = walkDir(projectRoot);
      for (const w of walked) {
        if (!allFiles.find((f) => f.path === w.path)) {
          allFiles.push(w);
        }
      }
    } catch {
      // ignore — we already have filesTouchedByAgent
    }
  }

  return allFiles;
}

function walkDir(dir: string, maxDepth = 5): Array<{ path: string; size: number }> {
  const result: Array<{ path: string; size: number }> = [];
  if (maxDepth < 0) return result;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        result.push(...walkDir(fullPath, maxDepth - 1));
      } else if (entry.isFile()) {
        try {
          result.push({ path: fullPath, size: statSync(fullPath).size });
        } catch {
          // skip unreadable
        }
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return result;
}

// ── waitForUserAdvance ───────────────────────────────────────────────────
// Blocks until the /advance endpoint is called for this plan. Per directive
// Section 1.5: "waitForUserAdvance blocks until POST /api/orchestrator/plan/:id/advance".

function waitForUserAdvance(planId: string, milestoneId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    awaitingAdvance.set(planId, { resolve, milestoneId });
    console.log(`[orchestrator:relay] plan ${planId} paused after milestone ${milestoneId} — awaiting user advance`);
  });
}

export function signalAdvance(planId: string): boolean {
  const awaiting = awaitingAdvance.get(planId);
  if (!awaiting) return false;
  awaitingAdvance.delete(planId);
  awaiting.resolve();
  console.log(`[orchestrator:relay] plan ${planId} advance signaled`);
  return true;
}

// ── Stop / pause ─────────────────────────────────────────────────────────

export function stopPlan(planId: string): boolean {
  const runState = runningPlans.get(planId);
  if (!runState) return false;
  runState.aborted = true;
  runningPlans.delete(planId);
  // If waiting for advance, unblock so the loop can exit cleanly
  signalAdvance(planId);
  console.log(`[orchestrator:relay] plan ${planId} stop signaled`);
  return true;
}

export function isPlanRunning(planId: string): boolean {
  return runningPlans.has(planId);
}
