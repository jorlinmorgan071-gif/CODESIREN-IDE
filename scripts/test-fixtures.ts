// scripts/test-fixtures.ts
//
// Shared test credentials for the scripts/ and server/scripts/ harnesses.
//
// WHY THIS EXISTS
// The repo had 19 scripts with hardcoded literal passwords
// ('test-password-123', 'e2e-password-123', 'perf-password-baseline',
// 'load-admin-password', etc.). These are not real secrets — they're test
// fixtures used to register throwaway accounts against a local dev server —
// but they triggered secret scanners and looked bad to buyers.
//
// This module centralizes them behind a single process.env read so:
//   1. No literal password string appears in more than one place.
//   2. CI / gitleaks can allowlist this one file instead of 19.
//   3. Operators can override the password via TEST_PASSWORD for parallel
//      test runs that need isolated credentials.
//
// USAGE
//   import { TEST_PASSWORD, testEmail } from './test-fixtures.js';
//   const res = await fetch(`${BASE}/api/auth/register`, {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ email: testEmail('bench'), password: TEST_PASSWORD, name: 'Bench' }),
//   });

/**
 * The password used to register test accounts during script-driven harness
 * runs. Reads from process.env.TEST_PASSWORD so operators can override it;
 * falls back to a single documented default that lives ONLY here.
 */
export const TEST_PASSWORD: string =
  process.env.TEST_PASSWORD ?? 'test-password-fixture-change-me';

/**
 * Generate a unique test email. The scripts register throwaway accounts
 * against a local dev server — each run needs a fresh email to avoid
 * collisions with prior runs.
 *
 * @param prefix  logical label for the test (e.g. 'bench', 'e2e', 'load')
 * @returns        `<prefix>-<timestamp>-<random>@code-siren.test`
 */
export function testEmail(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}@code-siren.test`;
}

/**
 * The admin password used by scripts that need an admin-tier account.
 * Separate from TEST_PASSWORD so the two roles can have different
 * credentials in hardened test environments.
 */
export const TEST_ADMIN_PASSWORD: string =
  process.env.TEST_ADMIN_PASSWORD ?? 'admin-fixture-password-change-me';
