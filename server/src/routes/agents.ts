// server/src/routes/agents.ts
// POST /api/agents/:agentId/send — single entry point for invoking any agent.
// Typed chat → here. Voice transcript → here. (Later) gesture-mapped command → here.

import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { agentManager } from '../orchestration/agent-manager.js';
import { makeEvent, broadcast } from '../ws/events.js';
import type { AgentTask, ExecutionMode, TaskPriority, TaskType } from '../types.js';
import { ProjectAccessError, SessionAccessError, ensureOwnedSession, resolveTenantScope } from '../tenancy/scope.js';

export const agentsRouter = Router();

const sendSchema = z.object({
  description: z.string().min(1).max(8000),
  type: z.enum(['chat', 'code-gen', 'code-review', 'plan', 'research', 'test', 'deploy', 'fabricate-cad', 'fabricate-print', 'slice', 'discover', 'browse', 'device-command', 'monitor', 'recall', 'custom']).default('chat'),
  executionMode: z.enum(['single-shot', 'react', 'codeact']).default('single-shot'),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  projectId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  files: z.array(z.string()).optional(),
  // origin: 'chat' (typed), 'voice' (spoken), 'gesture' (gesture-mapped), 'api' (direct)
  origin: z.enum(['chat', 'voice', 'gesture', 'api']).default('chat'),
});

agentsRouter.post('/:agentId/send', requireAuth, async (req, res) => {
  const { agentId } = req.params;
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  if (agentId === 'sentinel-agent') {
    res.status(503).json({ error: 'Sentinel Agent is unavailable until watch ownership is implemented' });
    return;
  }

  const agent = agentManager.get(agentId);
  if (!agent) {
    res.status(404).json({ error: `Unknown agent: ${agentId}` });
    return;
  }

  let scope;
  try {
    scope = await resolveTenantScope(req.user!.id, parsed.data.projectId);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      res.status(403).json({ error: 'Project access denied' });
      return;
    }
    throw error;
  }

  const projectId = scope.projectId;
  const sessionId = parsed.data.sessionId ?? uuid();
  try {
    await ensureOwnedSession(scope, sessionId);
  } catch (error) {
    if (error instanceof SessionAccessError) {
      res.status(403).json({ error: 'Session access denied' });
      return;
    }
    throw error;
  }

  const task: AgentTask = {
    id: uuid(),
    projectId,
    sessionId,
    agentId,
    type: parsed.data.type as TaskType,
    description: parsed.data.description,
    context: {
      projectId,
      rootPath: '/tmp/code-siren-step-0',
      techStack: {},
      activeFiles: parsed.data.files ?? [],
      // Approval-gate fix: pass the requesting user's ID through the task
      // context so side-effect-capable agents (Terminal, Operative,
      // Fabrication) can tag their ghostMode.findings with userId. The
      // approval endpoint verifies req.user.id matches finding.userId
      // before transitioning state — this is how we enforce that the
      // user who approves is the user who requested.
      userId: scope.userId,
    },
    files: parsed.data.files,
    priority: parsed.data.priority as TaskPriority,
    executionMode: parsed.data.executionMode as ExecutionMode,
    origin: parsed.data.origin,
    createdAt: Date.now(),
  };

  // Fire and forget — chunks flow back over WS as agent:* events.
  // Client receives them by taskId (filtered on the WS sink in lib/ws.ts).
  agentManager.send(task).catch((err) => {
    console.error(`[agents] send failed for ${agentId}/${task.id}:`, err);
  });

  res.status(202).json({
    taskId: task.id,
    agentId,
    status: 'accepted',
    origin: task.origin,
    // Return the full task shape so callers can compare typed vs voice tasks
    taskShape: {
      id: task.id,
      projectId: task.projectId,
      sessionId: task.sessionId,
      agentId: task.agentId,
      type: task.type,
      description: task.description,
      executionMode: task.executionMode,
      priority: task.priority,
      origin: task.origin,
      createdAt: task.createdAt,
    },
    projectId,
  });
});

