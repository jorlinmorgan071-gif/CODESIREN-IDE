// server/src/skills/library/index.ts
// Auto-loader for built-in skill TOML files.
// Reads all .toml files from this directory at server boot and installs them
// into the in-memory skill store via installSkill().
//
// This is called from src/index.ts during server startup, after the
// ExtensionAgent is registered.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill } from '../manifest.js';
import { installSkill, listInstalledSkills } from '../executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load and install all built-in skill TOML files from the library directory.
 * Called at server boot. Safe to call multiple times — installSkill()
 * overwrites by name.
 */
export function loadLibrarySkills(): { installed: string[]; errors: string[] } {
  const installed: string[] = [];
  const errors: string[] = [];

  if (!existsSync(__dirname)) {
    return { installed, errors: ['library directory not found'] };
  }

  const files = readdirSync(__dirname)
    .filter(f => f.endsWith('.toml'))
    .sort();

  for (const file of files) {
    try {
      const tomlContent = readFileSync(join(__dirname, file), 'utf8');
      const manifest = loadSkill(tomlContent);
      installSkill(manifest);
      installed.push(manifest.name);
      console.log(`[skills:library] installed '${manifest.name}' from ${file}`);
    } catch (err: any) {
      errors.push(`${file}: ${err.message}`);
      console.warn(`[skills:library] failed to load ${file}: ${err.message}`);
    }
  }

  console.log(`[skills:library] loaded ${installed.length} skill(s), ${errors.length} error(s)`);
  return { installed, errors };
}

/**
 * Export the raw TOML content of each skill for programmatic access
 * (e.g. for tests that need to install skills without reading files).
 */
export const LIBRARY_SKILLS: Record<string, string> = {};

// Load all TOML files into the export at module-load time
if (existsSync(__dirname)) {
  for (const file of readdirSync(__dirname).filter(f => f.endsWith('.toml'))) {
    LIBRARY_SKILLS[file] = readFileSync(join(__dirname, file), 'utf8');
  }
}
