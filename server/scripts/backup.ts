// server/scripts/backup.ts
// Phase 6 — Backup DB + traces + biometric templates + env (secrets redacted).
//
// Creates a timestamped tarball in `backups/` containing:
//   - traces.jsonl          (copy of .traces/runs.jsonl)
//   - biometric-templates/  (copy of .biometric-templates/)
//   - env.sanitized         (env with secrets redacted)
//   - manifest.json         (backup metadata)
//   - db-export.sql         (if Postgres available — pg_dump output)
//
// Does NOT mutate any source data. Does NOT modify any protected system.
// Output is purely additive — creates a new file in backups/.
//
// Usage: npm run backup [-- --no-db]   (skip pg_dump if Postgres unavailable)

import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, '..');
const BACKUP_DIR = join(SERVER_DIR, 'backups');

const skipDb = process.argv.includes('--no-db');

interface BackupManifest {
  timestamp: string;
  version: string;
  files: Array<{ name: string; sizeBytes: number; sha256: string }>;
  dbExported: boolean;
  envSanitized: boolean;
  notes: string[];
}

function sha256(filePath: string): string {
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
}

async function main() {
  console.log('━'.repeat(60));
  console.log('  Code Siren Backup');
  console.log('━'.repeat(60));

  // Create timestamped backup dir
  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const backupName = `backup-${timestamp}`;
  const backupPath = join(BACKUP_DIR, backupName);
  mkdirSync(backupPath, { recursive: true });

  const manifest: BackupManifest = {
    timestamp: new Date().toISOString(),
    version: 'phase-6',
    files: [],
    dbExported: false,
    envSanitized: false,
    notes: [],
  };

  // 1. Copy traces file
  const tracesSrc = join(SERVER_DIR, '.traces', 'runs.jsonl');
  if (existsSync(tracesSrc)) {
    const tracesDst = join(backupPath, 'traces.jsonl');
    copyFileSync(tracesSrc, tracesDst);
    const stat = statSync(tracesDst);
    manifest.files.push({
      name: 'traces.jsonl',
      sizeBytes: stat.size,
      sha256: sha256(tracesDst),
    });
    console.log(`  ✓ traces.jsonl (${formatBytes(stat.size)})`);
  } else {
    manifest.notes.push('No traces file found — skipped');
    console.log('  - traces.jsonl (none yet)');
  }

  // 2. Copy biometric templates
  const bioSrc = join(SERVER_DIR, '.biometric-templates');
  if (existsSync(bioSrc)) {
    const bioDst = join(backupPath, 'biometric-templates');
    mkdirSync(bioDst, { recursive: true });
    let count = 0;
    for (const f of readdirSync(bioSrc)) {
      copyFileSync(join(bioSrc, f), join(bioDst, f));
      count++;
    }
    console.log(`  ✓ biometric-templates/ (${count} files)`);
  } else {
    manifest.notes.push('No biometric templates dir — skipped');
    console.log('  - biometric-templates/ (none)');
  }

  // 3. Sanitized env (redact secrets)
  const envSrc = join(SERVER_DIR, '.env');
  if (existsSync(envSrc)) {
    const envContent = readFileSync(envSrc, 'utf8');
    const sanitized = envContent
      .replace(/(JWT_SECRET=).+/g, '$1<redacted>')
      .replace(/(PG_PASSWORD=).+/g, '$1<redacted>')
      .replace(/(OPENROUTER_API_KEY=).+/g, '$1<redacted>')
      .replace(/(OPENAI_API_KEY=).+/g, '$1<redacted>')
      .replace(/(ANTHROPIC_API_KEY=).+/g, '$1<redacted>');
    writeFileSync(join(backupPath, 'env.sanitized'), sanitized);
    manifest.envSanitized = true;
    console.log('  ✓ env.sanitized (secrets redacted)');
  } else {
    manifest.notes.push('No .env file — skipped');
    console.log('  - env.sanitized (no .env)');
  }

  // 4. DB export (pg_dump)
  if (!skipDb) {
    const pgHost = process.env.PG_HOST ?? 'localhost';
    const pgPort = process.env.PG_PORT ?? '5432';
    const pgDb = process.env.PG_DB ?? 'code_siren';
    const pgUser = process.env.PG_USER ?? 'code_siren';
    const pgPassword = process.env.PG_PASSWORD ?? 'code_siren';
    try {
      const dbDst = join(backupPath, 'db-export.sql');
      execSync(
        `PGPASSWORD=${pgPassword} pg_dump -h ${pgHost} -p ${pgPort} -U ${pgUser} -d ${pgDb} --no-owner --no-privileges -f "${dbDst}"`,
        { stdio: 'pipe', env: { ...process.env } },
      );
      const stat = statSync(dbDst);
      manifest.files.push({
        name: 'db-export.sql',
        sizeBytes: stat.size,
        sha256: sha256(dbDst),
      });
      manifest.dbExported = true;
      console.log(`  ✓ db-export.sql (${formatBytes(stat.size)})`);
    } catch (err: any) {
      manifest.notes.push(`DB export failed: ${err.message?.slice(0, 200)}`);
      console.log('  ⚠ db-export.sql (Postgres unavailable or pg_dump not installed — skipped)');
    }
  } else {
    manifest.notes.push('DB export skipped (--no-db flag)');
    console.log('  - db-export.sql (skipped via --no-db)');
  }

  // 5. Write manifest
  writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('  ✓ manifest.json');

  // 6. Create tarball
  const tarballPath = `${backupPath}.tar.gz`;
  try {
    execSync(`tar -czf "${tarballPath}" -C "${BACKUP_DIR}" "${backupName}"`, { stdio: 'pipe' });
    const stat = statSync(tarballPath);
    console.log('');
    console.log(`  ✓ Backup created: ${tarballPath}`);
    console.log(`    Size: ${formatBytes(stat.size)}`);
  } catch (err: any) {
    console.log(`  ⚠ tar failed: ${err.message}`);
    console.log(`  ✓ Backup directory: ${backupPath}`);
  }

  console.log('');
  console.log('━'.repeat(60));
  console.log('  Backup complete. To restore: npm run restore -- <backup-name>');
  console.log('━'.repeat(60));
}

main().catch((err) => {
  console.error('backup fatal:', err);
  process.exit(1);
});
