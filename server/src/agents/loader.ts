// server/src/agents/loader.ts
// Agent Auto-Loader — CHIMERA Plugin Runtime (minimal scope).
//
// Scans server/src/agents/ for subdirectories (excluding _shared/), dynamically
// imports each one's index.ts, finds the exported class that extends IAgent,
// instantiates it, and returns the list for registration.
//
// This mirrors the Skills Vault's loadLibrarySkills() pattern: drop a folder
// with an index.ts exporting an IAgent implementation, it loads automatically
// at boot — no need to touch index.ts.
//
// Contract:
//   1. Each subdirectory of server/src/agents/ (except _shared/) must have an
//      index.ts file.
//   2. The index.ts must export exactly one class that extends IAgent.
//   3. The class must be instantiable with no constructor arguments (or with
//      optional arguments that default safely).
//   4. If any of these conditions fail, the loader logs a clear warning and
//      skips that agent — boot continues without crashing.

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IAgent } from './base-agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Result of loading a single agent.
 */
interface LoadResult {
  agent: IAgent;
  dirName: string;
}

/**
 * Scan the agents directory, dynamically import each agent's index.ts,
 * find the IAgent implementation, instantiate it, and return the list.
 *
 * Skips _shared/ and any directory whose index.ts doesn't export a valid
 * IAgent implementation (with a clear warning, not a crash).
 */
export async function loadAgents(): Promise<LoadResult[]> {
  const results: LoadResult[] = [];
  const agentsDir = __dirname;

  if (!existsSync(agentsDir)) {
    console.error('[agents:loader] agents directory not found:', agentsDir);
    return results;
  }

  // Get all subdirectories (excluding _shared and hidden dirs)
  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const dirs = entries
    .filter(e => e.isDirectory() && e.name !== '_shared' && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort();

  console.log(`[agents:loader] scanning ${dirs.length} agent directories...`);

  for (const dirName of dirs) {
    const indexPath = join(agentsDir, dirName, 'index.ts');
    if (!existsSync(indexPath)) {
      console.warn(`[agents:loader] ${dirName}: no index.ts — skipping`);
      continue;
    }

    try {
      // Dynamic import — Node resolves .ts via tsx at runtime
      const module = await import(`./${dirName}/index.js`);

      // Find the exported class that extends IAgent
      let agentClass: (new () => IAgent) | null = null;
      let foundClassName = '';

      for (const [exportName, exportValue] of Object.entries(module)) {
        if (typeof exportValue === 'function' && exportValue.prototype instanceof IAgent) {
          // Check if it's instantiable with no args
          agentClass = exportValue as new () => IAgent;
          foundClassName = exportName;
          break;
        }
      }

      if (!agentClass) {
        console.warn(`[agents:loader] ${dirName}: no IAgent implementation found in exports — skipping`);
        continue;
      }

      const agent = new agentClass();
      results.push({ agent, dirName });
      console.log(`[agents:loader] loaded ${foundClassName} from ${dirName}/ (id=${agent.id})`);
    } catch (err: any) {
      console.warn(`[agents:loader] ${dirName}: failed to load — ${err.message}`);
    }
  }

  console.log(`[agents:loader] ${results.length} agent(s) loaded successfully`);
  return results;
}
