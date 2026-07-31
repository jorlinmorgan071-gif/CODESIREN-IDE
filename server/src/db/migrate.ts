// server/src/db/migrate.ts
// Runs all migrations in order. Uses schema_migrations tracking table to
// skip already-applied migrations by filename.
//
// Phase C Agent 3 (Database Agent): updated to use the schema_migrations
// tracking table (migration 010) instead of re-running everything
// idempotently. This makes ALTER TABLE migrations safe to re-run — the
// runner skips them after first application.
//
// Each migration is applied in its own transaction. If a migration fails,
// the transaction rolls back (the filename is NOT recorded as applied),
// and the runner aborts — no subsequent migrations run until the failed
// one is fixed.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, withClient, isDbAvailable, closeDb } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');

async function main() {
  await initDb();
  if (!isDbAvailable()) {
    console.log('[migrate] Postgres unavailable — nothing to migrate. Run with Postgres available to apply migrations.');
    await closeDb();
    return;
  }

  // Ensure the tracking table exists BEFORE we try to query it.
  // Migration 010 creates it, but if migrations 001–009 haven't been applied
  // yet (fresh database), we need the tracking table first. This bootstrap
  // CREATE is idempotent — safe to run even if 010 already created it.
  await withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  });

  // Get the set of already-applied migration filenames
  const applied: string[] = await withClient(async (client) => {
    const res = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
    return res.rows.map((r: { filename: string }) => r.filename);
  });
  const appliedSet = new Set(applied);
  console.log(`[migrate] ${applied.length} migration(s) already applied.`);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let appliedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`[migrate] SKIP ${file} (already applied)`);
      skippedCount++;
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    console.log(`[migrate] Applying ${file}...`);

    try {
      // Apply the migration + record it in schema_migrations in a single
      // transaction. If the migration SQL fails, the transaction rolls back
      // and the filename is NOT recorded — the runner aborts on next iteration.
      await withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
      console.log(`[migrate]   OK ${file}`);
      appliedCount++;
    } catch (err: any) {
      console.error(`[migrate]   FAILED ${file}: ${err.message}`);
      console.error(`[migrate]   Rolling back. Subsequent migrations NOT applied.`);
      await closeDb();
      process.exit(1);
    }
  }

  console.log(`[migrate] Done. ${appliedCount} applied, ${skippedCount} skipped.`);
  await closeDb();
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
