-- server/src/db/migrations/010_migration_tracking.sql
-- Migration 010 — Schema migration tracking table.
--
-- Phase C Agent 3 (Database Agent): adds a tracking table so the migration
-- runner (src/db/migrate.ts) can:
--   1. Skip already-applied migrations by filename (instead of re-running
--      everything idempotently)
--   2. Detect if a previously-applied migration file's content has changed
--      since it was first applied (SHA-256 checksum mismatch) — log a loud
--      warning, do NOT auto-fix, surface it for a human to decide
--
-- Per directive Section 1: the schema includes:
--   - id SERIAL PRIMARY KEY (surrogate key, not the filename)
--   - filename TEXT NOT NULL UNIQUE (the natural key — one row per migration file)
--   - applied_at TIMESTAMPTZ (when the migration was applied)
--   - applied_by TEXT (who/what applied it — agent id or 'manual' for npm run migrate)
--   - checksum TEXT NOT NULL (SHA-256 of the file content at apply time)

CREATE TABLE IF NOT EXISTS schema_migrations (
  id          SERIAL PRIMARY KEY,
  filename    TEXT NOT NULL UNIQUE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by  TEXT,
  checksum    TEXT NOT NULL
);

-- Insert a record for THIS migration file itself, so the runner knows it
-- has been applied. The checksum is the SHA-256 of this file's content —
-- the runner computes it at apply time, but since this migration creates
-- the table itself, we use a placeholder that the runner will NOT verify
-- against (it only verifies checksums for migrations applied AFTER the
-- tracking table exists). This self-bootstrap is safe because:
--   1. The runner creates the tracking table BEFORE reading it (idempotent CREATE)
--   2. On a fresh DB, all 10 migrations run in order — 010 creates the table,
--      then the runner records 010's own checksum
--   3. On an already-migrated DB, 010 is already in the table, so it's skipped
INSERT INTO schema_migrations (filename, applied_by, checksum)
VALUES ('010_migration_tracking.sql', 'self-bootstrap', 'self-bootstrap')
ON CONFLICT (filename) DO NOTHING;
