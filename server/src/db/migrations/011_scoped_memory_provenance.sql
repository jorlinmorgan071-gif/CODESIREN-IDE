-- Migration 011 — Scoped durable memory provenance.
-- New writes must identify the owning session; old project-only rows remain
-- readable only through explicitly labelled legacy project views.

ALTER TABLE agent_memory
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quality TEXT NOT NULL DEFAULT 'derived'
    CHECK (quality IN ('verified', 'derived', 'degraded')),
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_memory_owner_project_session
  ON agent_memory (project_id, session_id, created_at DESC);
