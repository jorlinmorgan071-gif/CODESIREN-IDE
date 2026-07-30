-- server/src/db/migrations/008_biometric.sql
-- Migration 008 — Biometric profiles (directive Section 5).
-- Per directive: "biometric_profiles is the entire face-auth footprint in the
-- schema — it's a flag and a local file path, not a new identity table."
-- The face template ITSELF is never stored in the DB — only the path to the
-- local file and a flag. Auth has exactly one source of truth: users.

CREATE TABLE IF NOT EXISTS biometric_profiles (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled              BOOLEAN DEFAULT FALSE,
  local_template_path  TEXT,    -- path to local file — NEVER the template data itself
  template_hash        TEXT,    -- SHA-256 hash (truncated) — safe for logging
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
