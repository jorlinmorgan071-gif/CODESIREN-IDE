// server/scripts/make-admin.ts
// Operator CLI: promote an existing user to plan='admin'.
//
// Usage:
//   npm run make-admin -- <email>
//
//   docker compose exec server npm run make-admin -- alice@example.com
//
// Why an operator command and not env/email promotion:
//   Emails are not verified at signup (auth/routes.ts issues a verification
//   token but does not require it before login). Promoting by an env var
//   like ADMIN_EMAILS, or by email alone, would let anyone who controls an
//   unverified inbox seize admin. So promotion is a deliberate out-of-band
//   action by an operator who has verified the user's identity.
//
// What it does:
//   - Validates the email argument.
//   - Connects to the configured Postgres (initDb).
//   - UPDATEs users SET plan='admin' WHERE email=$1 (via auth/admin.ts).
//   - Prints the result and exits 0 on success, 1 on failure, 2 on bad usage.
//
// The user's NEXT login issues an admin-scoped JWT. Existing tokens are
// unaffected until they expire or the user re-logs in.

import { promoteToAdmin } from '../src/auth/admin.js';
import { initDb, closeDb } from '../src/db/client.js';

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run make-admin -- <email>');
    console.error('');
    console.error('Promotes the user with the given email to plan=admin.');
    console.error('The account must already exist — register it first (POST /api/auth/register),');
    console.error('then run this command with the exact registered email.');
    console.error('');
    console.error('Example:');
    console.error('  npm run make-admin -- alice@example.com');
    console.error('  docker compose exec server npm run make-admin -- alice@example.com');
    process.exit(2);
  }

  await initDb();
  try {
    const result = await promoteToAdmin(email);
    if (result.ok) {
      console.log(`✓ ${result.message}`);
      process.exit(0);
    }
    console.error(`✗ ${result.message}`);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error('✗ make-admin failed:', err);
  process.exit(1);
});
