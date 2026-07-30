// server/src/db/migrate.ts
// Runs all migrations in order. Idempotent — uses CREATE IF NOT EXISTS.

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
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    console.log(`[migrate] Applying ${file}...`);
    await withClient(async (client) => {
      await client.query(sql);
    });
    console.log(`[migrate]   OK ${file}`);
  }
  console.log('[migrate] All migrations applied.');
  await closeDb();
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
