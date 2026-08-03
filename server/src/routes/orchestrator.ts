// server/src/routes/orchestrator.ts
// All Orchestrator + Agent Relay REST endpoints — directive Section 1.7.
//
//   POST /api/orchestrator/chat          Tier 1 chat (streams via WS)
//   POST /api/orchestrator/complete      Lightweight code completion (HTTP, non-streaming)
//   POST /api/orchestrator/plan          Generate plan from session history
//   POST /api/orchestrator/plan/:id/approve    Approve + start relay
//   POST /api/orchestrator/plan/:id/advance    Advance to next milestone
//   POST /api/orchestrator/plan/:id/pause      Pause between milestones
//   POST /api/orchestrator/plan/:id/stop       Stop relay entirely
//   GET  /api/orchestrator/plan/:id/status     Current relay state
//   POST /api/orchestrator/settings            Set engine + approval mode
//   GET  /api/orchestrator/settings            Get current settings
//
// Per directive Section 6: all require auth. None modify any existing
// IAgent, Ghost Mode FSM, or WS server.

import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { getOrchestratorSettings, setOrchestratorSettings, TIER1_MODELS } from '../orchestrator/settings.js';
import { listAvailableEngines, setActiveOrchestratorEngine } from '../orchestrator/engine.js';
import { generatePlan, runRelayPlan, signalAdvance, stopPlan, isPlanRunning } from '../orchestrator/relay-loop.js';
import { getPlan, listPlans, listPlansBySession, listMilestoneLogs, updatePlan } from '../orchestrator/plans-repo.js';
import { streamTier1Chat } from '../orchestrator/tier1-chat.js';
import { modelRouter } from '../orchestration/model-router.js';

export const orchestratorRouter = Router();

// ── POST /api/orchestrator/chat ──────────────────────────────────────────

const chatSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).max(8000),
});

orchestratorRouter.post('/chat', requireAuth, async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const taskId = uuid();
  // Fire and forget — the response streams back over WS as orchestrator:chunk
  // events, the same way agent:chunk events work for the existing chat flow.
  streamTier1Chat(parsed.data.sessionId, parsed.data.message, taskId).catch((err) => {
    console.error('[orchestrator:chat] stream failed:', err);
  });
  res.status(202).json({
    taskId,
    sessionId: parsed.data.sessionId,
    status: 'accepted',
    stream: `ws://localhost:${process.env.PORT ?? 3001}/ws?token=${req.headers.authorization?.slice(7) ?? ''}`,
  });
});

// ── POST /api/orchestrator/plan ──────────────────────────────────────────

const planSchema = z.object({
  sessionId: z.string().min(1),
});

