-- server/src/db/migrations/002_memory_intelligence.sql
-- Migration 002 — Memory, intelligence, and feature tables (PDF Section 11).
-- snapshots, knowledge_docs, agent_memory, deployments, code_dna, pattern_library, dependency_health.

CREATE TABLE IF NOT EXISTS snapshots (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT,
  trigger     TEXT,
  file_path   TEXT NOT NULL,
  size_bytes  BIGINT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  file_path   TEXT,
  content     TEXT,
  doc_type    TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_memory (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id    TEXT,
  source_type TEXT,
  source_ref  TEXT,
  content     TEXT NOT NULL,
  embedding   vector(768),
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_embedding ON agent_memory
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_memory_project ON agent_memory(project_id);

CREATE TABLE IF NOT EXISTS deployments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,
  environment   TEXT DEFAULT 'production',
  status        TEXT DEFAULT 'pending',
  url           TEXT,
  commit_sha    TEXT,
  logs          TEXT,
  meta          JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS code_dna (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  naming_style        JSONB DEFAULT '{}',
  indent_style        TEXT DEFAULT 'spaces',
  indent_size         INTEGER DEFAULT 2,
  comment_ratio       FLOAT DEFAULT 0.15,
  preferred_patterns  JSONB DEFAULT '[]',
  preferred_libs      JSONB DEFAULT '[]',
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pattern_library (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  code            TEXT NOT NULL,
  language        TEXT,
  tags            TEXT[],
  usage_count     INTEGER DEFAULT 0,
  embedding       vector(768),
  source_project  UUID REFERENCES projects(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patterns_embedding ON pattern_library
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

CREATE TABLE IF NOT EXISTS dependency_health (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  package_name  TEXT NOT NULL,
  installed_v   TEXT,
  latest_v      TEXT,
  risk_level    TEXT DEFAULT 'none',
  cve_ids       TEXT[],
  bundle_size   INTEGER,
  license       TEXT,
  last_checked  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, package_name)
);
