// server/src/routes/traces.ts
// GET /api/traces                  — list recent traces (filter by agentId, executionMode, limit)
// GET /api/traces/:taskId          — get one trace by taskId
// GET /api/traces/file/preview     — preview the JSONL file path + line count
//
// Per user instruction: traces must be inspectable, not just a passing test
// assertion. This route exposes them.

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listTraces, getTrace, getTracesFile } from '../observability/traces.js';
import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

export const tracesRouter = Router();

tracesRouter.get('/', requireAuth, (req, res) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  const executionMode = typeof req.query.executionMode === 'string'
    ? (req.query.executionMode as 'single-shot' | 'react' | 'codeact')
    : undefined;
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
  const traces = listTraces({ agentId, executionMode, limit });
  res.json({ count: traces.length, traces });
});

tracesRouter.get('/file/preview', requireAuth, (_req, res) => {
  const file = getTracesFile();
  let lineCount = 0;
  let sizeBytes = 0;
  if (existsSync(file)) {
    sizeBytes = statSync(file).size;
    try {
      // wc -l is fast and reliable on the JSONL file
      const out = execSync(`wc -l < "${file}"`).toString().trim();
      lineCount = parseInt(out, 10) || 0;
    } catch {
      lineCount = -1;
    }
  }
  res.json({ file, lineCount, sizeBytes });
});

tracesRouter.get('/:taskId', requireAuth, (req, res) => {
  const trace = getTrace(req.params.taskId);
  if (!trace) {
    res.status(404).json({ error: `No trace for taskId ${req.params.taskId}` });
    return;
  }
  res.json({ trace });
});
