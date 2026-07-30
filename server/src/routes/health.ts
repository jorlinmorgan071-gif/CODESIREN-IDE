// server/src/routes/health.ts

import { Router } from 'express';
import { isDbAvailable } from '../db/client.js';
import { agentManager } from '../orchestration/agent-manager.js';
import { ghostMode } from '../orchestration/ghost-mode.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    db: isDbAvailable() ? 'connected' : 'degraded-in-memory',
    agents: agentManager.list().map((a) => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      trustScore: a.trustScore,
      status: a.status,
      acceptsSkills: a.acceptsSkills,
      skillsCount: a.skills.length,
    })),
    ghost: {
      state: ghostMode.currentState,
      level: ghostMode.currentLevel,
    },
  });
});
