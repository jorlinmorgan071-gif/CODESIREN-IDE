// server/src/routes/avatar.ts
// Phase B: Avatar settings + manifest routes.
//
//   GET  /api/avatar/settings   — returns current avatar settings
//   POST /api/avatar/settings   — updates avatar settings
//   GET  /api/avatar/manifest   — returns the avatar manifest (list of available models)

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getAvatarSettings, setAvatarSettings } from '../orchestrator/avatar-settings.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);

export const avatarRouter = Router();

// GET /api/avatar/settings
avatarRouter.get('/settings', requireAuth, (_req, res) => {
  res.json({ settings: getAvatarSettings() });
});

// POST /api/avatar/settings
const settingsSchema = z.object({
  selectedAvatarId: z.string().optional(),
  customNames: z.record(z.string()).optional(),
});

avatarRouter.post('/settings', requireAuth, (req, res) => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  try {
    const updated = setAvatarSettings(parsed.data);
    res.json({ settings: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/avatar/manifest — returns the avatar manifest from app/public/models/manifest.json
avatarRouter.get('/manifest', requireAuth, (_req, res) => {
  try {
    const manifestPath = join(__dirname_esm, '..', '..', 'app', 'public', 'models', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    res.json({ avatars: manifest });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to read manifest: ${err.message}` });
  }
});
