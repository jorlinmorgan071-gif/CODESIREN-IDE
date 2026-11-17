// tests/unit/make-admin.test.ts
//
// Tests for the admin-promotion path (server/src/auth/admin.ts).
//
// The promotion logic is a pure data-layer operation: validate email,
// check DB availability, look up the user, UPDATE plan='admin'. We mock
// db/client so the test is deterministic and runs in the server CI job
// (which has no live Postgres). The mocked query/isDbAvailable let us
// exercise every branch: invalid email, DB unavailable, user not found,
// success (free→admin), and idempotent re-promotion (admin→admin).
//
// Why this is NOT env/email-driven promotion is documented in admin.ts;
// the test confirms the operator command's contract: exact-email match,
// no auto-promotion, clear failure messages.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  isDbAvailable: vi.fn(),
  query: vi.fn(),
}));

import { promoteToAdmin } from '../../src/auth/admin.js';
import { isDbAvailable, query } from '../../src/db/client.js';

const isDbAvailableMock = vi.mocked(isDbAvailable);
const queryMock = vi.mocked(query);

describe('make-admin / promoteToAdmin', () => {
  beforeEach(() => {
    isDbAvailableMock.mockReset();
    queryMock.mockReset();
  });

  it('rejects an invalid email without touching the DB', async () => {
    const r = await promoteToAdmin('not-an-email');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Invalid email');
    expect(isDbAvailableMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects an empty email without touching the DB', async () => {
    const r = await promoteToAdmin('   ');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Invalid email');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('trims a valid email before lookup', async () => {
    isDbAvailableMock.mockReturnValue(true);
    queryMock
      .mockResolvedValueOnce([{ plan: 'free' }])   // SELECT
      .mockResolvedValueOnce([]);                   // UPDATE
    const r = await promoteToAdmin('  alice@example.com  ');
    expect(r.ok).toBe(true);
    expect(r.email).toBe('alice@example.com');
    // First call was the lookup with the trimmed email.
    expect(queryMock.mock.calls[0][1]).toEqual(['alice@example.com']);
  });

  it('refuses to run in degraded (no-DB) mode with a clear message', async () => {
    isDbAvailableMock.mockReturnValue(false);
    const r = await promoteToAdmin('alice@example.com');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('PostgreSQL is not available');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('reports a clear not-found error when no user matches the email', async () => {
    isDbAvailableMock.mockReturnValue(true);
    queryMock.mockResolvedValueOnce([]); // SELECT → no rows
    const r = await promoteToAdmin('ghost@example.com');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('No user found');
    expect(r.message).toContain('ghost@example.com');
    // No UPDATE attempted when the user doesn't exist.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('promotes a free user to admin and reports the previous plan', async () => {
    isDbAvailableMock.mockReturnValue(true);
    queryMock
      .mockResolvedValueOnce([{ plan: 'free' }])   // SELECT
      .mockResolvedValueOnce([]);                   // UPDATE
    const r = await promoteToAdmin('alice@example.com');
    expect(r.ok).toBe(true);
    expect(r.previousPlan).toBe('free');
    expect(r.message).toContain('plan=admin');
    expect(r.message).toContain('alice@example.com');

    // The UPDATE must set plan='admin' and bump updated_at for that email.
    const updateCall = queryMock.mock.calls[1];
    expect(updateCall[0]).toContain("UPDATE users SET plan = 'admin'");
    expect(updateCall[0]).toContain('updated_at = NOW()');
    expect(updateCall[0]).toContain('WHERE email = $1');
    expect(updateCall[1]).toEqual(['alice@example.com']);
  });

  it('is idempotent: re-promoting an already-admin user still succeeds', async () => {
    isDbAvailableMock.mockReturnValue(true);
    queryMock
      .mockResolvedValueOnce([{ plan: 'admin' }])  // SELECT → already admin
      .mockResolvedValueOnce([]);                   // UPDATE (no-op effect)
    const r = await promoteToAdmin('alice@example.com');
    expect(r.ok).toBe(true);
    expect(r.previousPlan).toBe('admin');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
