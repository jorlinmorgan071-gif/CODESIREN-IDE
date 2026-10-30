// scripts/perf-loadtest.ts
// Phase 5 Step 5 — Reliability validation.
//
// Tests:
//   1. 100 concurrent requests (load stability)
//   2. Long session stability (1000 sequential requests, check for memory growth)
//   3. Memory leak check (heap before/after, expect < 20% growth)
//
// Usage: npx tsx scripts/perf-loadtest.ts [--label=after]

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = '/home/z/my-project/extracted/code_siren/server';
const PORT = 3096;

const label = process.argv.find((a) => a.startsWith('--label='))?.split('=')[1] ?? 'after';

interface LoadTestResult {
  totalRequests: number;
  successful: number;
  failed: number;
  durationMs: number;
  requestsPerSec: number;
  avgLatencyMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxLatencyMs: number;
  errors: Array<{ status: number; count: number }>;
}

async function startServer(): Promise<ChildProcess> {
  // Verify port is free first
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(300) });
      await sleep(300);
    } catch {
      break;
    }
  }

  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JWT_SECRET: 'perf-loadtest-secret-at-least-32-chars-long',
      PORT: String(PORT),
      NODE_ENV: 'production',
      // Phase 5 — bump rate limits for load testing. Default is 100/min per IP,
      // which would 429 us after ~100 requests. Bump to 10K/min for the test.
      RATE_LIMIT_PER_IP: '10000',
      RATE_LIMIT_PER_USER: '10000',
      RATE_LIMIT_WS_PER_SEC: '1000',
    },
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  // Poll /api/health
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) {
        await sleep(200);
        return child;
      }
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
    } catch {
      return;
    }
  }
  try { child.kill('SIGKILL'); } catch { /* */ }
  await sleep(1000);
}

async function registerUser(): Promise<string> {
  const res = await fetch(`http://localhost:${PORT}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `loadtest-${Date.now()}@code-siren.local`,
      password: 'loadtest-password',
      name: 'LoadTest',
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const body = await res.json() as { token: string };
  return body.token;
}

async function getMemory(token: string): Promise<{ rss: number; heapUsed: number; heapTotal: number }> {
  // Phase 5 — cache TTL is 5s on /api/dashboard/system. To get a fresh
  // memory reading, append ?nocache=1 to bypass the cache.
  const res = await fetch(`http://localhost:${PORT}/api/dashboard/system?nocache=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`getMemory failed: ${res.status}`);
  }
  const body = await res.json() as { memory: { rss: number; heapUsed: number; heapTotal: number } };
  if (!body.memory) {
    throw new Error('getMemory: missing memory field in response');
  }
  return body.memory;
}

