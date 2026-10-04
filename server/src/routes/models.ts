// server/src/routes/models.ts
// Model management API — Ollama model listing + selection.
//   GET  /api/models/ollama           list available Ollama models (+ availability status)
//   POST /api/models/ollama/start     start ollama serve if it's not running
//   POST /api/models/ollama/stop      stop ollama serve (if we started it)
//   GET  /api/models/active           get the active model for each agent
//   POST /api/models/active           set the active model (global default or per-agent)
//   GET  /api/models/engines          list available engines (ollama, openrouter, stub)

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  checkOllamaAvailable,
  startOllamaServe,
  stopOllamaServe,
  getActiveOllamaModel,
  setActiveOllamaModel,
  getAgentModel,
  setAgentModel,
  clearAgentModel,
  getAllAgentModels,
} from '../orchestration/engines/ollama.js';
import { config } from '../config.js';
import {
  getRoutingConfig,
  setRoutingMode,
  setOneProvider,
  setAgentAssignment,
  getRoutingForAgent,
  canEnableMixedMode,
  computeAutoFreeAssignments,
  getConfiguredLLMProviders,
  inferTaskType,
  type RoutingMode,
} from '../orchestration/agent-routing.js';

export const modelsRouter = Router();

// ── Ollama model listing ─────────────────────────────────────────────────

modelsRouter.get('/ollama', requireAuth, async (_req, res) => {
  const check = await checkOllamaAvailable();
  res.json({
    available: check.available,
    models: check.models,
    error: check.error,
    host: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    activeModel: getActiveOllamaModel(),
  });
});

// ── Start/stop ollama serve ──────────────────────────────────────────────

modelsRouter.post('/ollama/start', requireAuth, async (_req, res) => {
  // First check if it's already running
  const check = await checkOllamaAvailable();
  if (check.available) {
    res.json({ started: true, alreadyRunning: true, models: check.models });
    return;
  }
  // Try to start it
  const result = await startOllamaServe();
  if (result.started) {
    const recheck = await checkOllamaAvailable();
    res.json({ started: true, alreadyRunning: false, models: recheck.models });
  } else {
    res.status(503).json({ started: false, error: result.error });
  }
});

modelsRouter.post('/ollama/stop', requireAuth, (_req, res) => {
  stopOllamaServe();
  res.json({ stopped: true });
});

// ── Active model management ──────────────────────────────────────────────

modelsRouter.get('/active', requireAuth, (_req, res) => {
  res.json({
    models: getAllAgentModels(),
    engines: {
      ollama: { available: true, defaultModel: getActiveOllamaModel() },
      openrouter: { available: !!config.OPENROUTER_API_KEY },
      openai: { available: !!config.OPENAI_API_KEY },
      anthropic: { available: !!config.ANTHROPIC_API_KEY },
      stub: { available: true },
    },
  });
});

const setActiveSchema = z.object({
  model: z.string().optional(),        // global default model
  agentId: z.string().optional(),      // if set, override for this specific agent
  clearAgent: z.boolean().optional(),  // if true, clear the per-agent override
});

modelsRouter.post('/active', requireAuth, (req, res) => {
  const parsed = setActiveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  if (parsed.data.clearAgent && parsed.data.agentId) {
    clearAgentModel(parsed.data.agentId);
    res.json({ cleared: true, agentId: parsed.data.agentId, models: getAllAgentModels() });
    return;
  }

  if (parsed.data.agentId && parsed.data.model) {
    setAgentModel(parsed.data.agentId, parsed.data.model);
    res.json({ set: true, agentId: parsed.data.agentId, model: parsed.data.model, models: getAllAgentModels() });
    return;
  }

  if (parsed.data.model) {
    setActiveOllamaModel(parsed.data.model);
    res.json({ set: true, model: parsed.data.model, models: getAllAgentModels() });
    return;
  }

  res.status(400).json({ error: 'Provide `model` and optionally `agentId`' });
});

// ── Engine listing ───────────────────────────────────────────────────────

modelsRouter.get('/engines', requireAuth, async (_req, res) => {
  const ollamaCheck = await checkOllamaAvailable();
  res.json({
    engines: [
      {
        id: 'ollama',
        name: 'Ollama (Local)',
        available: ollamaCheck.available,
        models: ollamaCheck.models.map(m => m.name),
        activeModel: getActiveOllamaModel(),
        autoStart: true,
      },
      {
        id: 'openrouter',
        name: 'OpenRouter (Cloud)',
        available: !!config.OPENROUTER_API_KEY,
        models: [], // OpenRouter has 100+ models, not listed here
      },
      {
        id: 'openai',
        name: 'OpenAI (Cloud)',
        available: !!config.OPENAI_API_KEY,
      },
      {
        id: 'anthropic',
        name: 'Anthropic (Cloud)',
        available: !!config.ANTHROPIC_API_KEY,
      },
      {
        id: 'stub',
        name: 'Stub (No LLM)',
        available: true,
      },
    ],
    preferredEngine: ollamaCheck.available ? 'ollama' : (config.OPENROUTER_API_KEY ? 'openrouter' : 'stub'),
  });
});

