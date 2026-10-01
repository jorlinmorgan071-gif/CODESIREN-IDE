// server/src/routes/orchestrator.ts
// All Orchestrator + Agent Relay REST endpoints — directive Section 1.7.
//
//   POST /api/orchestrator/chat          Tier 1 chat (streams via WS)
//   POST /api/orchestrator/complete      Lightweight code completion (HTTP, non-streaming)
//   POST /api/orchestrator/explain       Explain selected code (HTTP, non-streaming, read-only)
//   POST /api/orchestrator/vision        Analyze image/screenshot via registry-routed ModelRouter (vision-capable model)
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
import { createCapabilityChangePlan, generatePlan, runRelayPlan, signalAdvance, stopPlan, isPlanRunning } from '../orchestrator/relay-loop.js';
import { getPlan, listPlansByProject, listMilestoneLogs, updatePlan } from '../orchestrator/plans-repo.js';
import { runChatViaAgentManager } from '../orchestrator/tier1-chat.js';
import { selectNormalChatCapability } from '../orchestrator/normal-chat-capabilities.js';
import { modelRouter } from '../orchestration/model-router.js';
import type { ModelRouterRequest, ContentBlock, RouterMessage } from '../types.js';
import { listProviders, getProvider } from '../provider-registry/registry.js';
import { startDirectEditorEvidence, type DirectEditorAction } from '../orchestrator/direct-editor-evidence.js';
import { ProjectAccessError, SessionAccessError, ensureOwnedSession, resolveTenantScope } from '../tenancy/scope.js';
import { WorkspaceAccessError, resolveWorkspace, workspaceRelativePath } from '../workspace/service.js';

export const orchestratorRouter = Router();

function projectIdFromRequest(req: any): string | undefined {
  const candidate = req.method === 'GET' ? req.query?.projectId : req.body?.projectId;
  return typeof candidate === 'string' ? candidate : undefined;
}

async function resolveRouteScope(req: any, res: any, requestedProjectId?: string) {
  try {
    return await resolveTenantScope(req.user!.id, requestedProjectId);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      res.status(403).json({ error: 'Project access denied' });
      return null;
    }
    throw error;
  }
}

async function getOwnedPlan(req: any, res: any, planId: string, requestedProjectId?: string) {
  const scope = await resolveRouteScope(req, res, requestedProjectId ?? projectIdFromRequest(req));
  if (!scope) return null;
  const plan = await getPlan(planId);
  // Legacy null-project plans remain unavailable rather than being guessed into
  // a tenant after P0 ownership enforcement.
  if (!plan || plan.projectId !== scope.projectId) {
    res.status(404).json({ error: 'Plan not found' });
    return null;
  }
  return { scope, plan };
}

async function resolveDirectEditorScope(req: any, res: any, projectId: string | undefined, sessionId: string) {
  try {
    const workspace = await resolveWorkspace(req.user!.id, projectId);
    return await ensureOwnedSession(workspace, sessionId);
  } catch (error) {
    if (error instanceof ProjectAccessError || error instanceof WorkspaceAccessError || error instanceof SessionAccessError) {
      res.status(403).json({ error: 'Direct editor action scope access denied' });
      return null;
    }
    throw error;
  }
}

const directEditorScopeSchema = {
  sessionId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
};

// ── POST /api/orchestrator/chat ──────────────────────────────────────────

const chatContextSchema = z.object({
  activeFile: z.string().optional(),
  openFiles: z.array(z.string()).optional(),
  activeFileContent: z.string().optional(),
  selection: z.object({
    text: z.string(),
    startLine: z.number().int(),
    startColumn: z.number().int(),
    endLine: z.number().int(),
    endColumn: z.number().int(),
  }).optional(),
}).optional();

const chatSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(8000),
  projectId: z.string().uuid().optional(),
  context: chatContextSchema,
});

