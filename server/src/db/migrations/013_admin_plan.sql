-- server/src/db/migrations/013_admin_plan.sql
-- Migration 013 — Allow plan='admin' on the users table.
--
-- WHY
--   The terminal gate (server/src/ws/server.ts) and requireAdmin middleware
--   (server/src/auth/middleware.ts) both authorize on `plan === 'admin'`.
--   But migration 001 created users.plan with a CHECK constraint that only
--   allowed ('free','pro','team','enterprise') — 'admin' was NOT in the
--   list. Against PostgreSQL this meant no DB-backed user could ever hold
--   plan='admin', so admin authorization only worked in the degraded
--   in-memory mode. The Docker/production path (which uses Postgres) could
--   not produce a real admin at all.
--
-- WHAT
--   Drop the existing column CHECK on users.plan (whatever it is named —
--   PostgreSQL auto-names column checks `<table>_<col>_check`, but we look
--   it up dynamically so this is robust to a differently-named constraint)
--   and add a fresh NAMED constraint that includes 'admin'. Naming it
--   explicitly lets a future migration target it by name if needed.
--
-- HOW AN ADMIN IS CREATED
--   There is NO env-var promotion and NO automatic promotion by email —
--   emails are not verified at signup, so promoting by email alone would
--   let anyone who controls an inbox seize admin. Instead, an operator who
--   has already verified a user's identity runs:
--
--       npm run make-admin -- <email>
--
--   (server/scripts/make-admin.ts → server/src/auth/admin.ts) which UPDATEs
--   the users table. The user's NEXT login then issues an admin-scoped JWT.

-- 1. Drop the existing CHECK on users.plan, whatever it happens to be named.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname
    INTO cname
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  JOIN pg_attribute att ON att.attrelid = cls.oid AND att.attnum = ANY(con.conkey)
  WHERE cls.relname = 'users'
    AND con.contype = 'c'
    AND att.attname = 'plan';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- 2. Add a named CHECK that includes 'admin'.
ALTER TABLE users ADD CONSTRAINT users_plan_check
  CHECK (plan IN ('free', 'pro', 'team', 'enterprise', 'admin'));
