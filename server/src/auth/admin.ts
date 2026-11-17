// server/src/auth/admin.ts
// Admin promotion — the ONE operator path that grants plan='admin'.
//
// WHY THIS EXISTS (and why it is NOT env- or email-driven)
//   requireAdmin (auth/middleware.ts) and the terminal gate (ws/server.ts)
//   both authorize on `plan === 'admin'`. Before migration 013 the
//   users.plan CHECK constraint excluded 'admin', so against PostgreSQL no
//   DB-backed user could ever be an admin — admin only worked in the
//   degraded in-memory mode. Migration 013 adds 'admin' to the CHECK.
//
//   Emails are NOT verified at signup (auth/routes.ts issues a verification
//   token but does not require it before login). Promoting by email alone —
//   or worse, by an env var like ADMIN_EMAILS — would let anyone who
//   controls an unverified inbox seize admin. So promotion is a deliberate,
//   out-of-band operator action: a human who has verified the user's
//   identity runs `npm run make-admin -- <email>`, which calls this module.
//
//   The user's NEXT login then issues an admin-scoped JWT (signToken reads
//   plan from the users row). Existing tokens are unaffected until they
//   expire or the user re-logs in.
//
// INTERFACE
//   promoteToAdmin(email) — pure data-layer operation. Returns a result
//   object with ok + a human-readable message. Throws only on unexpected
//   DB errors (caller handles). Imported by scripts/make-admin.ts (CLI)
//   and by the unit test (mocked db/client).

import { query, isDbAvailable } from '../db/client.js';

export interface PromoteResult {
  ok: boolean;
  email: string;
  previousPlan?: string;
  message: string;
}

// Deliberately simple — matches zod's z.string().email() intent without
// pulling zod into this module. Good enough to catch a typo'd argv.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Promote the user with the given email to plan='admin'.
 *
 * Behavior:
 *   - Invalid email → ok:false, no DB access.
 *   - PostgreSQL unavailable (degraded in-memory mode) → ok:false with a
 *     clear "run against the configured database" message. Promotion only
 *     makes sense against the persistent users table — an in-memory user
 *     vanishes on restart, so promoting one is meaningless.
 *   - No user with that email → ok:false, tells the operator to register
 *     the account first.
 *   - Success → ok:true, reports the previous plan. The user's next login
 *     issues an admin-scoped JWT.
 *
 * The email is matched exactly (trimmed) — this matches the existing
 * findUserByEmail() lookup in auth/routes.ts. The operator should use the
 * email exactly as it was registered.
 */
export async function promoteToAdmin(email: string): Promise<PromoteResult> {
  const normalized = email.trim();
  if (!normalized || !EMAIL_RE.test(normalized)) {
    return { ok: false, email, message: `Invalid email: "${email}". Usage: npm run make-admin -- <email>` };
  }

  if (!isDbAvailable()) {
    return {
      ok: false,
      email: normalized,
      message:
        'PostgreSQL is not available. make-admin only works against the persistent ' +
        'users table — run it with PG_HOST/PG_DB/PG_USER/PG_PASSWORD pointing at the ' +
        'database (e.g. inside the server container or against the compose `db` service).',
    };
  }

  const rows = await query<{ plan: string }>(
    'SELECT plan FROM users WHERE email = $1',
    [normalized],
  );
  if (rows.length === 0) {
    return {
      ok: false,
      email: normalized,
      message: `No user found with email "${normalized}". Register the account first (POST /api/auth/register), then promote it.`,
    };
  }

  const previousPlan = rows[0].plan;
  await query(
    "UPDATE users SET plan = 'admin', updated_at = NOW() WHERE email = $1",
    [normalized],
  );

  return {
    ok: true,
    email: normalized,
    previousPlan,
    message:
      `Promoted "${normalized}" to plan=admin (was "${previousPlan}"). ` +
      'The user\'s next login issues an admin-scoped JWT; existing tokens are unaffected until they expire.',
  };
}
