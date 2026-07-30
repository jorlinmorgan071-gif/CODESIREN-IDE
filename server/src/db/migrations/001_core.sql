-- server/src/db/migrations/001_core.sql
-- Migration 001 — Core tables (PDF Section 11).
-- users, projects, sessions, messages, agent_states, agent_tasks.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url  TEXT,
  github_id   TEXT UNIQUE,
  google_id   TEXT UNIQUE,
  plan        TEXT DEFAULT 'free' CHECK (plan IN ('free','pro','team','enterprise')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  root_path       TEXT NOT NULL,
  tech_stack      JSONB DEFAULT '{}',
  metadata        JSONB DEFAULT '{}',
  security_score  INTEGER DEFAULT 100,
  is_archived     BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id        UUID REFERENCES sessions(id),
  branch_name      TEXT DEFAULT 'main',
  model_id         TEXT NOT NULL DEFAULT 'claude-3-5-sonnet',
  context_summary  TEXT,
  token_count      INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','system','agent')),
  content      TEXT NOT NULL,
  agent_id     TEXT,
  meta         JSONB DEFAULT '{}',
  token_count  INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS agent_states (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  status       TEXT DEFAULT 'idle',
  trust_score  FLOAT DEFAULT 0.8,
  current_task JSONB,
  last_active  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, agent_id)
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  session_id   UUID REFERENCES sessions(id),
  type         TEXT NOT NULL,
  description  TEXT,
  status       TEXT DEFAULT 'pending',
  progress     INTEGER DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  execution_mode TEXT DEFAULT 'single-shot',
  result       JSONB,
  error        TEXT,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON agent_tasks(project_id, status);