orchestratorRouter.post('/plan', requireAuth, async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  try {
    const record = await generatePlan(parsed.data.sessionId);
    res.json({
      planId: record.id,
      plan: record.plan,
      engine: record.engine,
      approvalMode: record.approvalMode,
      status: record.status,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[orchestrator:plan] generation failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/orchestrator/plan/:id/approve ──────────────────────────────

const approveSchema = z.object({
  approvalMode: z.enum(['auto', 'default']).optional(),
  milestones: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    assignedAgent: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
  })).optional(),
});

orchestratorRouter.post('/plan/:id/approve', requireAuth, async (req, res) => {
  const planId = req.params.id;
  const parsed = approveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  const current = await getPlan(planId);
  if (!current) {
    res.status(404).json({ error: 'Plan not found' });
    return;
  }
  if (current.status !== 'draft' && current.status !== 'failed' && current.status !== 'stopped') {
    res.status(409).json({ error: `Plan cannot be approved from status "${current.status}"` });
    return;
  }

  // Apply any user edits to the milestone list
  let updatedPlan = current.plan;
  if (parsed.data.milestones) {
    updatedPlan = {
      ...current.plan,
      milestones: parsed.data.milestones.map((m, i) => {
        const existing = current.plan.milestones.find((x) => x.id === m.id) ?? current.plan.milestones[i];
        return {
          id: m.id,
          title: m.title ?? existing?.title ?? `Milestone ${i + 1}`,
          description: m.description ?? existing?.description ?? '',
          assignedAgent: m.assignedAgent ?? existing?.assignedAgent ?? 'architect-agent',
          dependsOn: m.dependsOn ?? existing?.dependsOn ?? [],
          acceptanceCriteria: m.acceptanceCriteria ?? existing?.acceptanceCriteria ?? [],
        };
      }),
    };
  }

  const approvalMode = parsed.data.approvalMode ?? current.approvalMode;

  // Mark as approved + kick off the relay
  await updatePlan(planId, {
    status: 'approved',
    plan: updatedPlan,
    approvalMode,
    currentMilestoneId: null,
  });

  // Fire and forget — the relay loop runs server-side as an async process.
  // The frontend follows progress via WS events (relay:milestone-start,
  // relay:milestone-complete, relay:awaiting-user, etc.).
  runRelayPlan(planId).catch((err) => {
    console.error('[orchestrator:approve] relay loop crashed:', err);
  });

  res.json({ planId, status: 'approved', message: 'Relay execution started' });
});

// ── POST /api/orchestrator/plan/:id/advance ──────────────────────────────

orchestratorRouter.post('/plan/:id/advance', requireAuth, async (req, res) => {
  const planId = req.params.id;
  const current = await getPlan(planId);
  if (!current) {
    res.status(404).json({ error: 'Plan not found' });
    return;
  }
  if (current.status !== 'awaiting-user') {
    res.status(409).json({ error: `Plan is not awaiting user input (status: ${current.status})` });
    return;
  }
  const ok = signalAdvance(planId);
  if (!ok) {
    res.status(409).json({ error: 'No pending advance for this plan' });
    return;
  }
  res.json({ planId, status: 'advancing' });
});

// ── POST /api/orchestrator/plan/:id/pause ────────────────────────────────

orchestratorRouter.post('/plan/:id/pause', requireAuth, async (req, res) => {
  const planId = req.params.id;
  const current = await getPlan(planId);
  if (!current) {
    res.status(404).json({ error: 'Plan not found' });
    return;
  }
  if (current.status !== 'running' && current.status !== 'awaiting-user') {
    res.status(409).json({ error: `Plan cannot be paused from status "${current.status}"` });
    return;
  }
  // Pause = stop the run loop AND set status to paused. The relay loop's
  // next iteration will check aborted=true and exit cleanly.
  stopPlan(planId);
  await updatePlan(planId, { status: 'paused' });
  res.json({ planId, status: 'paused' });
});

// ── POST /api/orchestrator/plan/:id/stop ─────────────────────────────────

orchestratorRouter.post('/plan/:id/stop', requireAuth, async (req, res) => {
  const planId = req.params.id;
  const current = await getPlan(planId);
  if (!current) {
    res.status(404).json({ error: 'Plan not found' });
    return;
  }
  if (current.status === 'completed' || current.status === 'failed' || current.status === 'stopped') {
    res.status(409).json({ error: `Plan already in terminal status "${current.status}"` });
    return;
  }
  stopPlan(planId);
  await updatePlan(planId, { status: 'stopped' });
  res.json({ planId, status: 'stopped' });
});

// ── GET /api/orchestrator/plan/:id/status ────────────────────────────────

orchestratorRouter.get('/plan/:id/status', requireAuth, async (req, res) => {
  const planId = req.params.id;
  const current = await getPlan(planId);
  if (!current) {
    res.status(404).json({ error: 'Plan not found' });
    return;
  }
  const logs = await listMilestoneLogs(planId);
  res.json({
    planId,
    status: current.status,
    approvalMode: current.approvalMode,
    engine: current.engine,
    currentMilestoneId: current.currentMilestoneId,
    running: isPlanRunning(planId),
    plan: current.plan,
    milestoneLogs: logs,
  });
});

// ── GET /api/orchestrator/plans ──────────────────────────────────────────
// Extra endpoint (not in directive Section 1.7 but needed for the sidebar
// "Builds" section — directive Section 2.4). Lists all plans, optionally
// filtered by session.

orchestratorRouter.get('/plans', requireAuth, async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  const plans = sessionId
    ? await listPlansBySession(sessionId)
    : await listPlans(50);
  res.json({
    plans: plans.map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      projectName: p.plan.projectName,
      summary: p.plan.summary,
      status: p.status,
      engine: p.engine,
      approvalMode: p.approvalMode,
      currentMilestoneId: p.currentMilestoneId,
      milestoneCount: p.plan.milestones.length,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  });
});

// ── GET /api/orchestrator/plan/:id ───────────────────────────────────────
// Full plan detail (for the sidebar Builds section click-through).

orchestratorRouter.get('/plan/:id', requireAuth, async (req, res) => {
  const planId = req.params.id;
  const current = await getPlan(planId);
  if (!current) {
    res.status(404).json({ error: 'Plan not found' });
    return;
  }
  const logs = await listMilestoneLogs(planId);
  res.json({
    ...current,
    milestoneLogs: logs,
  });
});

// ── POST /api/orchestrator/settings ──────────────────────────────────────

const settingsSchema = z.object({
  engine: z.enum(['gemini-flash', 'nvidia-nemotron']).optional(),
  approvalMode: z.enum(['auto', 'default']).optional(),
  tier1Model: z.string().optional(),
});