orchestratorRouter.post('/chat', requireAuth, async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  let workspace;
  try {
    workspace = await resolveWorkspace(req.user!.id, parsed.data.projectId);
  } catch (error) {
    if (error instanceof ProjectAccessError || error instanceof WorkspaceAccessError) {
      res.status(403).json({ error: 'Project access denied' });
      return;
    }
    throw error;
  }
  let sessionScope;
  try {
    sessionScope = await ensureOwnedSession(workspace, parsed.data.sessionId);
  } catch (error) {
    if (error instanceof SessionAccessError) {
      res.status(403).json({ error: 'Session access denied' });
      return;
    }
    throw error;
  }
  let activeFilePath: string | undefined;
  if (parsed.data.context?.activeFile) {
    try {
      activeFilePath = workspaceRelativePath(workspace, parsed.data.context.activeFile);
    } catch {
      activeFilePath = undefined;
    }
  }
  const capability = selectNormalChatCapability(parsed.data.message, activeFilePath);
  if (capability.kind === 'change-plan') {
    const record = await createCapabilityChangePlan(parsed.data.sessionId, workspace, parsed.data.message);
    res.status(202).json({
      sessionId: parsed.data.sessionId,
      projectId: workspace.projectId,
      status: 'plan-ready',
      capability: capability.kind,
      planId: record.id,
      plan: record.plan,
      verificationStatus: 'unverified',
    });
    return;
  }
  const taskId = uuid();
  // Route through the authoritative AgentManager lifecycle (Phase 1).
  // runChatViaAgentManager creates an AgentTask and calls
  // agentManager.executeAndWait(), which broadcasts agent:start/chunk/complete
  // WS events — ChatPanel already subscribes to these (ChatPanel.tsx:75,98,119).
  // Phase 2: pass workspace context (rootPath, activeFile, openFiles) so
  // ContextManager can assemble real project context.
  runChatViaAgentManager(
    parsed.data.sessionId,
    parsed.data.message,
    taskId,
    sessionScope,
    parsed.data.context,
    workspace,
    capability,
  ).catch((err) => {
    console.error('[orchestrator:chat] task failed:', err);
  });
  res.status(202).json({
    taskId,
    sessionId: parsed.data.sessionId,
    projectId: workspace.projectId,
    status: 'accepted',
    capability: capability.kind,
  });
});

// ── POST /api/orchestrator/plan ──────────────────────────────────────────

const planSchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().uuid().optional(),
});

