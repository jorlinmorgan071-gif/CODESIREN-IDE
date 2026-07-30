// server/src/routes/sandbox.ts
// Security Sandbox API — direct testing endpoint.
//   POST /api/sandbox/execute          run code in the sandbox, get result + traceId
//   POST /api/sandbox/validate-action  validate a browser action (used by Operative Agent)
//   GET  /api/sandbox/health           sandbox status
//
// Per Step 6 user condition: "build and trace the Security Sandbox as its own
// provable unit first — show it actually catching/blocking something."

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { executeInSandboxTraced, validateBrowserAction, type BrowserAction } from '../security/sandbox.js';

export const sandboxRouter = Router();

const executeSchema = z.object({
  code: z.string().min(1).max(100_000),
  memoryLimitMB: z.number().int().min(1).max(512).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
});

sandboxRouter.post('/execute', requireAuth, async (req, res) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const { result, traceId } = await executeInSandboxTraced(parsed.data.code, {
    memoryLimitMB: parsed.data.memoryLimitMB,
    timeoutMs: parsed.data.timeoutMs,
  });
  res.json({
    success: result.success,
    violation: result.violation,
    errorMessage: result.errorMessage,
    output: result.output,
    durationMs: result.durationMs,
    memoryUsedBytes: result.memoryUsedBytes,
    traceId,
  });
});

const validateActionSchema = z.object({
  action: z.object({
    type: z.enum(['navigate', 'click', 'type', 'scroll', 'screenshot', 'wait', 'evaluate']),
    url: z.string().optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    code: z.string().optional(),
    duration: z.number().optional(),
  }),
  memoryLimitMB: z.number().int().min(1).max(512).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
});

sandboxRouter.post('/validate-action', requireAuth, async (req, res) => {
  const parsed = validateActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const result = await validateBrowserAction(parsed.data.action as BrowserAction, {
    memoryLimitMB: parsed.data.memoryLimitMB,
    timeoutMs: parsed.data.timeoutMs,
  });
  res.json(result);
});

sandboxRouter.get('/health', requireAuth, (_req, res) => {
  res.json({
    sandbox: 'isolated-vm',
    version: '6.1.2',
    defaults: {
      memoryLimitMB: 32,
      timeoutMs: 30000,
    },
    blocked: ['require', 'process', 'fs', 'child_process', 'network', 'file:', 'data:', 'javascript:', 'metadata endpoints'],
  });
});
