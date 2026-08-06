// server/src/orchestrator/avatar-settings.ts
// Phase B: Avatar settings — persists the user's selected avatar.
//
// Same pattern as voice-settings.ts:
//   - JSON file at server/.runtime/avatar-settings.json
//   - Module-level singleton, read-time validation
//   - Honest fallback to 'default' on invalid/missing selection
//   - GET/POST routes in routes/avatar.ts

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);
const SETTINGS_PATH = join(__dirname_esm, '..', '..', '.runtime', 'avatar-settings.json');

export interface PipPosition {
  x: number;
  y: number;
}

export interface AvatarSettings {
  selectedAvatarId: string;
  customNames: Record<string, string>;  // future: { "default": "My Custom Name" }
  pipEnabled: boolean;                    // Phase B: PIP overlay visibility
  pipPosition: PipPosition;              // Phase B: PIP overlay position { x, y }
}

const DEFAULT_SETTINGS: AvatarSettings = {
  selectedAvatarId: 'default',
  customNames: {},
  pipEnabled: false,
  pipPosition: { x: 100, y: 100 },
};

// Valid avatar IDs (read from manifest.json at module load)
let validAvatarIds: Set<string> = new Set(['default']);

try {
  const manifestPath = join(__dirname_esm, '..', '..', 'app', 'public', 'models', 'manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(manifest)) {
      validAvatarIds = new Set(manifest.map((m: any) => m.id));
    }
  }
} catch {
  // Manifest not found — fall back to just 'default'
}

/**
 * Read avatar settings from the JSON file. Validates selectedAvatarId
 * against the manifest — if invalid/missing, falls back to 'default'.
 */
export function getAvatarSettings(): AvatarSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) {
      return { ...DEFAULT_SETTINGS };
    }
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AvatarSettings>;

    // Validate selectedAvatarId
    const selectedId = parsed.selectedAvatarId ?? 'default';
    if (!validAvatarIds.has(selectedId)) {
      console.warn(`[avatar-settings] invalid selectedAvatarId '${selectedId}', falling back to 'default'`);
      return { ...DEFAULT_SETTINGS, customNames: parsed.customNames ?? {} };
    }

    return {
      selectedAvatarId: selectedId,
      customNames: parsed.customNames ?? {},
      pipEnabled: parsed.pipEnabled ?? false,
      pipPosition: parsed.pipPosition ?? { x: 100, y: 100 },
    };
  } catch (err: any) {
    console.warn(`[avatar-settings] failed to read settings: ${err.message}`);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Update avatar settings. Validates the selectedAvatarId before saving.
 */
export function setAvatarSettings(updates: Partial<AvatarSettings>): AvatarSettings {
  const current = getAvatarSettings();
  const next: AvatarSettings = {
    selectedAvatarId: current.selectedAvatarId,
    customNames: current.customNames,
    pipEnabled: current.pipEnabled,
    pipPosition: current.pipPosition,
  };

  if (updates.selectedAvatarId !== undefined) {
    if (!validAvatarIds.has(updates.selectedAvatarId)) {
      throw new Error(`Invalid avatar ID: '${updates.selectedAvatarId}'. Valid IDs: ${[...validAvatarIds].join(', ')}`);
    }
    next.selectedAvatarId = updates.selectedAvatarId;
  }

  if (updates.customNames !== undefined) {
    next.customNames = updates.customNames;
  }

  if (updates.pipEnabled !== undefined) {
    next.pipEnabled = updates.pipEnabled;
  }

  if (updates.pipPosition !== undefined) {
    next.pipPosition = updates.pipPosition;
  }

  // Persist
  try {
    const dir = dirname(SETTINGS_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
    console.log(`[avatar-settings] saved: selectedAvatarId=${next.selectedAvatarId}`);
  } catch (err: any) {
    console.warn(`[avatar-settings] failed to persist: ${err.message}`);
  }

  return next;
}

/**
 * Get the list of valid avatar IDs (for validation in routes).
 */
export function getValidAvatarIds(): string[] {
  return [...validAvatarIds];
}
