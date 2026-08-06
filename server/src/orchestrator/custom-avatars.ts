// server/src/orchestrator/custom-avatars.ts
// Phase B: Custom VRM avatar storage — user-uploaded models.
//
// Stored separately from the built-in manifest:
//   - Built-in avatars: app/public/models/manifest.json (read-only, shipped)
//   - Custom avatars:   server/.runtime/custom-avatars.json (read-write, per-user)
//
// Custom avatar files live at:
//   app/public/models/avatars/custom/<id>/model.vrm
//   app/public/models/avatars/custom/<id>/thumbnail.png
//
// The /api/avatar/manifest endpoint merges built-in + custom entries so the
// picker sees one unified list. Custom entries are flagged with `isCustom: true`
// and get a red neon glow in the UI. They can be renamed and deleted; built-in
// avatars cannot.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);
const REGISTRY_PATH = join(__dirname_esm, '..', '..', '.runtime', 'custom-avatars.json');
const MODELS_DIR = join(__dirname_esm, '..', '..', '..', 'app', 'public', 'models', 'avatars', 'custom');

export interface CustomAvatar {
  id: string;                  // 'custom-<timestamp>-<random6>' — never changes
  name: string;                // user-editable display name
  originalFileName: string;    // the file the user uploaded (for reference)
  format: string;              // '0.x' | '1.0' — detected during analysis
  sizeMB: number;              // file size in MB
  expressionCount: number;     // blendShape group count
  expressionPresets: string[]; // preset names (happy, sad, aa, ee, etc.)
  meshCount: number;
  materialCount: number;
  boneCount: number;
  textureCount: number;
  triangleCount: number;
  hasLookAt: boolean;
  hasSpringBone: boolean;
  hasHumanoid: boolean;
  issues: string[];            // analysis warnings (empty = clean)
  uploadedAt: string;          // ISO timestamp
  isCustom: true;              // type discriminator — always true
}

interface CustomAvatarRegistry {
  avatars: CustomAvatar[];
}

function readRegistry(): CustomAvatarRegistry {
  try {
    if (!existsSync(REGISTRY_PATH)) {
      return { avatars: [] };
    }
    const raw = readFileSync(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as CustomAvatarRegistry;
    if (!Array.isArray(parsed.avatars)) {
      return { avatars: [] };
    }
    return parsed;
  } catch (err: any) {
    console.warn(`[custom-avatars] failed to read registry: ${err.message}`);
    return { avatars: [] };
  }
}

function writeRegistry(reg: CustomAvatarRegistry): void {
  try {
    const dir = dirname(REGISTRY_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf8');
  } catch (err: any) {
    console.warn(`[custom-avatars] failed to write registry: ${err.message}`);
  }
}

/**
 * Generate a unique custom avatar ID.
 * Format: custom-<epoch-ms>-<6-char-hex>
 */
export function generateCustomAvatarId(): string {
  const ts = Date.now();
  const rand = randomBytes(3).toString('hex');
  return `custom-${ts}-${rand}`;
}

/**
 * Get all custom avatars.
 */
export function getCustomAvatars(): CustomAvatar[] {
  return readRegistry().avatars;
}

/**
 * Get a single custom avatar by ID.
 */
export function getCustomAvatar(id: string): CustomAvatar | null {
  return readRegistry().avatars.find(a => a.id === id) ?? null;
}

/**
 * Add a new custom avatar to the registry.
 * The model file must already be saved at app/public/models/avatars/custom/<id>/model.vrm
 */
export function addCustomAvatar(meta: Omit<CustomAvatar, 'isCustom' | 'uploadedAt'>): CustomAvatar {
  const reg = readRegistry();
  const avatar: CustomAvatar = {
    ...meta,
    uploadedAt: new Date().toISOString(),
    isCustom: true,
  };
  reg.avatars.push(avatar);
  writeRegistry(reg);
  console.log(`[custom-avatars] added: id=${avatar.id} name="${avatar.name}" format=${avatar.format} expressions=${avatar.expressionCount}`);
  return avatar;
}

/**
 * Rename a custom avatar. The ID stays the same — only the display name changes.
 */
export function renameCustomAvatar(id: string, newName: string): CustomAvatar | null {
  const reg = readRegistry();
  const avatar = reg.avatars.find(a => a.id === id);
  if (!avatar) return null;
  const trimmed = newName.trim();
  if (!trimmed) {
    throw new Error('Name cannot be empty');
  }
  if (trimmed.length > 60) {
    throw new Error('Name must be ≤ 60 characters');
  }
  avatar.name = trimmed;
  writeRegistry(reg);
  console.log(`[custom-avatars] renamed: id=${id} → "${trimmed}"`);
  return avatar;
}

/**
 * Delete a custom avatar — removes the registry entry AND the model files.
 */
export function deleteCustomAvatar(id: string): boolean {
  const reg = readRegistry();
  const idx = reg.avatars.findIndex(a => a.id === id);
  if (idx === -1) return false;

  // Remove files
  const avatarDir = join(MODELS_DIR, id);
  try {
    if (existsSync(avatarDir)) {
      rmSync(avatarDir, { recursive: true, force: true });
    }
  } catch (err: any) {
    console.warn(`[custom-avatars] failed to remove files for ${id}: ${err.message}`);
  }

  reg.avatars.splice(idx, 1);
  writeRegistry(reg);
  console.log(`[custom-avatars] deleted: id=${id}`);
  return true;
}

/**
 * Get the absolute path where a custom avatar's model.vrm should be saved.
 */
export function getCustomAvatarModelPath(id: string): string {
  return join(MODELS_DIR, id, 'model.vrm');
}

/**
 * Get the absolute path where a custom avatar's thumbnail.png should be saved.
 */
export function getCustomAvatarThumbnailPath(id: string): string {
  return join(MODELS_DIR, id, 'thumbnail.png');
}

/**
 * Get the public URL path for a custom avatar's model.
 */
export function getCustomAvatarModelUrl(id: string): string {
  return `/models/avatars/custom/${id}/model.vrm`;
}

/**
 * Get the public URL path for a custom avatar's thumbnail.
 */
export function getCustomAvatarThumbnailUrl(id: string): string {
  return `/models/avatars/custom/${id}/thumbnail.png`;
}

/**
 * Validate that an ID is a valid custom avatar ID (not a built-in one).
 * Built-in IDs: default, hatsune-miku, yinlin, marionette.
 */
export function isCustomAvatarId(id: string): boolean {
  return id.startsWith('custom-');
}

/**
 * Check if a candidate name conflicts with any existing custom or built-in avatar name.
 * Built-in names are read from the manifest at module load.
 */
let builtinAvatarNames: Set<string> = new Set();

try {
  const manifestPath = join(__dirname_esm, '..', '..', '..', 'app', 'public', 'models', 'manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(manifest)) {
      builtinAvatarNames = new Set(manifest.map((m: any) => m.name.toLowerCase()));
    }
  }
} catch {
  // Manifest not found — name conflict check will only check custom avatars
}

export function checkNameConflict(name: string, excludeId?: string): boolean {
  const lower = name.toLowerCase().trim();
  if (builtinAvatarNames.has(lower)) return true;
  const customs = getCustomAvatars();
  return customs.some(a => a.id !== excludeId && a.name.toLowerCase() === lower);
}