async function singleRequest(token: string, path: string): Promise<{ status: number; ms: number; ok: boolean }> {
  const start = performance.now();
  try {
    const res = await fetch(`http://localhost:${PORT}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await res.text();
    return { status: res.status, ms: performance.now() - start, ok: res.ok };
  } catch (err: any) {
    return { status: 0, ms: performance.now() - start, ok: false };
  }
}

async function runConcurrentLoad(token: string, concurrency: number, totalRequests: number): Promise<LoadTestResult> {
  console.error(`  firing ${totalRequests} requests with concurrency=${concurrency}…`);
  const endpoints = [
    '/api/dashboard/system',
    '/api/dashboard/agents',
    '/api/dashboard/execution',
    '/api/dashboard/memory',
    '/api/dashboard/security',
    '/api/dashboard/tools',
    '/api/dashboard/traces',
    '/api/dashboard/performance',
    '/api/health',
  ];

  const latencies: number[] = [];
  const errors = new Map<number, number>();
  let successful = 0;
  let failed = 0;
  let completed = 0;

  const start = Date.now();

  // Use a simple worker pool
  const queue: Array<{ token: string; path: string; idx: number }> = [];
  for (let i = 0; i < totalRequests; i++) {
    queue.push({ token, path: endpoints[i % endpoints.length], idx: i });
  }

  async function worker() {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      const r = await singleRequest(job.token, job.path);
      latencies.push(r.ms);
      if (r.ok) successful++;
      else {
        failed++;
        errors.set(r.status, (errors.get(r.status) ?? 0) + 1);
      }
      completed++;
      if (completed % 50 === 0) {
        console.error(`    ${completed}/${totalRequests} done`);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  const durationMs = Date.now() - start;
  latencies.sort((a, b) => a - b);
  const n = latencies.length;

  return {
    totalRequests,
    successful,
    failed,
    durationMs,
    requestsPerSec: (totalRequests / durationMs) * 1000,
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / n,
    p50Ms: latencies[Math.floor(n * 0.5)],
    p95Ms: latencies[Math.floor(n * 0.95)],
    p99Ms: latencies[Math.floor(n * 0.99)],
    maxLatencyMs: latencies[n - 1],
    errors: Array.from(errors.entries()).map(([status, count]) => ({ status, count })),
  };
}

async function runLongSession(token: string, requestCount: number): Promise<{
  durationMs: number;
  successful: number;
  failed: number;
  memoryBefore: { rss: number; heapUsed: number; heapTotal: number };
  memoryAfter: { rss: number; heapUsed: number; heapTotal: number };
  heapGrowthPct: number;
  rssGrowthPct: number;
}> {
  console.error(`  running ${requestCount} sequential requests…`);
  const memoryBefore = await getMemory(token);
  let successful = 0;
  let failed = 0;
  const start = Date.now();
  const endpoints = ['/api/dashboard/system', '/api/dashboard/agents', '/api/health'];
  for (let i = 0; i < requestCount; i++) {
    const r = await singleRequest(token, endpoints[i % endpoints.length]);
    if (r.ok) successful++;
    else failed++;
    if (i > 0 && i % 200 === 0) {
      console.error(`    ${i}/${requestCount} done`);
    }
  }
  const memoryAfter = await getMemory(token);
  const durationMs = Date.now() - start;
  return {
    durationMs,
    successful,
    failed,
    memoryBefore,
    memoryAfter,
    heapGrowthPct: ((memoryAfter.heapUsed - memoryBefore.heapUsed) / memoryBefore.heapUsed) * 100,
    rssGrowthPct: ((memoryAfter.rss - memoryBefore.rss) / memoryBefore.rss) * 100,
  };
}

async function main() {
  console.error('─'.repeat(60));
  console.error(`  Phase 5 Load Test (label=${label})`);
  console.error('─'.repeat(60));

  const child = await startServer();
  try {
    const token = await registerUser();

    // ── 1. 100 concurrent requests ──────────────────────────────────────
    console.error('[1/3] 100 concurrent requests (load stability)…');
    const concurrent = await runConcurrentLoad(token, 100, 100);

    // ── 2. Long session — 1000 sequential requests ──────────────────────
    console.error('[2/3] 1000 sequential requests (long session stability)…');
    const long = await runLongSession(token, 1000);

    // ── 3. Memory leak check ────────────────────────────────────────────
    console.error('[3/3] Memory leak check…');
    // Take initial measurement, then hammer, then re-measure
    const memBefore = await getMemory(token);
    await runConcurrentLoad(token, 50, 500);
    // Force GC by waiting
    await sleep(2000);
    const memAfter = await getMemory(token);
    const heapGrowthPct = ((memAfter.heapUsed - memBefore.heapUsed) / memBefore.heapUsed) * 100;
    const rssGrowthPct = ((memAfter.rss - memBefore.rss) / memBefore.rss) * 100;

    const result = {
      label,
      timestamp: new Date().toISOString(),
      concurrentLoad: concurrent,
      longSession: long,
      memoryLeak: {
        before: memBefore,
        after: memAfter,
        heapGrowthPct,
        rssGrowthPct,
        leakDetected: heapGrowthPct > 20,
      },
    };

    const outPath = join(__dirname, `perf-loadtest-${label}.json`);
    writeFileSync(outPath, JSON.stringify(result, null, 2));

    console.error('─'.repeat(60));
    console.error('  Summary');
    console.error('─'.repeat(60));
    console.error(`  100 concurrent:`);
    console.error(`    ${concurrent.successful}/${concurrent.totalRequests} ok, ${concurrent.failed} failed`);
    console.error(`    ${concurrent.requestsPerSec.toFixed(1)} req/s, avg=${concurrent.avgLatencyMs.toFixed(1)}ms`);
    console.error(`    p50=${concurrent.p50Ms.toFixed(1)}ms p95=${concurrent.p95Ms.toFixed(1)}ms p99=${concurrent.p99Ms.toFixed(1)}ms`);
    if (concurrent.errors.length > 0) {
      console.error(`    errors: ${JSON.stringify(concurrent.errors)}`);
    }
    console.error(`  Long session (1000 reqs):`);
    console.error(`    ${long.successful}/1000 ok, ${long.failed} failed`);
    console.error(`    ${long.durationMs}ms total, ${(1000 / long.durationMs * 1000).toFixed(1)} req/s`);
    console.error(`    heap growth: ${long.heapGrowthPct.toFixed(1)}%`);
    console.error(`    RSS growth: ${long.rssGrowthPct.toFixed(1)}%`);
    console.error(`  Memory leak check (500 reqs):`);
    console.error(`    heap growth: ${heapGrowthPct.toFixed(1)}%`);
    console.error(`    RSS growth: ${rssGrowthPct.toFixed(1)}%`);
    console.error(`    leak detected: ${result.memoryLeak.leakDetected ? 'YES' : 'no'}`);
    console.error(`\nSaved: ${outPath}`);

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await killServer(child);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
