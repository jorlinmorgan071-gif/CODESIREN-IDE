// server/src/routes/avatar.ts
// Phase B: Avatar settings + manifest routes + custom avatar upload/delete/rename.
//
//   GET    /api/avatar/settings          — current avatar settings
//   POST   /api/avatar/settings          — update avatar settings
//   GET    /api/avatar/manifest          — built-in + custom avatars (merged)
//   POST   /api/avatar/custom            — upload a custom .vrm (multipart)
//   PATCH  /api/avatar/custom/:id        — rename a custom avatar
//   DELETE /api/avatar/custom/:id        — delete a custom avatar + its files
//   GET    /api/avatar/custom/check-name — check if a name conflicts

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { requireAuth } from '../auth/middleware.js';
import { getAvatarSettings, setAvatarSettings } from '../orchestrator/avatar-settings.js';
import {
  getCustomAvatars,
  addCustomAvatar,
  renameCustomAvatar,
  deleteCustomAvatar,
  generateCustomAvatarId,
  getCustomAvatarModelPath,
  getCustomAvatarThumbnailPath,
  getCustomAvatarModelUrl,
  getCustomAvatarThumbnailUrl,
  checkNameConflict,
  getCustomAvatar,
} from '../orchestrator/custom-avatars.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);

export const avatarRouter = Router();

// ── Multer config — in-memory storage, we write the file ourselves ──────────
// 100 MB limit (VRM files can be large — Yinlin is 40 MB). Files are validated
// by magic bytes (VRM starts with the glTF magic: 0x46546C67 'glTF') before save.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (_req, file, cb) => {
    // Only validate .vrm extension for the 'file' field (the model), not
    // 'thumbnail' (which is a .png). Without the fieldname check, multer
    // runs this filter on ALL files in the multipart request — including
    // the thumbnail — and rejects the entire upload because thumbnail.png
    // doesn't end with .vrm.
    if (file.fieldname === 'file' && !file.originalname.toLowerCase().endsWith('.vrm')) {
      cb(new Error('File must be a .vrm file'));
      return;
    }
    // The magic-byte check (isValidVrm) in the route handler below is the
    // real content validator — extension + MIME type are not reliable
    // indicators of file content.
    cb(null, true);
  },
});

// ── VRM magic byte validation ──────────────────────────────────────────────
// VRM files are glTF binaries — they start with the glTF magic: 0x46546C67.
// Refusing non-VRM files here prevents saving arbitrary uploads.
function isValidVrm(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  // glTF magic: 'glTF' = 0x46546C67 (little-endian)
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0x46546C67) return false;
  // Version should be 1 or 2
  const version = buffer.readUInt32LE(4);
  if (version !== 1 && version !== 2) return false;
  return true;
}

// GET /api/avatar/settings
avatarRouter.get('/settings', requireAuth, (_req, res) => {
  res.json({ settings: getAvatarSettings() });
});