// ── UPR Phase 4 — Agent Routing ─────────────────────────────────────────
//   GET  /api/models/routing              get current routing config + assignments
//   POST /api/models/routing/mode         set routing mode (one-provider / mixed-provider / auto-free)
//   POST /api/models/routing/one-provider set the One Provider assignment
//   POST /api/models/routing/agent        set a per-agent assignment (Mixed mode)
//   GET  /api/models/routing/auto-free    compute + preview Auto Free assignments
//   GET  /api/models/routing/agents       list all agents + their inferred task types

modelsRouter.get('/routing', requireAuth, (_req, res) => {
  const config = getRoutingConfig();
  const providers = getConfiguredLLMProviders().map(p => ({
    id: p.id,
    displayName: p.displayName,
    modelCount: p.models.length,
    freeModelCount: p.models.filter(m => m.costTier === 'free').length,
  }));
  res.json({ config, providers });
});

const setModeSchema = z.object({ mode: z.enum(['one-provider', 'mixed-provider', 'auto-free']) });

modelsRouter.post('/routing/mode', requireAuth, (req, res) => {
  const parsed = setModeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid mode', issues: parsed.error.issues });
    return;
  }
  const result = setRoutingMode(parsed.data.mode as RoutingMode);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({
    success: true,
    config: result.config,
    shortfalls: result.shortfalls ?? [],
  });
});

const setOneProviderSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

modelsRouter.post('/routing/one-provider', requireAuth, (req, res) => {
  const parsed = setOneProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  setOneProvider(parsed.data.providerId, parsed.data.modelId);
  res.json({ success: true });
});

const setAgentAssignmentSchema = z.object({
  agentId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

modelsRouter.post('/routing/agent', requireAuth, (req, res) => {
  const parsed = setAgentAssignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  setAgentAssignment(parsed.data.agentId, parsed.data.providerId, parsed.data.modelId);
  res.json({ success: true });
});

modelsRouter.get('/routing/auto-free', requireAuth, (_req, res) => {
  const { assignments, shortfalls } = computeAutoFreeAssignments();
  const providers = getConfiguredLLMProviders();
  const freeModels = providers.flatMap(p =>
    p.models.filter(m => m.costTier === 'free').map(m => ({
      providerId: p.id,
      providerName: p.displayName,
      modelId: m.id,
      modelName: m.name,
      contextWindow: m.contextWindow,
      supportsToolUse: m.supportsToolUse,
    }))
  );
  res.json({ assignments, shortfalls, freeModels, providerCount: providers.length });
});

modelsRouter.get('/routing/agents', requireAuth, (_req, res) => {
  const agents = Object.entries({
    'architect-agent': 'ARCHITECT',
    'backend-agent': 'BACKEND',
    'code-review-agent': 'REVIEW',
    'database-agent': 'DATABASE',
    'deployment-agent': 'DEPLOYMENT',
    'devops-agent': 'DEVOPS',
    'documentation-agent': 'DOCUMENTATION',
    'extension-agent': 'EXTENSION',
    'fabrication-agent': 'FABRICATION',
    'frontend-agent': 'FRONTEND',
    'memory-agent': 'MEMORY',
    'operative-agent': 'OPERATIVE',
    'performance-agent': 'PERFORMANCE',
    'prompt-engineer-agent': 'PROMPT',
    'qa-tester-agent': 'QA',
    'research-agent': 'RESEARCH',
    'security-agent': 'SECURITY',
    'sentinel-agent': 'SENTINEL',
    'terminal-agent': 'TERMINAL',
    'ui-designer-agent': 'DESIGN',
  }).map(([agentId, domain]) => ({
    agentId,
    domain,
    taskType: inferTaskType(agentId),
    routing: getRoutingForAgent(agentId),
  }));
  res.json({ agents });
});

// ── UPR Phase 5 — Image Generation ──────────────────────────────────────
//   GET  /api/models/image-gen/toggle  get the approval toggle state
//   POST /api/models/image-gen/toggle  set the approval toggle
//   POST /api/models/image-gen/generate  generate an image (direct API call)

import {
  getImageGenerationApprovalToggle,
  setImageGenerationApprovalToggle,
  generateImage,
  findImageProvider,
} from '../orchestration/image-generation.js';

modelsRouter.get('/image-gen/toggle', requireAuth, (_req, res) => {
  res.json({ allowEveryRequest: getImageGenerationApprovalToggle() });
});

modelsRouter.post('/image-gen/toggle', requireAuth, (req, res) => {
  const enabled = req.body?.allowEveryRequest;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'Missing boolean "allowEveryRequest" in body' });
    return;
  }
  setImageGenerationApprovalToggle(enabled);
  res.json({ success: true, allowEveryRequest: enabled });
});

const imageGenSchema = z.object({
  prompt: z.string().min(1).max(4000),
  modelId: z.string().optional(),
  size: z.string().optional(),
});

modelsRouter.post('/image-gen/generate', requireAuth, async (req, res) => {
  const parsed = imageGenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  const result = await generateImage({
    prompt: parsed.data.prompt,
    modelId: parsed.data.modelId,
    size: parsed.data.size,
  });

  if (!result.success) {
    // Honest failure: 503 if no provider configured, 500 for API errors
    const status = result.error?.includes('No image/video provider') ? 503 : 500;
    res.status(status).json({ error: result.error, provider: result.provider });
    return;
  }

  res.json({
    success: true,
    imageBase64: result.imageBase64,
    imageUrl: result.imageUrl,
    format: result.format,
    model: result.model,
    provider: result.provider,
  });
});
