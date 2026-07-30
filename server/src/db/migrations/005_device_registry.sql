-- server/src/db/migrations/005_device_registry.sql
-- Migration 005 — Device registry (directive Section 5).
-- Smart-home devices discovered/managed by the Operative Agent.

CREATE TABLE IF NOT EXISTS device_registry (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_type TEXT NOT NULL,          -- 'kasa', etc.
  name        TEXT NOT NULL,
  address     TEXT,                   -- IP or hostname
  metadata    JSONB DEFAULT '{}',     -- alias, model, capabilities, etc.
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_registry_user ON device_registry(user_id);
