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
