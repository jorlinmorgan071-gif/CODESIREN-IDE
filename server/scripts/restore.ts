// server/scripts/restore.ts
// Phase 6 — Restore from a backup tarball.
//
// Usage: npm run restore -- backup-2026-06-21T10-30-00
//    OR: npm run restore -- backup-2026-06-21T10-30-00.tar.gz
//
// Restores:
//   - traces.jsonl          → .traces/runs.jsonl
//   - biometric-templates/  → .biometric-templates/
//   - env.sanitized         → .env.restored (does NOT overwrite .env — secrets redacted)
//   - db-export.sql         → if Postgres available, psql restore (requires confirmation)
//
// Does NOT mutate the running server. Does NOT overwrite .env.
// The operator must restart the server for the restore to take effect.

import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, '..');
const BACKUP_DIR = join(SERVER_DIR, 'backups');

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
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
  console.log('  Code Siren Restore');
  console.log('━'.repeat(60));

  // Resolve backup name from argv
  const arg = process.argv[2];
  if (!arg) {
    console.log('  Usage: npm run restore -- <backup-name>');
    console.log('  Available backups:');
    if (existsSync(BACKUP_DIR)) {
      const backups = readdirSync(BACKUP_DIR).filter((f) => f.startsWith('backup-'));
      for (const b of backups.slice(-10)) {
        console.log(`    ${b}`);
      }
    } else {
      console.log('    (no backups directory)');
    }
    process.exit(1);
  }

  // Resolve backup path
  let backupName = arg.replace(/\.tar\.gz$/, '');
  let backupDir = join(BACKUP_DIR, backupName);
  let tarballPath = `${backupDir}.tar.gz`;

  // If only tarball exists, extract it first
  if (!existsSync(backupDir) && existsSync(tarballPath)) {
    console.log(`  Extracting ${tarballPath}…`);
    execSync(`tar -xzf "${tarballPath}" -C "${BACKUP_DIR}"`, { stdio: 'pipe' });
  }

  if (!existsSync(backupDir)) {
    console.log(`  ✗ Backup not found: ${backupName}`);
    console.log(`    Looked in: ${backupDir}`);
    console.log(`    And tarball: ${tarballPath}`);
    process.exit(1);
  }

  console.log(`  Restoring from: ${backupName}`);
  console.log('');

  // Read manifest
  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.log('  ⚠ No manifest.json — proceeding anyway');
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    console.log(`  Backup created: ${manifest.timestamp}`);
    console.log(`  DB exported: ${manifest.dbExported ? 'yes' : 'no'}`);
    if (manifest.notes?.length > 0) {
      console.log('  Notes:');
      for (const n of manifest.notes) console.log(`    - ${n}`);
    }
    console.log('');
  }

  // Confirm
  const ok = await confirm('  Restore? This will OVERWRITE .traces/runs.jsonl and .biometric-templates/ [y/N] ');
  if (!ok) {
    console.log('  Aborted.');
    process.exit(0);
  }
  console.log('');

  // 1. Restore traces
  const tracesSrc = join(backupDir, 'traces.jsonl');
  if (existsSync(tracesSrc)) {
    const tracesDst = join(SERVER_DIR, '.traces', 'runs.jsonl');
    mkdirSync(join(SERVER_DIR, '.traces'), { recursive: true });
    copyFileSync(tracesSrc, tracesDst);
    console.log(`  ✓ traces.jsonl restored`);
  } else {
    console.log('  - traces.jsonl (not in backup)');
  }

  // 2. Restore biometric templates
  const bioSrc = join(backupDir, 'biometric-templates');
  if (existsSync(bioSrc)) {
    const bioDst = join(SERVER_DIR, '.biometric-templates');
    // Clear existing first (with confirmation already given)
    if (existsSync(bioDst)) rmSync(bioDst, { recursive: true });
    mkdirSync(bioDst, { recursive: true });
    let count = 0;
    for (const f of readdirSync(bioSrc)) {
      copyFileSync(join(bioSrc, f), join(bioDst, f));
      count++;
    }
    console.log(`  ✓ biometric-templates/ restored (${count} files)`);
  } else {
    console.log('  - biometric-templates/ (not in backup)');
  }

  // 3. Restore env (as .env.restored — never overwrite .env)
  const envSrc = join(backupDir, 'env.sanitized');
  if (existsSync(envSrc)) {
    const envDst = join(SERVER_DIR, '.env.restored');
    copyFileSync(envSrc, envDst);
    console.log(`  ✓ env.restored created (secrets redacted — review and merge into .env manually)`);
  }

  // 4. Restore DB (with separate confirmation)
  const dbSrc = join(backupDir, 'db-export.sql');
  if (existsSync(dbSrc)) {
    const dbOk = await confirm('  Restore database from db-export.sql? This will OVERWRITE the current DB. [y/N] ');
    if (dbOk) {
      const pgHost = process.env.PG_HOST ?? 'localhost';
      const pgPort = process.env.PG_PORT ?? '5432';
      const pgDb = process.env.PG_DB ?? 'code_siren';
      const pgUser = process.env.PG_USER ?? 'code_siren';
      const pgPassword = process.env.PG_PASSWORD ?? 'code_siren';
      try {
        execSync(
          `PGPASSWORD=${pgPassword} psql -h ${pgHost} -p ${pgPort} -U ${pgUser} -d ${pgDb} -f "${dbSrc}"`,
          { stdio: 'pipe', env: { ...process.env } },
        );
        console.log('  ✓ database restored');
      } catch (err: any) {
        console.log(`  ⚠ DB restore failed: ${err.message?.slice(0, 200)}`);
        console.log('    You may need to restore manually with psql.');
      }
    } else {
      console.log('  - database restore skipped');
    }
  } else {
    console.log('  - db-export.sql (not in backup)');
  }

  console.log('');
  console.log('━'.repeat(60));
  console.log('  Restore complete. Restart the server to apply: npm run dev');
  console.log('━'.repeat(60));
}

main().catch((err) => {
  console.error('restore fatal:', err);
  process.exit(1);
});
