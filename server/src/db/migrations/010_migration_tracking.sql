-- server/src/db/migrations/010_migration_tracking.sql
-- Migration 010 — Schema migration tracking table.
--
-- Phase C Agent 3 (Database Agent): adds a tracking table so the migration
-- runner (src/db/migrate.ts) can skip already-applied migrations by filename
-- instead of re-running everything idempotently. This makes ALTER TABLE
-- migrations safe to re-run (the runner skips them after first application).
--
-- The table is intentionally simple — just filename + applied_at. No
-- checksumming or rollback tracking (those are future enhancements, out
-- of scope for this phase).

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert a record for THIS migration file itself, so the runner knows it
-- has been applied. (The runner inserts records for all other migrations
-- as it applies them; this one is self-bootstrapping.)
INSERT INTO schema_migrations (filename)
VALUES ('010_migration_tracking.sql')
ON CONFLICT (filename) DO NOTHING;
