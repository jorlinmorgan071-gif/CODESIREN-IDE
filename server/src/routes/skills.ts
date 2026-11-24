// server/src/routes/skills.ts
// Skills Vault API — directive Section 6.
//   POST   /api/skills/install          install a skill from TOML (or install sample)
//   GET    /api/skills                  list installed skills
//   POST   /api/skills/:name/invoke     invoke a skill by name with input context
//   DELETE /api/skills/:name            uninstall a skill
//   POST   /api/skills/discover         mine runs.jsonl for recurring tool sequences
//
// All routes use requireAuth. All actions are also available through the
// Skills Vault Agent via AgentManager.send() — the route is a thin convenience layer.

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { agentManager } from '../orchestration/agent-manager.js';
import { ExtensionAgent, type ExtensionAction } from '../agents/extension/index.js';

export const skillsRouter = Router();

// Cache the Skills Vault Agent instance lookup. Its stable internal ID remains
// `extension-agent` for persisted orchestration compatibility.
function getExtensionAgent(): ExtensionAgent | null {
  const agent = agentManager.get('extension-agent');
  return agent instanceof ExtensionAgent ? agent : null;
}

const installSchema = z.object({
  toml: z.string().optional(),
  installSample: z.boolean().optional(),
  publicKeyHex: z.string().optional(),
});

skillsRouter.post('/install', requireAuth, async (req, res) => {
  const parsed = installSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const ext = getExtensionAgent();
  if (!ext) {
    res.status(503).json({ error: 'Skills Vault Agent not registered' });
    return;
  }
  let action: ExtensionAction;
  if (parsed.data.installSample) {
    action = { kind: 'install-sample' };
  } else if (parsed.data.toml) {
    action = { kind: 'install', toml: parsed.data.toml, publicKeyHex: parsed.data.publicKeyHex };
  } else {
    res.status(400).json({ error: 'Provide either `toml` or `installSample: true`' });
    return;
  }
  const result = await ext.handleAction(action);
  res.json(result);
});

skillsRouter.get('/', requireAuth, async (_req, res) => {
  const ext = getExtensionAgent();
  if (!ext) {
    res.status(503).json({ error: 'Skills Vault Agent not registered' });
    return;
  }
  const result = await ext.handleAction({ kind: 'list' });
  res.json(result);
});

const invokeSchema = z.object({
  context: z.record(z.string(), z.unknown()).default({}),
});

skillsRouter.post('/:name/invoke', requireAuth, async (req, res) => {
  const parsed = invokeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const ext = getExtensionAgent();
  if (!ext) {
    res.status(503).json({ error: 'Skills Vault Agent not registered' });
    return;
  }
  const result = await ext.handleAction({
    kind: 'invoke',
    name: req.params.name,
    context: parsed.data.context,
  });
  res.json(result);
});

skillsRouter.delete('/:name', requireAuth, async (req, res) => {
  const ext = getExtensionAgent();
  if (!ext) {
    res.status(503).json({ error: 'Skills Vault Agent not registered' });
    return;
  }
  const result = await ext.handleAction({ kind: 'uninstall', name: req.params.name });
  res.json(result);
});

const discoverSchema = z.object({
  minFrequency: z.number().int().positive().optional(),
  minSequenceLength: z.number().int().positive().optional(),
  maxSequenceLength: z.number().int().positive().optional(),
  minOutcome: z.number().min(0).max(1).optional(),
}).default({});

skillsRouter.post('/discover', requireAuth, async (req, res) => {
  const parsed = discoverSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const ext = getExtensionAgent();
  if (!ext) {
    res.status(503).json({ error: 'Skills Vault Agent not registered' });
    return;
  }
  const result = await ext.handleAction({ kind: 'discover', config: parsed.data });
  res.json(result);
});

// ── Import skills from GitHub repos ────────────────────────────────────
// POST /api/skills/import   — the EXPLICIT refresh path (boot does NOT fetch).
//   { repo: "charlie947/social-media-skills", branch: "main" }
//   → lists skills/ on the repo's default branch, imports each SKILL.md.
//   Raw URLs use HEAD so a repo whose default branch is `master` (e.g.
//   paperclipai/paperclip) does not 404 the way the old hardcoded `main` did.
//   Per-skill failures are returned in `errors` (and logged) so the UI can
//   show "imported X of Y, Z failed" instead of silently dropping them.
skillsRouter.post('/import', requireAuth, async (req, res) => {
  const importSchema = z.object({
    repo: z.string().min(1),
    branch: z.string().default('main'),
  });
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  try {
    const { importSkillsFromRepo } = await import('../skills/importer.js');
    const result = await importSkillsFromRepo(parsed.data.repo, parsed.data.branch);
    res.json({
      imported: result.imported.length,
      failed: result.failed.length,
      total: result.total,
      skills: result.imported,
      errors: result.failed,
    });
  } catch (err) {
    res.status(500).json({ error: `Import failed: ${(err as Error).message}` });
  }
});