orchestratorRouter.post('/plan', requireAuth, async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  try {
    const scope = await resolveRouteScope(req, res, parsed.data.projectId);
    if (!scope) return;
    const record = await generatePlan(parsed.data.sessionId, scope);
    res.json({
      planId: record.id,
      projectId: record.projectId,
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
  projectId: z.string().uuid().optional(),
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

  const owned = await getOwnedPlan(req, res, planId, parsed.data.projectId);
  if (!owned) return;
  const { scope, plan: current } = owned;
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
  runRelayPlan(planId, scope).catch((err) => {
    console.error('[orchestrator:approve] relay loop crashed:', err);
  });

  res.json({ planId, status: 'approved', message: 'Relay execution started' });
});

// ── POST /api/orchestrator/plan/:id/advance ──────────────────────────────

orchestratorRouter.post('/plan/:id/advance', requireAuth, async (req, res) => {
  const planId = req.params.id;
  const owned = await getOwnedPlan(req, res, planId);
  if (!owned) return;
  const { plan: current } = owned;
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
  const owned = await getOwnedPlan(req, res, planId);
  if (!owned) return;
  const { plan: current } = owned;
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
  const owned = await getOwnedPlan(req, res, planId);
  if (!owned) return;
  const { plan: current } = owned;
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
  const owned = await getOwnedPlan(req, res, planId);
  if (!owned) return;
  const { plan: current } = owned;
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
  const scope = await resolveRouteScope(req, res);
  if (!scope) return;
  const plans = await listPlansByProject(scope.projectId, sessionId, 50);
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
  const owned = await getOwnedPlan(req, res, planId);
  if (!owned) return;
  const { plan: current } = owned;
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
// no dispatchStrategy(), no context bundle, no trust score, no WS broadcast).
// It calls modelRouter.stream() directly for minimal overhead while emitting a
// tenant-scoped direct-editor evidence trace.
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
  ...directEditorScopeSchema,
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

  const scope = await resolveDirectEditorScope(req, res, parsed.data.projectId, parsed.data.sessionId);
  if (!scope) return;

  // AbortController for hard timeout — if the model is slow, return what we have.
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), COMPLETION_TIMEOUT_MS);
  const userPrompt =
    `CODE BEFORE CURSOR:\n${parsed.data.prefix}\n\n<CURSOR/>\n\n` +
    `CODE AFTER CURSOR:\n${parsed.data.suffix}`;
  const routerRequest = {
    domain: 'ARCHITECT',
    executionMode: 'single-shot',
    agentId: 'completion',
    messages: [
      { role: 'system', content: COMPLETION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    // UPR Phase 1 Step 2b — pass the AbortSignal so withRetry caps total
    // retry time at the remaining budget. Without this, a 503 would retry
    // for 2s+4s+8s=14s, silently extending past the 3s budget by 11s.
    signal: abort.signal,
  } as ModelRouterRequest;
  const evidenceRun = startDirectEditorEvidence({
    action: 'completion',
    scope,
    provider: modelRouter.getSelectedEngineId(routerRequest),
    inputs: {
      fields: ['prefix', 'suffix'],
      characterCounts: { prefix: parsed.data.prefix.length, suffix: parsed.data.suffix.length },
    },
  });

  try {
    const chunks: string[] = [];
    let totalChars = 0;

    // Call modelRouter.stream() DIRECTLY — no agent dispatch, no context bundle,
    // no trace, no trust score, no WS broadcast. This is the entire point of
    // this endpoint: a fast, lightweight model call for inline completions.
    const generator = modelRouter.stream(routerRequest);

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
    res.json({ text, evidence: abort.signal.aborted ? evidenceRun.timeout(text.length) : evidenceRun.succeed(text.length) });
  } catch (err: any) {
    clearTimeout(timeoutId);
    // Don't 500 on abort — return empty text (client treats it as no suggestion)
    if (abort.signal.aborted) {
      res.json({ text: '', evidence: evidenceRun.timeout(0) });
      return;
    }
    console.error('[orchestrator:complete] error:', err.message);
    res.status(500).json({ error: err.message, evidence: evidenceRun.fail() });
  }
});

// ── POST /api/orchestrator/explain ──────────────────────────────────────
// Phase B: Editor Actions — "Explain" selected code.
//
// Mirrors /complete's lightweight modelRouter.stream() pattern: no agent
// dispatch or context bundle, but a tenant-scoped direct-editor evidence trace.
// Read-only — no writes and no apply gate.
//
// Request:  { code: string, language?: string }
// Response: { explanation: string }
//
// The system prompt instructs the model to explain the code clearly and
// concisely — what it does, how it works, any notable patterns or gotchas.
// Hard 10s timeout (longer than completion — explanations can be longer).

const explainSchema = z.object({
  code: z.string().min(1).max(20000),
  language: z.string().max(50).optional(),
  ...directEditorScopeSchema,
});

const EXPLAIN_SYSTEM_PROMPT =
  'You are a code explanation engine. The user provides a code snippet. ' +
  'Explain what the code does, how it works, and any notable patterns, ' +
  'gotchas, or best practices relevant to it. Be clear and concise — ' +
  '2-4 short paragraphs, no markdown headings, no code fences in the ' +
  'explanation itself. Plain text only.';

const EXPLAIN_TIMEOUT_MS = 10_000;

orchestratorRouter.post('/explain', requireAuth, async (req, res) => {
  const parsed = explainSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  const { code, language } = parsed.data;
  const scope = await resolveDirectEditorScope(req, res, parsed.data.projectId, parsed.data.sessionId);
  if (!scope) return;

  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), EXPLAIN_TIMEOUT_MS);
  const userPrompt = language
    ? `Explain this ${language} code:\n\n${code}`
    : `Explain this code:\n\n${code}`;
  const routerRequest = {
    domain: 'ARCHITECT',
    executionMode: 'single-shot',
    agentId: 'explain',
    messages: [
      { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    // UPR Phase 1 Step 2b — pass the AbortSignal so withRetry caps at 10s budget.
    signal: abort.signal,
  } as ModelRouterRequest;
  const evidenceRun = startDirectEditorEvidence({
    action: 'explain',
    scope,
    provider: modelRouter.getSelectedEngineId(routerRequest),
    inputs: { fields: ['code', ...(language ? ['language'] : [])], characterCounts: { code: code.length }, language },
  });

  try {
    const chunks: string[] = [];
    const generator = modelRouter.stream(routerRequest);

    for await (const chunk of generator) {
      if (abort.signal.aborted) break;
      if (chunk.delta) {
        chunks.push(chunk.delta);
      }
    }

    clearTimeout(timeoutId);

    const explanation = chunks.join('').trim();
    res.json({ explanation, evidence: abort.signal.aborted ? evidenceRun.timeout(explanation.length) : evidenceRun.succeed(explanation.length) });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (abort.signal.aborted) {
      res.json({ explanation: '', evidence: evidenceRun.timeout(0) });
      return;
    }
    console.error('[orchestrator:explain] error:', err.message);
    res.status(500).json({ error: err.message, evidence: evidenceRun.fail() });
  }
});

// ── POST /api/orchestrator/refactor ─────────────────────────────────────
// Phase B: Editor Actions — Edit-family (refactor/document/optimize/convert).
//
// Same lightweight pattern as /complete and /explain: direct modelRouter.stream(),
// no agent dispatch or context bundle, but a tenant-scoped evidence trace. No
// writeProjectFile() gate — model output remains a proposed edit until the
// existing transaction approval path applies it to disk.
//
// Request:
//   { code: string, mode: 'refactor'|'document'|'optimize'|'convert',
//     instruction?: string, targetLanguage?: string }
// Response:
//   { result: string }
//
// Different system prompt per mode. Single shared endpoint. The client shows
// a diff preview and the user must Accept (executeEdits) or Reject.

const refactorSchema = z.object({
  code: z.string().min(1).max(20000),
  mode: z.enum(['refactor', 'document', 'optimize', 'convert']),
  instruction: z.string().max(2000).optional(),
  targetLanguage: z.string().max(50).optional(),
  ...directEditorScopeSchema,
});

const REFACTOR_TIMEOUT_MS = 15_000;

const REFACTOR_SYSTEM_PROMPTS: Record<string, string> = {
  refactor:
    'You are a code refactoring engine. The user provides a code snippet. ' +
    'Refactor it for clarity, readability, and maintainability — without changing ' +
    'its behavior. Return ONLY the refactored code. No explanation, no markdown ' +
    'fences, no backticks. Just the raw code.',
  document:
    'You are a code documentation engine. The user provides a code snippet. ' +
    'Add clear, concise JSDoc/TSDoc comments and inline comments where helpful. ' +
    'Do NOT change the code logic — only add documentation. Return ONLY the ' +
    'documented code. No explanation, no markdown fences. Just the raw code.',
  optimize:
    'You are a code optimization engine. The user provides a code snippet. ' +
    'Optimize it for performance — reduce complexity, eliminate waste, improve ' +
    'efficiency — without changing its external behavior. Return ONLY the ' +
    'optimized code. No explanation, no markdown fences. Just the raw code.',
  convert:
    'You are a code conversion engine. The user provides a code snippet in one ' +
    'language and wants it converted to another. Return ONLY the converted code. ' +
    'No explanation, no markdown fences. Just the raw code.',
};

orchestratorRouter.post('/refactor', requireAuth, async (req, res) => {
  const parsed = refactorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  const { code, mode, instruction, targetLanguage } = parsed.data;
  const scope = await resolveDirectEditorScope(req, res, parsed.data.projectId, parsed.data.sessionId);
  if (!scope) return;

  const systemPrompt = REFACTOR_SYSTEM_PROMPTS[mode];
  let userPrompt: string;
  if (mode === 'convert' && targetLanguage) {
    userPrompt = `Convert this code to ${targetLanguage}:\n\n${code}`;
  } else if (instruction) {
    userPrompt = `${instruction}\n\nCode:\n${code}`;
  } else {
    userPrompt = `Code:\n\n${code}`;
  }

  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), REFACTOR_TIMEOUT_MS);
  const routerRequest = {
    domain: 'ARCHITECT',
    executionMode: 'single-shot',
    agentId: `refactor-${mode}`,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    // UPR Phase 1 Step 2b — pass the AbortSignal so withRetry caps at 15s budget.
    signal: abort.signal,
  } as ModelRouterRequest;
  const evidenceRun = startDirectEditorEvidence({
    action: mode as DirectEditorAction,
    scope,
    provider: modelRouter.getSelectedEngineId(routerRequest),
    inputs: {
      fields: ['code', 'mode', ...(instruction ? ['instruction'] : []), ...(targetLanguage ? ['targetLanguage'] : [])],
      characterCounts: { code: code.length, ...(instruction ? { instruction: instruction.length } : {}), ...(targetLanguage ? { targetLanguage: targetLanguage.length } : {}) },
      mode,
    },
  });

  try {
    const chunks: string[] = [];
    const generator = modelRouter.stream(routerRequest);

    for await (const chunk of generator) {
      if (abort.signal.aborted) break;
      if (chunk.delta) {
        chunks.push(chunk.delta);
      }
    }

    clearTimeout(timeoutId);

    const result = chunks.join('').trim();
    res.json({ result, evidence: abort.signal.aborted ? evidenceRun.timeout(result.length) : evidenceRun.succeed(result.length) });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (abort.signal.aborted) {
      res.json({ result: '', evidence: evidenceRun.timeout(0) });
      return;
    }
    console.error('[orchestrator:refactor] error:', err.message);
    res.status(500).json({ error: err.message, evidence: evidenceRun.fail() });
  }
});

