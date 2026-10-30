// scripts/perf-dashboard-cached.ts
// Phase 5 — Measure dashboard load with realistic repeat access pattern.
// First call to each endpoint is a MISS, second call is a HIT.
// Reports the total time for "load dashboard view twice" — the realistic
// metric for the cache benefit.

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = '/home/z/my-project/extracted/code_siren/server';
const PORT = 3095;

async function startServer(): Promise<ChildProcess> {
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JWT_SECRET: 'perf-dashboard-cache-secret-32chars-long',
      PORT: String(PORT),
      NODE_ENV: 'production',
    },
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { await sleep(200); return child; }
    } catch { /* */ }
    await sleep(150);
  }
  try { child.kill('SIGKILL'); } catch { /* */ }
  throw new Error('Server did not become ready');
}

async function killServer(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(500) });
      await sleep(500);
    } catch { return; }
  }
  try { child.kill('SIGKILL'); } catch { /* */ }
  await sleep(1000);
}

async function measureEndpoint(token: string, path: string): Promise<{ ms: number; cache: string }> {
  const start = performance.now();
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await res.text();
  return {
    ms: performance.now() - start,
    cache: res.headers.get('x-cache') ?? '?',
  };
}

async function main() {
  console.error('─'.repeat(60));
  console.error('  Dashboard cache benefit measurement');
  console.error('─'.repeat(60));

  const child = await startServer();
  try {
    // Register
    const regRes = await fetch(`http://localhost:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `dash-cache-${Date.now()}@code-siren.local`,
        password: 'dash-cache-password',
        name: 'DashCache',
      }),
    });
    const { token } = await regRes.json() as { token: string };

    const endpoints = [
      '/api/dashboard/system',
      '/api/dashboard/agents',
      '/api/dashboard/execution',
      '/api/dashboard/memory',
      '/api/dashboard/security',
      '/api/dashboard/models',
      '/api/dashboard/tools',
      '/api/dashboard/traces',
      '/api/dashboard/traces-file/info',
      '/api/dashboard/performance',
    ];

    // Round 1: cold (all MISS)
    console.error('Round 1 (cold — all MISS):');
    const r1: Array<{ endpoint: string; ms: number; cache: string }> = [];
    const r1Start = performance.now();
    for (const ep of endpoints) {
      const r = await measureEndpoint(token, ep);
      r1.push({ endpoint: ep, ...r });
      console.error(`  ${r.ms.toFixed(1)}ms ${r.cache} ${ep}`);
    }
    const r1Total = performance.now() - r1Start;
    console.error(`  Round 1 total: ${r1Total.toFixed(1)}ms\n`);

    // Round 2: warm (all HIT, assuming cache hasn't expired)
    console.error('Round 2 (warm — all HIT):');
    const r2: Array<{ endpoint: string; ms: number; cache: string }> = [];
    const r2Start = performance.now();
    for (const ep of endpoints) {
      const r = await measureEndpoint(token, ep);
      r2.push({ endpoint: ep, ...r });
      console.error(`  ${r.ms.toFixed(1)}ms ${r.cache} ${ep}`);
    }
    const r2Total = performance.now() - r2Start;
    console.error(`  Round 2 total: ${r2Total.toFixed(1)}ms\n`);

    const speedup = r1Total / r2Total;
    const improvement = ((r1Total - r2Total) / r1Total) * 100;

    console.error('─'.repeat(60));
    console.error(`  Cold load: ${r1Total.toFixed(1)}ms`);
    console.error(`  Warm load: ${r2Total.toFixed(1)}ms`);
    console.error(`  Speedup:   ${speedup.toFixed(2)}x (${improvement.toFixed(1)}% faster)`);
    console.error('─'.repeat(60));

    const result = {
      timestamp: new Date().toISOString(),
      coldLoadMs: r1Total,
      warmLoadMs: r2Total,
      speedup: speedup,
      improvementPct: improvement,
      coldPerEndpoint: r1,
      warmPerEndpoint: r2,
    };
    const outPath = join(__dirname, 'perf-dashboard-cached.json');
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.error(`Saved: ${outPath}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await killServer(child);
  }
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
