-- server/src/db/migrations/009_agent_relay.sql
-- Migration 009 — Agent Relay + Mother AI Orchestrator.
--
-- Two new tables:
--   relay_plans           — top-level plan objects (one per "Start Project" action)
--   relay_milestone_logs  — per-milestone execution log (one row per attempt)
--
-- Per directive Section 4: status enums cover the full lifecycle.
-- Per directive Section 6: this is purely additive — no existing table
-- is modified, no existing FK is changed, no existing index is dropped.

CREATE TABLE IF NOT EXISTS relay_plans (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id          UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id          UUID REFERENCES projects(id) ON DELETE CASCADE,
  engine              TEXT NOT NULL,           -- 'gemini-flash' | 'nvidia-nemotron'
  approval_mode       TEXT NOT NULL DEFAULT 'default'
                      CHECK (approval_mode IN ('auto', 'default')),
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN (
                        'draft', 'approved', 'running', 'paused',
                        'awaiting-user', 'completed', 'failed', 'stopped'
                      )),
  plan_json           JSONB NOT NULL,          -- { projectName, summary, techStack, milestones[] }
  current_milestone_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_relay_plans_session ON relay_plans(session_id);
CREATE INDEX IF NOT EXISTS idx_relay_plans_status ON relay_plans(status);

CREATE TABLE IF NOT EXISTS relay_milestone_logs (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_id               UUID NOT NULL REFERENCES relay_plans(id) ON DELETE CASCADE,
  milestone_id          TEXT NOT NULL,          -- e.g. 'M01'
  agent_id              TEXT NOT NULL,
  attempt               INTEGER NOT NULL DEFAULT 1,  -- correction attempts (1 = first try)
  status                TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'approved', 'rejected', 'corrected', 'failed')),
  agent_result          JSONB,                  -- summary from agent execution
  files_reviewed        TEXT[],                 -- paths of files the orchestrator inspected
  orchestrator_decision JSONB,                  -- { approved, summary, issues, corrections }
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_relay_logs_plan ON relay_milestone_logs(plan_id);
CREATE INDEX IF NOT EXISTS idx_relay_logs_milestone ON relay_milestone_logs(plan_id, milestone_id);