// ── POST /api/orchestrator/vision ───────────────────────────────────────
// Phase 3+ — Image/screenshot analysis via the registry-routed ModelRouter.
//
// REPLACES the old z-ai SDK call. Now routes through whichever
// configured provider's selected model actually reports vision support —
// the same way text chat routes through the ModelRouter.
//
// Vision-capable providers are identified by the `supportsVision` flag on
// their loaded models (populated by Phase 1's "Test & load models"). The
// route finds the first vision-capable model across all LLM providers and
// uses it. If no provider has a vision-capable model, the route fails with
// a clear, specific message listing which providers/models would need to
// be configured.
//
// PRIVACY (hard requirement, not nice-to-have):
//   - Image content is NEVER logged (console.log, traces, memory beyond request)
//   - The image base64 is passed to the model + then goes out of scope
//   - Only the text response is returned to the client
//   - No image retention of any kind

const visionSchema = z.object({
  image: z.string().min(1).max(5_000_000), // max ~5MB base64
  prompt: z.string().min(1).max(2000),
  ...directEditorScopeSchema,
});

const VISION_TIMEOUT_MS = 20_000;

/**
 * Find a vision-capable model from the ProviderRegistry.
 * Returns the provider entry + model, or null if none found.
 */
function findVisionCapableModel(): { providerId: string; providerName: string; modelId: string; modelName: string; engine: 'openrouter' | 'anthropic' } | null {
  const providers = listProviders().filter((p) => p.category === 'llm' && p.connectionTested);
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.supportsVision) {
        const engine = provider.id === 'anthropic' ? 'anthropic' : 'openrouter';
        return {
          providerId: provider.id,
          providerName: provider.displayName,
          modelId: model.id,
          modelName: model.name,
          engine,
        };
      }
    }
  }
  return null;
}