agentsRouter.get('/', requireAuth, (_req, res) => {
  res.json({
    agents: agentManager.list().map((a) => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      icon: a.icon,
      color: a.color,
      trustScore: a.trustScore,
      status: a.status,
    })),
  });
});

// POST /api/agents/meeting — AI Meeting Room.
// Additive route (no existing routes touched). Surfaces a synchronous
// meeting result derived from current agent state so the AgentPanel
// "Open Meeting Room" button has a real, visible response. The meeting
// picks the top 5 agents by trust score, simulates a brief deliberation,
// emits a meeting:start → meeting:proposal × N → meeting:decision event
// sequence over the WS bus (matches the existing event types in types.ts),
// and returns the structured result to the caller.
const meetingSchema = z.object({
  topic: z.string().min(1).max(2000).default('Coordinate next iteration'),
  quorum: z.number().int().min(1).max(20).default(3),
  projectId: z.string().uuid().optional(),
});

agentsRouter.post('/meeting', requireAuth, async (req, res) => {
  const parsed = meetingSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  const { topic, quorum } = parsed.data;
  let scope;
  try {
    scope = await resolveTenantScope(req.user!.id, parsed.data.projectId);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      res.status(403).json({ error: 'Project access denied' });
      return;
    }
    throw error;
  }
  const allAgents = agentManager.list();
  if (allAgents.length === 0) {
    res.status(503).json({ error: 'No agents registered' });
    return;
  }

  // Pick participants: top N by trustScore, ties broken by id for stability.
  const participants = [...allAgents]
    .sort((a, b) => b.trustScore - a.trustScore || a.id.localeCompare(b.id))
    .slice(0, Math.min(5, allAgents.length));

  const meetingId = `mtg-${uuid()}`;
  const ts = Date.now();

  // meeting:start — opening of the deliberation
  broadcast(makeEvent('meeting:start' as any, {
    meetingId,
    topic,
    participants: participants.map((a) => a.id),
    ts,
  }, scope));

  // Each participant emits a brief proposal — a single deterministic
  // recommendation string derived from the agent's domain. No LLM call,
  // no side effects; this is a UI demonstration of the meeting bus so
  // the "Open Meeting Room" button produces a visible, structured result.
  const proposals = participants.map((a, i) => {
    const proposalText = `[${a.domain}] Recommend: ${topic} — proceed with focus on ${a.domain.toLowerCase()} concerns.`;
    const vote = a.trustScore > 0.85 ? 'approve' : a.trustScore > 0.6 ? 'abstain' : 'reject';
    const eventTs = ts + (i + 1) * 10;
    broadcast(makeEvent('meeting:proposal' as any, {
      meetingId,
      from: a.id,
      to: participants.map((p) => p.id).filter((id) => id !== a.id),
      type: 'proposal',
      payload: { text: proposalText, vote, trustScore: a.trustScore },
      ts: eventTs,
    }, scope));
    return {
      agentId: a.id,
      agentName: a.name,
      domain: a.domain,
      color: a.color,
      trustScore: Math.round(a.trustScore * 100),
      text: proposalText,
      vote,
    };
  });

  // Tally votes and emit the decision.
  const approveCount = proposals.filter((p) => p.vote === 'approve').length;
  const abstainCount = proposals.filter((p) => p.vote === 'abstain').length;
  const rejectCount = proposals.filter((p) => p.vote === 'reject').length;
  const decision =
    approveCount >= quorum ? 'approved' : rejectCount > approveCount ? 'rejected' : 'inconclusive';

  broadcast(makeEvent('meeting:decision' as any, {
    meetingId,
    decision,
    tally: { approve: approveCount, abstain: abstainCount, reject: rejectCount },
    ts: ts + (participants.length + 1) * 10,
  }, scope));

  res.json({
    meetingId,
    topic,
    decision,
    tally: { approve: approveCount, abstain: abstainCount, reject: rejectCount },
    quorum,
    participants: participants.map((a) => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      color: a.color,
      trustScore: Math.round(a.trustScore * 100),
    })),
    proposals,
    startedAt: ts,
    completedAt: Date.now(),
  });
});
