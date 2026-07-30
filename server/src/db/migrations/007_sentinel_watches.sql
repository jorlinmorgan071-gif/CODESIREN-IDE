-- server/src/db/migrations/007_sentinel_watches.sql
-- Migration 007 — Sentinel watches (directive Section 5).

CREATE TABLE IF NOT EXISTS sentinel_watches (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watch_type  TEXT NOT NULL,
  config      JSONB DEFAULT '{}',
  last_run    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sentinel_watches_user ON sentinel_watches(user_id);