orchestratorRouter.post('/vision', requireAuth, async (req, res) => {
  const parsed = visionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  const { image, prompt } = parsed.data;
  const scope = await resolveDirectEditorScope(req, res, parsed.data.projectId, parsed.data.sessionId);
  if (!scope) return;

  // ── Find a vision-capable provider ──────────────────────────────────
  const visionModel = findVisionCapableModel();

  if (!visionModel) {
    // No vision-capable provider configured — fail with a clear, specific message.
    const providers = listProviders().filter((p) => p.category === 'llm');
    const providerNames = providers.map((p) => p.displayName).join(', ') || '(none configured)';
    const testedProviders = providers.filter((p) => p.connectionTested).map((p) => p.displayName).join(', ') || '(none tested)';

    const errorMsg = `No vision-capable model is configured. To use image analysis, you need a model that supports vision (image input).

Current Model API providers: ${providerNames}
Tested + loaded: ${testedProviders}

To fix this:
1. Open Settings → API Hub → Model API
2. Click "Test & load" on OpenRouter or Anthropic (if not already done)
3. Make sure the loaded models include vision-capable ones (look for the "Vision" badge)

Vision-capable models include:
- OpenRouter: models with vision modality (e.g. gpt-4o, claude-3.5-sonnet)
- Anthropic: all Claude 3+ and Claude 4+ models support vision`;

    const evidenceRun = startDirectEditorEvidence({
      action: 'vision',
      scope,
      provider: 'none-configured',
      inputs: {
        fields: ['image', 'prompt'],
        characterCounts: { image: image.length, prompt: prompt.length },
        imageRetained: false,
      },
    });
    res.status(503).json({ error: errorMsg, evidence: evidenceRun.fail() });
    return;
  }

  const evidenceRun = startDirectEditorEvidence({
    action: 'vision',
    scope,
    provider: visionModel.providerId,
    inputs: {
      fields: ['image', 'prompt'],
      characterCounts: { image: image.length, prompt: prompt.length },
      imageRetained: false,
    },
  });

  // Ensure the image is a data URI
  let dataUri = image;
  if (!dataUri.startsWith('data:')) {
    dataUri = `data:image/png;base64,${image}`;
  }

  try {
    // PRIVACY: do NOT log the image data. Log only metadata.
    console.log(`[orchestrator:vision] analyzing image (${Math.round(dataUri.length / 1024)}KB) via ${visionModel.providerName} / ${visionModel.modelName} with prompt: "${prompt.slice(0, 80)}"`);

    // Build the vision request using content blocks (text + image)
    const contentBlocks: ContentBlock[] = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: dataUri } },
    ];

    const routerRequest: ModelRouterRequest = {
      agentId: 'vision-analysis',
      domain: 'REVIEW',  // REVIEW domain picks Claude/architecture models
      messages: [
        {
          role: 'user',
          content: contentBlocks,
        },
      ] as RouterMessage[],
      executionMode: 'single-shot',
      maxTokens: 1024,
      temperature: 0.3,
      engine: visionModel.engine,
    };

    // Stream through the ModelRouter — same path as /complete, /explain, /refactor
    const generator = modelRouter.stream(routerRequest);
    let analysis = '';
    for await (const chunk of generator) {
      if (chunk.delta) analysis += chunk.delta;
      if (chunk.done) break;
    }

    // PRIVACY: the image dataUri goes out of scope here — no retention
    const output = analysis.trim() || '(no analysis returned)';
    res.json({ analysis: output, evidence: evidenceRun.succeed(output.length) });
  } catch (err: any) {
    // PRIVACY: strip any base64 data from error messages before logging.
    const rawError = err?.message ?? 'Vision analysis failed';
    const safeError = rawError
      .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '(image data redacted)')
      .replace(/[A-Za-z0-9+/=]{50,}/g, '(base64 redacted)')
      .slice(0, 200);
    console.error('[orchestrator:vision] error:', safeError);
    res.status(500).json({ error: safeError, evidence: evidenceRun.fail() });
  }
});
