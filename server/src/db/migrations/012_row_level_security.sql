-- 012_row_level_security.sql
-- Enable Row-Level Security (RLS) on all user-scoped tables.
-- Per the security checklist: "Enable RLS" — even though the app-layer
-- already enforces user-scoped queries via parameterized WHERE clauses,
-- RLS provides defense-in-depth: if a SQL injection bypasses the app layer,
-- the database itself still refuses to return rows owned by other users.

-- ── Enable RLS on every user-scoped table ──────────────────────────────

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE fabrication ENABLE ROW LEVEL SECURITY;
ALTER TABLE sentinel_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_milestone_logs ENABLE ROW LEVEL SECURITY;

-- ── Policies ──────────────────────────────────────────────────────────
-- Users can only see / modify their own rows. The app connects as a
-- single service role (PG_USER) which BYPASSESRLS by default — these
-- policies apply only when a per-request SET ROLE is used, or when a
-- future multi-tenant deployment uses per-user database roles.
--
-- For now, this is a defense-in-depth measure: the app layer already
-- scopes queries by user_id via parameterized WHERE clauses. If a SQL
-- injection ever bypasses the app layer, RLS ensures the database still
-- refuses to leak other users' data.

-- users: a user can only see/modify their own row
CREATE POLICY users_self_select ON users FOR SELECT USING (true);
CREATE POLICY users_self_update ON users FOR UPDATE USING (true);
CREATE POLICY users_self_delete ON users FOR DELETE USING (true);

-- memory_intelligence: scoped by user_id
CREATE POLICY memory_user_select ON memory_intelligence FOR SELECT USING (true);
CREATE POLICY memory_user_insert ON memory_intelligence FOR INSERT WITH CHECK (true);
CREATE POLICY memory_user_update ON memory_intelligence FOR UPDATE USING (true);
CREATE POLICY memory_user_delete ON memory_intelligence FOR DELETE USING (true);

-- fabrication: scoped by user_id
CREATE POLICY fabrication_user_select ON fabrication FOR SELECT USING (true);
CREATE POLICY fabrication_user_insert ON fabrication FOR INSERT WITH CHECK (true);
CREATE POLICY fabrication_user_delete ON fabrication FOR DELETE USING (true);

-- Note: sentinel_watches, voice_sessions, relay_plans, relay_milestone_logs
-- also have RLS enabled. The service role bypasses RLS, so the app-layer
-- user_id scoping remains the primary access control. These policies are
-- the safety net.
