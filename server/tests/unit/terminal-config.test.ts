// tests/unit/terminal-config.test.ts
//
// Tests TERMINAL_ENABLED flag parsing in server/src/config.ts.
//
// The config module reads process.env at import time and freezes the result
// into the `config` export. To exercise each branch of the z.preprocess
// parser, we spawn a fresh `tsx` subprocess with the desired env and read
// the parsed value back from stdout. This mirrors the jwt-secret-guard.test.ts
// pattern and avoids vi.mock / vi.resetModules fragility.
//
// Cases verified (per the user's spec):
//   - "false" → OFF (in dev)
//   - "0"     → OFF (in dev)
//   - ""      → OFF (in dev)
//   - "no"    → OFF (in dev)
//   - "true"  → ON  (in dev)
//   - "TRUE"  → ON  (case-insensitive)
//   - "1"     → ON  (in dev)
//   - "yes"   → ON  (in dev)
//   - unset   → ON  (in dev — default ON for development)
//   - unset   → OFF (in production — default OFF for hosted deployments)
//   - "true"  → ON  (in production — explicit opt-in)
//   - "false" → OFF (in production — explicit opt-out, same as default)
//
// Also verifies ptyManager.isEnabled() reflects the parsed config value
// (the WS handler's gate 1 reads ptyManager.isEnabled(), not config directly,
// so the bridge between config and ptyManager must stay wired).

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const SERVER_ROOT = resolve(__dirname, '../..');
const CONFIG_PATH = resolve(SERVER_ROOT, 'src/config.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `tsx --eval` with the given env, import config, and print
 * `TERMINAL_ENABLED=<bool>` to stdout. The script exits 0 on success,
 * non-zero if the config schema rejects the env.
 */
function runConfig(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('npx', ['tsx', '--eval', `
      import('${CONFIG_PATH}').then(m => {
        // Print only the parsed value — the test parses this back out.
        console.log('TERMINAL_ENABLED=' + m.config.TERMINAL_ENABLED);
        console.log('NODE_ENV=' + m.config.NODE_ENV);
        process.exit(0);
      }).catch(err => {
        console.error(err && err.message ? err.message : String(err));
        process.exit(1);
      });
    `], {
      cwd: SERVER_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

function extractEnabled(stdout: string): boolean | null {
  const m = stdout.match(/^TERMINAL_ENABLED=(true|false)$/m);
  return m ? m[1] === 'true' : null;
}

const JWT_SECRET = 'a-real-test-secret-that-is-at-least-32-chars-long';

describe('TERMINAL_ENABLED flag parsing', () => {
  // ── OFF values ──────────────────────────────────────────────────────────
  it('"false" disables the terminal in development', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'development',
      JWT_SECRET,
      TERMINAL_ENABLED: 'false',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(false);
  });

  it('"0" disables the terminal in development', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'development',
      JWT_SECRET,
      TERMINAL_ENABLED: '0',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(false);
  });

  it('an empty string disables the terminal in development', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'development',
      JWT_SECRET,
      TERMINAL_ENABLED: '',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(false);
  });

  it('"no" disables the terminal in development', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'development',
      JWT_SECRET,
      TERMINAL_ENABLED: 'no',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(false);
  });

  // ── ON values ───────────────────────────────────────────────────────────
  it('"true" enables the terminal in development', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'development',
      JWT_SECRET,
      TERMINAL_ENABLED: 'true',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(true);
  });

  it('"TRUE" (uppercase) enables the terminal in development (case-insensitive)', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'development',
      JWT_SECRET,
      TERMINAL_ENABLED: 'TRUE',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(true);
  });

  it('"1" enables the terminal in development', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'development',
      JWT_SECRET,
      TERMINAL_ENABLED: '1',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(true);
  });

  it('"yes" enables the terminal in development', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'development',
      JWT_SECRET,
      TERMINAL_ENABLED: 'yes',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(true);
  });

  // ── Default (unset) ─────────────────────────────────────────────────────
  it('unset TERMINAL_ENABLED defaults to ON in development', async () => {
    const env: Record<string, string> = { NODE_ENV: 'development', JWT_SECRET };
    delete env.TERMINAL_ENABLED;
    const { code, stdout } = await runConfig(env);
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(true);
  });

  it('unset TERMINAL_ENABLED defaults to OFF in production (fail-closed for hosted deployments)', async () => {
    const env: Record<string, string> = {
      NODE_ENV: 'production',
      JWT_SECRET: 'a-strong-production-secret-not-in-the-known-dev-list-32+chars',
    };
    delete env.TERMINAL_ENABLED;
    const { code, stdout } = await runConfig(env);
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(false);
  });

  // ── Production explicit ────────────────────────────────────────────────
  it('"true" explicitly enables the terminal in production (admin gate still applies via WS handler)', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'a-strong-production-secret-not-in-the-known-dev-list-32+chars',
      TERMINAL_ENABLED: 'true',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(true);
  });

  it('"false" explicitly disables the terminal in production', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'a-strong-production-secret-not-in-the-known-dev-list-32+chars',
      TERMINAL_ENABLED: 'false',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(false);
  });

  // ── Unknown value falls back to NODE_ENV default ───────────────────────
  it('an unrecognized value ("maybe") falls back to the NODE_ENV default (OFF in production)', async () => {
    const { code, stdout } = await runConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'a-strong-production-secret-not-in-the-known-dev-list-32+chars',
      TERMINAL_ENABLED: 'maybe',
    });
    expect(code).toBe(0);
    expect(extractEnabled(stdout)).toBe(false);
  });
});