// POST /api/avatar/settings
const settingsSchema = z.object({
  selectedAvatarId: z.string().optional(),
  customNames: z.record(z.string()).optional(),
  pipEnabled: z.boolean().optional(),
  pipPosition: z.object({ x: z.number(), y: z.number() }).optional(),
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

// GET /api/avatar/manifest — returns built-in + custom avatars (merged)
avatarRouter.get('/manifest', requireAuth, (_req, res) => {
  try {
    // Path: server/src/routes/ → ../../../app/public/models/manifest.json
    const manifestPath = join(__dirname_esm, '..', '..', '..', 'app', 'public', 'models', 'manifest.json');
    const builtin = JSON.parse(readFileSync(manifestPath, 'utf8')) as any[];

    // Merge built-in + custom. Built-in entries are tagged isCustom: false
    // (or omitted, since false is the default). Custom entries get isCustom: true.
    const customs = getCustomAvatars().map(c => ({
      id: c.id,
      name: c.name,
      path: getCustomAvatarModelUrl(c.id),
      thumbnail: existsSync(getCustomAvatarThumbnailPath(c.id))
        ? getCustomAvatarThumbnailUrl(c.id)
        : null,
      format: c.format,
      sizeMB: c.sizeMB,
      hasExpressions: c.expressionCount > 0,
      expressionCount: c.expressionCount,
      expressionPresets: c.expressionPresets,
      authors: 'Custom upload',
      isCustom: true,
      uploadedAt: c.uploadedAt,
      // Analysis stats (for the picker to show on hover)
      meshCount: c.meshCount,
      materialCount: c.materialCount,
      boneCount: c.boneCount,
      textureCount: c.textureCount,
      triangleCount: c.triangleCount,
      hasLookAt: c.hasLookAt,
      hasSpringBone: c.hasSpringBone,
      hasHumanoid: c.hasHumanoid,
      issues: c.issues,
    }));

    res.json({ avatars: [...builtin, ...customs] });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to read manifest: ${err.message}` });
  }
});

// GET /api/avatar/custom/check-name?name=Foo
avatarRouter.get('/custom/check-name', requireAuth, (req, res) => {
  const name = (req.query.name as string ?? '').trim();
  if (!name) {
    res.json({ conflict: false });
    return;
  }
  res.json({ conflict: checkNameConflict(name) });
});

// POST /api/avatar/custom — upload a custom .vrm
// Multipart form fields:
//   file        — the .vrm file (required)
//   metadata    — JSON string with analysis stats (required):
//                 { name, format, expressionCount, expressionPresets, meshCount,
//                   materialCount, boneCount, textureCount, triangleCount,
//                   hasLookAt, hasSpringBone, hasHumanoid, issues }
//   thumbnail   — PNG thumbnail (optional, multipart file)
avatarRouter.post('/custom', requireAuth, upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]), (req, res) => {
  try {
    const file = (req.files as any)?.file?.[0] as Express.Multer.File | undefined;
    const thumbnail = (req.files as any)?.thumbnail?.[0] as Express.Multer.File | undefined;
    const metadataRaw = req.body.metadata as string | undefined;

    if (!file) {
      res.status(400).json({ error: 'Missing .vrm file' });
      return;
    }
    if (!metadataRaw) {
      res.status(400).json({ error: 'Missing metadata' });
      return;
    }

    // Validate VRM magic bytes
    if (!isValidVrm(file.buffer)) {
      res.status(400).json({
        error: 'File is not a valid VRM — missing glTF magic bytes. Make sure you uploaded a .vrm file, not a .vrm.txt or .glb.'
      });
      return;
    }

    // Parse metadata
    let meta: any;
    try {
      meta = JSON.parse(metadataRaw);
    } catch {
      res.status(400).json({ error: 'metadata is not valid JSON' });
      return;
    }

    // Validate metadata shape
    const metaSchema = z.object({
      name: z.string().min(1).max(60),
      format: z.enum(['0.x', '1.0']),
      expressionCount: z.number().int().min(0),
      expressionPresets: z.array(z.string()),
      meshCount: z.number().int().min(0),
      materialCount: z.number().int().min(0),
      boneCount: z.number().int().min(0),
      textureCount: z.number().int().min(0),
      triangleCount: z.number().int().min(0),
      hasLookAt: z.boolean(),
      hasSpringBone: z.boolean(),
      hasHumanoid: z.boolean(),
      issues: z.array(z.string()),
    });
    const parsed = metaSchema.safeParse(meta);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid metadata', issues: parsed.error.issues });
      return;
    }

    // Check name conflict
    if (checkNameConflict(parsed.data.name)) {
      res.status(409).json({
        error: `Name "${parsed.data.name}" is already taken by a built-in or custom avatar. Choose a different name.`
      });
      return;
    }

    // Generate ID + save
    const id = generateCustomAvatarId();
    const modelPath = getCustomAvatarModelPath(id);
    const modelDir = dirname(modelPath);
    if (!existsSync(modelDir)) {
      mkdirSync(modelDir, { recursive: true });
    }
    writeFileSync(modelPath, file.buffer);

    // Save thumbnail if provided
    if (thumbnail) {
      const thumbPath = getCustomAvatarThumbnailPath(id);
      writeFileSync(thumbPath, thumbnail.buffer);
    }

    // Save metadata
    const sizeMB = Math.round((file.buffer.length / (1024 * 1024)) * 10) / 10;
    const saved = addCustomAvatar({
      id,
      name: parsed.data.name,
      originalFileName: file.originalname,
      format: parsed.data.format,
      sizeMB,
      expressionCount: parsed.data.expressionCount,
      expressionPresets: parsed.data.expressionPresets,
      meshCount: parsed.data.meshCount,
      materialCount: parsed.data.materialCount,
      boneCount: parsed.data.boneCount,
      textureCount: parsed.data.textureCount,
      triangleCount: parsed.data.triangleCount,
      hasLookAt: parsed.data.hasLookAt,
      hasSpringBone: parsed.data.hasSpringBone,
      hasHumanoid: parsed.data.hasHumanoid,
      issues: parsed.data.issues,
    });

    res.status(201).json({ avatar: saved });
  } catch (err: any) {
    console.error('[avatar-route] upload failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/avatar/custom/:id — rename a custom avatar
avatarRouter.patch('/custom/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!getCustomAvatar(id)) {
    res.status(404).json({ error: `Custom avatar '${id}' not found` });
    return;
  }
  if (checkNameConflict(name, id)) {
    res.status(409).json({
      error: `Name "${name}" is already taken by a built-in or custom avatar.`
    });
    return;
  }
  try {
    const renamed = renameCustomAvatar(id, name);
    res.json({ avatar: renamed });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/avatar/custom/:id — delete a custom avatar + its files
avatarRouter.delete('/custom/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!getCustomAvatar(id)) {
    res.status(404).json({ error: `Custom avatar '${id}' not found` });
    return;
  }

  // Read the CURRENT settings BEFORE deleting — once the custom avatar is
  // removed from the registry, getAvatarSettings() will fall back to 'default'
  // and we won't be able to tell if the deleted avatar was selected.
  const settingsBefore = getAvatarSettings();
  const wasSelected = settingsBefore.selectedAvatarId === id;

  const deleted = deleteCustomAvatar(id);
  if (!deleted) {
    res.status(500).json({ error: 'Failed to delete' });
    return;
  }

  // If the deleted avatar was the selected one, reset to default
  if (wasSelected) {
    const updated = setAvatarSettings({ selectedAvatarId: 'default' });
    res.json({ deleted: true, settingsReset: true, settings: updated });
    return;
  }
  res.json({ deleted: true });
});