orchestratorRouter.post('/settings', requireAuth, (req, res) => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  // Validate tier1Model against the allowed list
  if (parsed.data.tier1Model && !TIER1_MODELS.find((m) => m.id === parsed.data.tier1Model)) {
    res.status(400).json({ error: `Invalid tier1Model. Allowed: ${TIER1_MODELS.map((m) => m.id).join(', ')}` });
    return;
  }
  // Validate engine availability
  if (parsed.data.engine) {
    const available = listAvailableEngines();
    const eng = available.find((e) => e.id === parsed.data.engine);
    if (!eng?.available) {
      res.status(400).json({ error: `Engine ${parsed.data.engine} not available: ${eng?.reason ?? 'unknown'}` });
      return;
    }
    setActiveOrchestratorEngine(parsed.data.engine);
  }
  const next = setOrchestratorSettings(parsed.data);
  res.json({ settings: next });
});

// ── GET /api/orchestrator/settings ───────────────────────────────────────

orchestratorRouter.get('/settings', requireAuth, (_req, res) => {
  const settings = getOrchestratorSettings();
  res.json({
    settings,
    availableEngines: listAvailableEngines(),
    tier1Models: TIER1_MODELS,
  });
});

// ── POST /api/orchestrator/complete ──────────────────────────────────────
// Lightweight code completion endpoint for Monaco's INLINE completion provider
// (ghost text, Copilot-style). FIM (Fill-In-the-Middle) prompted.
//
// Deliberately bypasses the full agent pipeline (no send(), no executeAndWait(),
// no dispatchStrategy(), no context bundle, no trace, no trust score, no WS
// broadcast). Calls modelRouter.stream() directly — the same engine selection
// (Ollama → OpenRouter → stub) but with minimal overhead.
//
// Request shape (CHIMERA Inline Completion):
//   { prefix: string, suffix: string }
//   prefix = code BEFORE the cursor (10-line window, sent by client)
//   suffix = code AFTER  the cursor (5-line window,  sent by client)
//
// The user prompt uses labeled prefix/suffix sections with a <CURSOR/> marker
// between them — the format identified in Section 0's FIM-prompting findings.
// The system prompt instructs the model to return ONLY the insertion text
// (no markdown, no explanation, no fences).
//
// Returns { text: string } in the HTTP response body (non-streaming from the
// client's perspective — the server collects the stream internally and returns
// the full result). This is what Monaco's provideInlineCompletions needs: a
// simple fetch → await → return items, no WS listener required.
//
// Hard 3s timeout — if the model hasn't finished by then, returns whatever's
// collected so far. Completions should feel instant while typing.

const completeSchema = z.object({
  prefix: z.string().max(8000),
  suffix: z.string().max(8000),
});

const COMPLETION_SYSTEM_PROMPT =
  'You are a code completion engine. The user provides code with a <CURSOR/> ' +
  'marker indicating the cursor position. The text BEFORE <CURSOR/> is the ' +
  'prefix (code already written); the text AFTER <CURSOR/> is the suffix ' +
  '(code that comes after the cursor). Return ONLY the text that should be ' +
  'inserted at the <CURSOR/> position — no explanation, no markdown fences, ' +
  'no backticks, no leading/trailing whitespace beyond what the code needs. ' +
  'Just the raw insertion text. Keep it short: a single line or statement, ' +
  'not a full function. Maximum 100 characters.';

const COMPLETION_TIMEOUT_MS = 3000;
const COMPLETION_MAX_CHARS = 200;

orchestratorRouter.post('/complete', requireAuth, async (req, res) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  // AbortController for hard timeout — if the model is slow, return what we have.
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), COMPLETION_TIMEOUT_MS);

  try {
    const chunks: string[] = [];
    let totalChars = 0;

    // Build FIM user prompt — labeled prefix/suffix with <CURSOR/> marker.
    // The labels make the structure unambiguous to the model; the <CURSOR/>
    // marker is the explicit "fill here" signal.
    const userPrompt =
      `CODE BEFORE CURSOR:\n${parsed.data.prefix}\n\n<CURSOR/>\n\n` +
      `CODE AFTER CURSOR:\n${parsed.data.suffix}`;

    // Call modelRouter.stream() DIRECTLY — no agent dispatch, no context bundle,
    // no trace, no trust score, no WS broadcast. This is the entire point of
    // this endpoint: a fast, lightweight model call for inline completions.
    const generator = modelRouter.stream({
      domain: 'ARCHITECT',
      executionMode: 'single-shot',
      agentId: 'completion',
      messages: [
        { role: 'system', content: COMPLETION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    } as any);

    for await (const chunk of generator) {
      if (abort.signal.aborted) break;

      if (chunk.delta) {
        chunks.push(chunk.delta);
        totalChars += chunk.delta.length;

        // Stop collecting after max chars — completions should be short
        if (totalChars >= COMPLETION_MAX_CHARS) break;
      }
    }

    clearTimeout(timeoutId);

    const text = chunks.join('').trim();
    res.json({ text });
  } catch (err: any) {
    clearTimeout(timeoutId);
    // Don't 500 on abort — return empty text (client treats it as no suggestion)
    if (abort.signal.aborted) {
      res.json({ text: '' });
      return;
    }
    console.error('[orchestrator:complete] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
