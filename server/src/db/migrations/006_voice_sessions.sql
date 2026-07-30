-- server/src/db/migrations/006_voice_sessions.sql
-- Migration 006 — Voice sessions (directive Section 5).

CREATE TABLE IF NOT EXISTS voice_sessions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  transcript   TEXT,
  duration_ms  INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
