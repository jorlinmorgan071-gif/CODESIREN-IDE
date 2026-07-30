-- server/src/db/migrations/003_skills_vault.sql
-- Migration 003 — Skills Vault (directive Section 5).
-- One row per installed skill. Sibling to knowledge_docs (Knowledge Vault).
-- Surfaced via the existing Extension Agent — no separate skills marketplace UI.

CREATE TABLE IF NOT EXISTS skills_vault (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id     TEXT NOT NULL,
  skill_name   TEXT NOT NULL,
  source       TEXT,                -- registry origin: 'local', 'hermes', 'openclaw', 'auto-discovered'
  config       JSONB DEFAULT '{}',  -- full SkillManifest (steps, templates, metadata)
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent_id, skill_name)
);
CREATE INDEX IF NOT EXISTS idx_skills_vault_agent ON skills_vault(agent_id);
