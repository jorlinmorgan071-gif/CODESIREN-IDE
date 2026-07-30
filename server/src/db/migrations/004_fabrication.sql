-- server/src/db/migrations/004_fabrication.sql
-- Migration 004 — Fabrication jobs (directive Section 5).
-- One row per CAD/print job. Sibling to agent_tasks.

CREATE TABLE IF NOT EXISTS fabrication_jobs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt      TEXT NOT NULL,
  stl_path    TEXT,
  printer_id  TEXT,
  status      TEXT DEFAULT 'pending',  -- pending | generating | generated | slicing | sliced | printing | completed | failed
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fabrication_jobs_project ON fabrication_jobs(project_id, created_at DESC);
