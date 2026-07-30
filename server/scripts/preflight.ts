// server/scripts/preflight.ts
// Phase 6 — Pre-startup validation. Run BEFORE `npm run dev` to catch
// environment issues early.
//
// Checks:
//   1. Node version (≥ 20)
//   2. .env file exists and parses
//   3. Required env vars set (JWT_SECRET ≥ 32 chars, PORT valid)
//   4. Port available (or already in use by a previous instance — warn)
//   5. (warn-only) Postgres reachable
//   6. (warn-only) Ollama reachable
//   7. (warn-only) tsx + vitest installed
//   8. Critical dependencies resolvable (express, ws, pg, etc.)
//
// Exit codes:
//   0 = all critical checks passed (warnings allowed)
//   1 = at least one critical check failed

import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, '..');

interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, fn: () => CheckResult): void {
  try {
    results.push(fn());
  } catch (err: any) {
    results.push({ name, status: 'fail', detail: `threw: ${err.message}` });
  }
}

// ── 1. Node version ──────────────────────────────────────────────────────

check('Node version', () => {
  const v = process.versions.node;
  const major = parseInt(v.split('.')[0], 10);
  if (major < 20) {
    return { name: 'Node version', status: 'fail', detail: `Node ${v} — need ≥ 20. Upgrade: nvm use 20` };
  }
  return { name: 'Node version', status: 'pass', detail: `Node ${v}` };
});

// ── 2. .env file ─────────────────────────────────────────────────────────

check('.env file', () => {
  const envPath = join(SERVER_DIR, '.env');
  if (!existsSync(envPath)) {
    return { name: '.env file', status: 'fail', detail: 'missing — copy .env.example to .env' };
  }
  const content = readFileSync(envPath, 'utf8');
  if (content.length < 10) {
    return { name: '.env file', status: 'warn', detail: 'file exists but looks empty' };
  }
  return { name: '.env file', status: 'pass', detail: `${content.split('\n').length} lines` };
});

// ── 3. Required env vars ─────────────────────────────────────────────────

check('JWT_SECRET', () => {
  // Load .env manually (don't import config.ts — it would exit on failure)
  const envPath = join(SERVER_DIR, '.env');
  if (!existsSync(envPath)) {
    return { name: 'JWT_SECRET', status: 'fail', detail: '.env missing' };
  }
  const content = readFileSync(envPath, 'utf8');
  const match = content.match(/^JWT_SECRET=(.+)$/m);
  if (!match) {
    return { name: 'JWT_SECRET', status: 'fail', detail: 'JWT_SECRET not set in .env' };
  }
  const secret = match[1].trim().replace(/^["']|["']$/g, '');
  if (secret.length < 32) {
    return { name: 'JWT_SECRET', status: 'fail', detail: `${secret.length} chars — need ≥ 32. Generate: openssl rand -hex 32` };
  }
  if (secret.includes('change-me') || secret.includes('dev-only')) {
    return { name: 'JWT_SECRET', status: 'warn', detail: 'looks like a dev placeholder — change for production' };
  }
  return { name: 'JWT_SECRET', status: 'pass', detail: `${secret.length} chars` };
});

check('PORT', () => {
  const port = parseInt(process.env.PORT ?? '3001', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { name: 'PORT', status: 'fail', detail: `invalid: ${process.env.PORT}` };
  }
  return { name: 'PORT', status: 'pass', detail: String(port) };
});

// ── 4. Port availability ─────────────────────────────────────────────────
// (Checked async in main() below — sync check() doesn't await Promises)

// ── 5. Postgres (warn-only) ──────────────────────────────────────────────

// ── 6. Ollama (warn-only) ────────────────────────────────────────────────

// ── 7. Dependencies ──────────────────────────────────────────────────────

check('node_modules present', () => {
  const nmPath = join(SERVER_DIR, 'node_modules');
  if (!existsSync(nmPath)) {
    return { name: 'node_modules', status: 'fail', detail: 'missing — run npm install' };
  }
  return { name: 'node_modules', status: 'pass', detail: 'present' };
});

check('express installed', () => {
  try {
    accessSync(join(SERVER_DIR, 'node_modules', 'express', 'package.json'), constants.R_OK);
    return { name: 'express', status: 'pass', detail: 'installed' };
  } catch {
    return { name: 'express', status: 'fail', detail: 'missing — run npm install' };
  }
});

check('ws installed', () => {
  try {
    accessSync(join(SERVER_DIR, 'node_modules', 'ws', 'package.json'), constants.R_OK);
    return { name: 'ws', status: 'pass', detail: 'installed' };
  } catch {
    return { name: 'ws', status: 'fail', detail: 'missing — run npm install' };
  }
});

check('pg installed', () => {
  try {
    accessSync(join(SERVER_DIR, 'node_modules', 'pg', 'package.json'), constants.R_OK);
    return { name: 'pg', status: 'pass', detail: 'installed' };
  } catch {
    return { name: 'pg', status: 'fail', detail: 'missing — run npm install' };
  }
});

check('isolated-vm installed', () => {
  try {
    accessSync(join(SERVER_DIR, 'node_modules', 'isolated-vm', 'package.json'), constants.R_OK);
    return { name: 'isolated-vm', status: 'pass', detail: 'installed' };
  } catch {
    return { name: 'isolated-vm', status: 'warn', detail: 'missing — sandbox will fail to load (npm install)' };
  }
});

check('tsx installed', () => {
  try {
    accessSync(join(SERVER_DIR, 'node_modules', 'tsx', 'package.json'), constants.R_OK);
    return { name: 'tsx', status: 'pass', detail: 'installed' };
  } catch {
    return { name: 'tsx', status: 'fail', detail: 'missing — run npm install' };
  }
});

check('vitest installed', () => {
  try {
    accessSync(join(SERVER_DIR, 'node_modules', 'vitest', 'package.json'), constants.R_OK);
    return { name: 'vitest', status: 'pass', detail: 'installed' };
  } catch {
    return { name: 'vitest', status: 'warn', detail: 'missing — tests will fail (npm install)' };
  }
});

// ── 8. TypeScript config ─────────────────────────────────────────────────

check('tsconfig.json', () => {
  const tsconfigPath = join(SERVER_DIR, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return { name: 'tsconfig.json', status: 'fail', detail: 'missing' };
  }
  try {
    readFileSync(tsconfigPath, 'utf8');
    return { name: 'tsconfig.json', status: 'pass', detail: 'present' };
  } catch {
    return { name: 'tsconfig.json', status: 'fail', detail: 'unreadable' };
  }
});

// ── Async checks (Postgres, Ollama) ──────────────────────────────────────

async function checkPostgres(): Promise<CheckResult> {
  const host = process.env.PG_HOST ?? 'localhost';
  const port = parseInt(process.env.PG_PORT ?? '5432', 10);
  // Use a TCP connection check (don't require pg to be loaded)
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        name: 'Postgres reachable',
        status: 'warn',
        detail: `timeout connecting to ${host}:${port} — server will run in degraded in-memory mode`,
      });
    }, 2000);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        name: 'Postgres reachable',
        status: 'pass',
        detail: `${host}:${port} is accepting connections`,
      });
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve({
        name: 'Postgres reachable',
        status: 'warn',
        detail: `cannot connect to ${host}:${port} — server will run in degraded in-memory mode`,
      });
    });
  });
}

