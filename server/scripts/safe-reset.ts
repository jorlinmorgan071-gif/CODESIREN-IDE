// server/scripts/safe-reset.ts
// Phase 6 — Safer reset with confirmation + automatic backup first.
//
// What it clears:
//   - .traces/runs.jsonl         (trace log)
//   - .stl-out/                  (STL files from fabrication)
//   - gcode-out/                 (G-code from slicing)
//   - .vite/                     (Vite cache — if exists in server/, unusual)
//
// What it PRESERVES:
//   - .biometric-templates/      (user data — never reset)
//   - .env                       (user config)
//   - node_modules/              (deps)
//   - backups/                   (previous backups)
//   - dist/                      (build output)
//   - Any .pgdata or DB contents
//
// Flow:
//   1. Print what will be cleared + preserved
//   2. Confirm with user (y/N)
//   3. Run `npm run backup` first (so reset is recoverable)
//   4. Clear the listed paths
//   5. Print summary
//
// Does NOT mutate the running server (server should be stopped first).
// Does NOT touch any protected system.

import { existsSync, unlinkSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, '..');

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
}

function dirSize(path: string): number {
  let total = 0;
  try {
    const entries = readdirSync(path, { recursive: true });
    for (const e of entries) {
      try {
        const stat = statSync(join(path, String(e)));
        if (stat.isFile()) total += stat.size;
      } catch { /* */ }
    }
  } catch { /* */ }
  return total;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

async function main() {
  console.log('━'.repeat(60));
  console.log('  Code Siren Safe Reset');
  console.log('━'.repeat(60));
  console.log('');

  const toClear = [
    { path: join(SERVER_DIR, '.traces', 'runs.jsonl'), label: '.traces/runs.jsonl (trace log)' },
    { path: join(SERVER_DIR, '.stl-out'), label: '.stl-out/ (STL outputs)' },
    { path: join(SERVER_DIR, '..', 'gcode-out'), label: 'gcode-out/ (G-code outputs)' },
  ];

  const toPreserve = [
    '.biometric-templates/ (user data)',
    '.env (user config)',
    'node_modules/ (deps)',
    'backups/ (previous backups)',
    'dist/ (build output)',
    'Database contents (use `npm run reset` legacy script if you really mean to nuke DB)',
  ];

  console.log('  Will CLEAR:');
  for (const { path, label } of toClear) {
    if (existsSync(path)) {
      const stat = statSync(path);
      const size = stat.isDirectory() ? dirSize(path) : stat.size;
      console.log(`    ✗ ${label} (${formatBytes(size)})`);
    } else {
      console.log(`    - ${label} (already absent)`);
    }
  }
  console.log('');
  console.log('  Will PRESERVE:');
  for (const label of toPreserve) {
    console.log(`    ✓ ${label}`);
  }
  console.log('');

  // Confirm
  const ok = await confirm('  Proceed with safe reset? A backup will be created first. [y/N] ');
  if (!ok) {
    console.log('  Aborted. No changes made.');
    process.exit(0);
  }
  console.log('');

  // 1. Run backup first
  console.log('  Step 1/2: Creating backup…');
  try {
    execSync('npm run --silent backup -- --no-db', { stdio: 'inherit', cwd: SERVER_DIR });
    console.log('  ✓ Backup created (see backups/)');
  } catch (err: any) {
    console.log(`  ⚠ Backup failed: ${err.message}`);
    const proceed = await confirm('  Continue with reset anyway? [y/N] ');
    if (!proceed) {
      console.log('  Aborted.');
      process.exit(0);
    }
  }
  console.log('');

  // 2. Clear paths
  console.log('  Step 2/2: Clearing…');
  for (const { path, label } of toClear) {
    if (existsSync(path)) {
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) {
          rmSync(path, { recursive: true });
        } else {
          unlinkSync(path);
        }
        console.log(`    ✓ Cleared ${label}`);
      } catch (err: any) {
        console.log(`    ⚠ Failed to clear ${label}: ${err.message}`);
      }
    } else {
      console.log(`    - ${label} (already absent)`);
    }
  }

  console.log('');
  console.log('━'.repeat(60));
  console.log('  Safe reset complete.');
  console.log('  Restart the server to apply: npm run dev');
  console.log('  To undo: npm run restore -- <latest-backup-name>');
  console.log('━'.repeat(60));
}

main().catch((err) => {
  console.error('safe-reset fatal:', err);
  process.exit(1);
});
