// server/src/db/migrate.ts
// Runs all migrations in order. Uses schema_migrations tracking table to
// skip already-applied migrations by filename AND detect content drift
// via SHA-256 checksum verification.
//
// Phase C Agent 3 (Database Agent): updated per directive Section 1:
//   - Check schema_migrations before running each file (query by filename)
//   - Skip files already recorded
//   - Record filename + SHA-256 checksum + applied_by after successful run
//   - If a previously-applied file's current content hash doesn't match
//     what's recorded: log a LOUD warning, do NOT auto-fix, do NOT
//     auto-skip silently — surface it in the return value for a human
//
// Each migration is applied in its own transaction. If a migration fails,
// the transaction rolls back (the filename is NOT recorded as applied),
// and the runner aborts — no subsequent migrations run until the failed
// one is fixed.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { initDb, withClient, isDbAvailable, closeDb, query } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');

/**
 * Compute the SHA-256 checksum of a file's content.
 * Used to detect if a previously-applied migration file has been edited
 * since it was first applied.
 *
 * Exported for testing — the migration runner's checksum logic is pure
 * and should be testable without a real database.
 */
export function computeChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Get the set of already-applied migrations with their checksums.
 * Returns a Map<filename, checksum> for verification.
 *
 * Exported for testing — callers can mock this to test both fresh-DB
 * and already-migrated-DB paths without a real Postgres connection.
 */
export async function getAppliedMigrations(): Promise<Map<string, string>> {
  const rows = await query<{ filename: string; checksum: string }>(`
    SELECT filename, checksum FROM schema_migrations
  `);
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.filename, row.checksum);
  }
  return map;
}

export interface MigrationRunResult {
  applied: string[];        // filenames successfully applied this run
  skipped: string[];        // filenames skipped (already applied, checksum OK)
  checksumMismatches: string[];  // filenames where content drifted (LOUD WARNING)
  failed?: { filename: string; error: string };  // first failure (runner aborts after)
}

/**
 * Main migration runner. Applies all pending migrations in order.
 *
 * Per directive Section 1:
 * - Fresh DB: all files run in sorted order, all get recorded
 * - Already-migrated DB: pre-existing files skip, only new files run
 * - Checksum mismatch on already-applied file: LOUD warning, no auto-fix,
 *   no silent skip — the file is listed in checksumMismatches[] for a human
 *
 * @returns MigrationRunResult with details of what happened
 */
export async function runMigrations(appliedBy: string = 'manual'): Promise<MigrationRunResult> {
  await initDb();
  if (!isDbAvailable()) {
    console.log('[migrate] Postgres unavailable — nothing to migrate. Run with Postgres available to apply migrations.');
    await closeDb();
    return { applied: [], skipped: [], checksumMismatches: [] };
  }

  // Ensure the tracking table exists BEFORE we try to query it.
  // Migration 010 creates it, but if migrations 001–009 haven't been applied
  // yet (fresh database), we need the tracking table first. This bootstrap
  // CREATE is idempotent — safe to run even if 010 already created it.
  await withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          SERIAL PRIMARY KEY,
        filename    TEXT NOT NULL UNIQUE,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        applied_by  TEXT,
        checksum    TEXT NOT NULL
      );
    `);
  });

  // Get the set of already-applied migration filenames + their checksums
  const appliedMap = await getAppliedMigrations();
  console.log(`[migrate] ${appliedMap.size} migration(s) already applied.`);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const result: MigrationRunResult = {
    applied: [],
    skipped: [],
    checksumMismatches: [],
  };

  for (const file of files) {
    const filePath = join(migrationsDir, file);
    const sql = readFileSync(filePath, 'utf8');
    const currentChecksum = computeChecksum(sql);

    // Check if this migration was already applied
    if (appliedMap.has(file)) {
      const recordedChecksum = appliedMap.get(file)!;

      // Self-bootstrap migrations (like 010 itself) use 'self-bootstrap' as
      // their checksum — skip verification for those.
      if (recordedChecksum === 'self-bootstrap') {
        console.log(`[migrate] SKIP ${file} (already applied, self-bootstrap)`);
        result.skipped.push(file);
        continue;
      }

      // Verify checksum — detect content drift
      if (recordedChecksum !== currentChecksum) {
        // LOUD WARNING — do NOT auto-fix, do NOT auto-skip silently.
        // Surface it for a human to decide.
        console.warn(``);
        console.warn(`[migrate] ⚠️  CHECKSUM MISMATCH for ${file}`);
        console.warn(`[migrate] ⚠️  This migration was previously applied but its content has changed since then.`);
        console.warn(`[migrate] ⚠️  Recorded checksum: ${recordedChecksum}`);
        console.warn(`[migrate] ⚠️  Current checksum:  ${currentChecksum}`);
        console.warn(`[migrate] ⚠️  The migration was NOT re-applied. Editting an already-applied migration is dangerous —`);
        console.warn(`[migrate] ⚠️  it can put the database in an inconsistent state. Review the change manually.`);
        console.warn(`[migrate] ⚠️  If the change is intentional, drop the schema_migrations row for this file and re-run.`);
        console.warn(``);
        result.checksumMismatches.push(file);
        // Do NOT apply, do NOT skip — continue to next file. The mismatch
        // is surfaced in the result for a human to investigate.
        continue;
      }

      console.log(`[migrate] SKIP ${file} (already applied, checksum OK)`);
      result.skipped.push(file);
      continue;
    }

    // Not yet applied — apply it now
    console.log(`[migrate] Applying ${file}...`);

    try {
      // Apply the migration + record it in schema_migrations in a single
      // transaction. If the migration SQL fails, the transaction rolls back
      // and the filename is NOT recorded — the runner aborts.
      await withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (filename, applied_by, checksum) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [file, appliedBy, currentChecksum],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
      console.log(`[migrate]   OK ${file}`);
      result.applied.push(file);
    } catch (err: any) {
      console.error(`[migrate]   FAILED ${file}: ${err.message}`);
      console.error(`[migrate]   Rolling back. Subsequent migrations NOT applied.`);
      result.failed = { filename: file, error: err.message };
      await closeDb();
      return result;
    }
  }

  console.log(`[migrate] Done. ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.checksumMismatches.length} checksum mismatch(es).`);
  if (result.checksumMismatches.length > 0) {
    console.warn(`[migrate] ⚠️  ${result.checksumMismatches.length} migration(s) had checksum mismatches — review required.`);
  }
  await closeDb();
  return result;
}

// CLI entry point — runs when invoked via `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations('manual').then((result) => {
    if (result.failed) {
      process.exit(1);
    }
    if (result.checksumMismatches.length > 0) {
      // Exit non-zero on checksum mismatches too — they need human attention.
      // This makes CI fail if migrations drift, which is the right behavior.
      process.exit(2);
    }
    process.exit(0);
  }).catch((err) => {
    console.error('[migrate] FAILED:', err);
    process.exit(1);
  });
}