async function checkPortAvailable(): Promise<CheckResult> {
  const port = parseInt(process.env.PORT ?? '3001', 10);
  return new Promise((resolve) => {
    const tester = createConnection({ port, host: 'localhost' });
    const timer = setTimeout(() => {
      tester.destroy();
      resolve({
        name: 'Port available',
        status: 'warn',
        detail: `port ${port} check timed out`,
      });
    }, 1000);
    tester.on('connect', () => {
      clearTimeout(timer);
      tester.destroy();
      resolve({
        name: 'Port available',
        status: 'warn',
        detail: `port ${port} already in use — is the server already running? (this is OK if so)`,
      });
    });
    tester.on('error', () => {
      clearTimeout(timer);
      resolve({
        name: 'Port available',
        status: 'pass',
        detail: `port ${port} is free`,
      });
    });
  });
}

async function checkOllama(): Promise<CheckResult> {
  const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.json() as { models?: unknown[] };
      return {
        name: 'Ollama reachable',
        status: 'pass',
        detail: `${host} — ${body.models?.length ?? 0} models available`,
      };
    }
    return {
      name: 'Ollama reachable',
      status: 'warn',
      detail: `${host} returned ${res.status} — server will fall back to stub engine`,
    };
  } catch {
    return {
      name: 'Ollama reachable',
      status: 'warn',
      detail: `${host} unreachable — server will fall back to stub engine`,
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('━'.repeat(60));
  console.log('  Code Siren Preflight — Pre-startup Validation');
  console.log('━'.repeat(60));
  console.log('');

  // Sync checks first
  for (const r of results) {
    printCheck(r);
  }

  // Async checks
  const portCheck = await checkPortAvailable();
  printCheck(portCheck);
  const pg = await checkPostgres();
  printCheck(pg);
  const ollama = await checkOllama();
  printCheck(ollama);

  // Summary
  const all = [...results, portCheck, pg, ollama];
  const fails = all.filter((r) => r.status === 'fail');
  const warns = all.filter((r) => r.status === 'warn');
  const passes = all.filter((r) => r.status === 'pass');

  console.log('');
  console.log('━'.repeat(60));
  console.log(`  ${passes.length} passed · ${warns.length} warnings · ${fails.length} failures`);
  console.log('━'.repeat(60));

  if (fails.length > 0) {
    console.log('');
    console.log('  Critical issues:');
    for (const f of fails) {
      console.log(`    ✗ ${f.name}: ${f.detail}`);
    }
    console.log('');
    console.log('  Fix the issues above, then re-run: npm run preflight');
    process.exit(1);
  }

  if (warns.length > 0) {
    console.log('');
    console.log('  Warnings (non-blocking):');
    for (const w of warns) {
      console.log(`    ⚠ ${w.name}: ${w.detail}`);
    }
  }

  console.log('');
  console.log('  ✓ Preflight passed. Ready to start: npm run dev');
  process.exit(0);
}

function printCheck(r: CheckResult): void {
  const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
  const color = r.status === 'pass' ? '\x1b[32m' : r.status === 'warn' ? '\x1b[33m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`  ${color}${icon}${reset} ${r.name.padEnd(28)} ${r.detail}`);
}

main().catch((err) => {
  console.error('preflight fatal:', err);
  process.exit(1);
});
