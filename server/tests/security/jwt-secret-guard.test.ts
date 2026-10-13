// Tests for the production JWT secret guard in server/src/config.ts.
//
// The guard prevents the server from starting when NODE_ENV=production and
// JWT_SECRET is one of the known dev defaults shipped in .env.example.
// This protects against the footgun of deploying with a leaked dev secret
// that anyone with repo access can use to forge JWTs.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const SERVER_ROOT = resolve(__dirname, '../..');
const CONFIG_PATH = resolve(SERVER_ROOT, 'src/config.ts');

function runConfig(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('npx', ['tsx', '--eval', `import('${CONFIG_PATH}')`], {
      cwd: SERVER_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stderr });
    });
  });
}

describe('Production JWT secret guard', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear env vars that could interfere
    delete process.env.JWT_SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('refuses to start in production with the .env.example default JWT_SECRET', async () => {
    const { code, stderr } = await runConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'dev-only-change-me-in-production-32-chars-min',
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain('FATAL');
    expect(stderr).toContain('known dev default');
  });

  it('refuses to start in production with other known weak defaults', async () => {
    const { code, stderr } = await runConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'test-secret-32-chars-minimum-padding',
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain('FATAL');
  });

  it('starts normally in development with the dev default JWT_SECRET', async () => {
    const { code, stderr } = await runConfig({
      NODE_ENV: 'development',
      JWT_SECRET: 'dev-only-change-me-in-production-32-chars-min',
    });
    expect(code).toBe(0);
    expect(stderr).not.toContain('FATAL');
  });

  it('starts normally in production with a strong custom JWT_SECRET', async () => {
    const { code, stderr } = await runConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'a-real-production-secret-generated-with-openssl-rand-hex-32',
    });
    expect(code).toBe(0);
    expect(stderr).not.toContain('FATAL');
  });
});
