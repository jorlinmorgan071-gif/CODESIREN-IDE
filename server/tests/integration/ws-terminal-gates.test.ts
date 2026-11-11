// tests/integration/ws-terminal-gates.test.ts
//
// Integration tests for the two gates on the WS `terminal:create` event:
//
//   Gate 1 — TERMINAL_ENABLED=false (any NODE_ENV)
//     The WS handler must respond with a `terminal:disabled` event containing
//     a human-readable reason. No PTY session is created.
//
//   Gate 2 — Production + non-admin user (TERMINAL_ENABLED=true)
//     The WS handler must respond with a `terminal:denied` event. Hosted
//     deployments expose a real shell to authenticated users — restricting
//     to admins limits the blast radius. Local dev and self-hosted desktop
//     installs are unaffected (config.isProd=false).
//
// Both tests spawn a real `tsx` subprocess that starts a fresh HTTP+WS
// server with the desired env, then connect via a real `ws` client. This
// exercises the full code path: config → ptyManager singleton → WS handler
// → WS message. No mocks.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';

const SERVER_ROOT = resolve(__dirname, '../..');
const FIXTURE = resolve(SERVER_ROOT, 'tests/fixtures/ws-terminal-server.ts');

interface FixtureHandle {
  child: ChildProcess;
  port: number;
  token: string;
}

/** Spawn the fixture with the given env, wait for the `READY:<port>:<token>`
 *  line on stdout, and return the connection info. */
async function startFixture(env: Record<string, string>): Promise<FixtureHandle> {
  const child = spawn('npx', ['tsx', FIXTURE], {
    cwd: SERVER_ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const ready = await new Promise<FixtureHandle>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('fixture did not print READY line within 30s'));
    }, 30000);

    child.stdout.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      const m = line.match(/^READY:(\d+):(.+)$/);
      if (m) {
        clearTimeout(timeout);
        resolvePromise({
          child,
          port: parseInt(m[1], 10),
          token: m[2],
        });
      }
    });

    child.stderr.on('data', (d: Buffer) => {
      // Surface fixture stderr for debugging if the spawn fails.
      process.stderr.write(`[fixture stderr] ${d.toString()}`);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`fixture exited before READY with code ${code}`));
    });
  });

  return ready;
}

function stopFixture(handle: FixtureHandle): Promise<void> {
  return new Promise((resolve) => {
    if (!handle.child || handle.child.exitCode !== null) {
      resolve();
      return;
    }
    handle.child.once('exit', () => resolve());
    handle.child.kill('SIGTERM');
    // Hard kill if it doesn't exit within 5 seconds.
    setTimeout(() => {
      try { handle.child.kill('SIGKILL'); } catch { /* already dead */ }
    }, 5000);
  });
}

/** Connect a WS client, wait for the welcome event, send `terminal:create`,
 *  and resolve with the first non-welcome event the server sends back. */
async function sendTerminalCreate(port: number, token: string): Promise<any> {
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // Discard the welcome (collab:join) event.
  await new Promise<void>((resolve) => {
    ws.once('message', () => resolve());
  });

  // Send terminal:create.
  ws.send(JSON.stringify({ event: 'terminal:create', payload: {} }));

  // Read messages until we see terminal:disabled or terminal:denied
  // (or terminal:ready if neither gate fires — used by negative tests).
  const response = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timeout waiting for terminal:disabled / terminal:denied / terminal:ready'));
    }, 5000);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'terminal:disabled' ||
            msg.event === 'terminal:denied' ||
            msg.event === 'terminal:ready') {
          clearTimeout(timeout);
          resolve(msg);
        }
      } catch { /* ignore non-JSON */ }
    });
  });

  ws.close();
  return response;
}

describe('WS terminal:create gates', () => {
  let fixture: FixtureHandle | null = null;

  afterAll(async () => {
    if (fixture) {
      await stopFixture(fixture);
      fixture = null;
    }
  });

  // ── Gate 1: TERMINAL_ENABLED=false ────────────────────────────────────────
  it('refuses with a `terminal:disabled` event when TERMINAL_ENABLED=false', async () => {
    fixture = await startFixture({
      NODE_ENV: 'test',
      TERMINAL_ENABLED: 'false',
      JWT_SECRET: 'test-secret-at-least-32-chars-long-for-tests-only',
      // The fixture needs the user to be NON-admin so the test verifies gate 1
      // (not gate 2). Gate 2 only fires in production, so we're safe here.
      WS_TEST_USER_PLAN: 'free',
    });

    const response = await sendTerminalCreate(fixture.port, fixture.token);
    expect(response.event).toBe('terminal:disabled');
    expect(response.payload.reason).toMatch(/disabled/i);
  });

  // ── Gate 2: production + non-admin ──────────────────────────────────────
  it('refuses with a `terminal:denied` event in production for non-admin users', async () => {
    // Stop the previous fixture (if any) before starting a new one.
    if (fixture) {
      await stopFixture(fixture);
      fixture = null;
    }

    fixture = await startFixture({
      NODE_ENV: 'production',
      TERMINAL_ENABLED: 'true',
      JWT_SECRET: 'a-strong-production-secret-not-in-the-known-dev-list-32+chars',
      WS_TEST_USER_PLAN: 'free', // non-admin
    });

    const response = await sendTerminalCreate(fixture.port, fixture.token);
    expect(response.event).toBe('terminal:denied');
    expect(response.payload.reason).toMatch(/admin/i);
  });

  // ── Negative: dev + admin user → terminal:ready (no gate fires) ─────────
  it('allows terminal creation in development for any user (terminal:ready)', async () => {
    if (fixture) {
      await stopFixture(fixture);
      fixture = null;
    }

    fixture = await startFixture({
      NODE_ENV: 'development',
      TERMINAL_ENABLED: 'true',
      JWT_SECRET: 'test-secret-at-least-32-chars-long-for-tests-only',
      WS_TEST_USER_PLAN: 'free', // non-admin — but dev mode bypasses gate 2
    });

    const response = await sendTerminalCreate(fixture.port, fixture.token);
    expect(response.event).toBe('terminal:ready');
    expect(typeof response.payload.sessionId).toBe('string');
  });
});
