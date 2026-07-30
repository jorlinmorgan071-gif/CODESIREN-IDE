// server/src/routes/project-files.ts
// Test route for the writeProjectFile funnel (Fix 3 evidence).
//   POST /api/project-files/write   attempts a write through the Code Review gate

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { writeProjectFile } from '../agents/_shared/project-files.js';
import { v4 as uuid } from 'uuid';

export const projectFilesRouter = Router();

const writeSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
  agentId: z.string().default('backend-agent'),
});

projectFilesRouter.post('/write', requireAuth, async (req, res) => {
  const parsed = writeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  // Use a temp dir for test writes
  const fullPath = `/tmp/code-siren-project-files/${parsed.data.path}`;
  const traceId = uuid();
  const result = await writeProjectFile(parsed.data.agentId, fullPath, parsed.data.content, traceId);
  res.json({ ...result, traceId });
});
