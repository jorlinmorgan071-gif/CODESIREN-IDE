// scripts/phase7-longrun.ts
// Phase 7 Step 4 — Long-run stability test.
//
// Runs continuous traffic against the server for a configurable duration
// (default 300s / 5 min; operators should run with --duration=3600 for the
// full 1-hour validation called for in the Phase 7 spec).
//
// Every 10s, records a sample:
//   - server RSS + heap (via /api/dashboard/system?nocache=1)
//   - request count + error count + avg latency for the last 10s window
//   - WS connection: open + close + reopen every 60s (simulates reconnect)
//
// At end, reports:
//   - memory growth (start vs end RSS + heap)
//   - stability (any 5xx spikes?)
//   - total errors
//   - reconnect count
//
// Usage:
//   npx tsx scripts/phase7-longrun.ts                       # 5 min default
//   npx tsx scripts/phase7-longrun.ts -- --duration=3600    # 1 hour
//
// Output: phase7-longrun.json + human-readable summary to stderr.

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = '/home/z/my-project/extracted/code_siren/server';
const PORT = 3091;

// Parse duration arg (default 5 min; operators should use 3600 for full hour)
const durArg = process.argv.find((a) => a.startsWith('--duration='));
const DURATION_MS = durArg ? parseInt(durArg.split('=')[1], 10) * 1000 : 300_000;
const SAMPLE_INTERVAL_MS = 10_000;
const RECONNECT_INTERVAL_MS = 60_000;

interface Sample {
  timestamp: number;
  elapsedMs: number;
  rss: number;
  heapUsed: number;
  requests: number;
  errors: number;
  avgLatencyMs: number;
  wsConnected: boolean;
}

async function startServer(): Promise<ChildProcess> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(300) });
      await sleep(300);
    } catch { break; }
  }
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JWT_SECRET: 'phase7-long-secret-at-least-32-chars-long',
      PORT: String(PORT),
      NODE_ENV: 'production',
      RATE_LIMIT_PER_IP: '1000000',
      RATE_LIMIT_PER_USER: '1000000',
      RATE_LIMIT_WS_PER_SEC: '10000',
    },
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { await sleep(300); return child; }
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

async function registerUser(): Promise<string> {
  const res = await fetch(`http://localhost:${PORT}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `long-${Date.now()}@code-siren.local`,
      password: 'long-password',
      name: 'Long Run',
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const body = await res.json() as { token: string };
  return body.token;
}

async function getServerMemory(token: string): Promise<{ rss: number; heapUsed: number }> {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/dashboard/system?nocache=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { rss: 0, heapUsed: 0 };
    const body = await r.json() as { memory: { rss: number; heapUsed: number } };
    return { rss: body.memory.rss, heapUsed: body.memory.heapUsed };
  } catch {
    return { rss: 0, heapUsed: 0 };
  }
}

async function main() {
  console.error('━'.repeat(60));
  console.error(`  Phase 7 — Long Run (${DURATION_MS / 1000}s)`);
  console.error('━'.repeat(60));

  console.error('Starting server…');
  const child = await startServer();
  console.error(`Server ready on port ${PORT}`);

  const samples: Sample[] = [];
  let totalRequests = 0;
  let totalErrors = 0;
  let reconnectCount = 0;
  let wsConnected = false;

  try {
    const token = await registerUser();
    console.error('Test user registered');

    // Open initial WS connection
    let ws: WebSocket | null = null;
    const openWs = () => {
      try {
        ws?.close();
      } catch { /* */ }
      const wsUrl = `ws://localhost:${PORT}/ws?token=${token}&projectId=00000000-0000-0000-0000-000000000000`;
      ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => { wsConnected = true; });
      ws.addEventListener('close', () => { wsConnected = false; });
      ws.addEventListener('error', () => { wsConnected = false; });
    };
    openWs();
    await sleep(500);

    const endpoints = [
      '/api/dashboard/system?nocache=1',
      '/api/dashboard/agents?nocache=1',
      '/api/health',
      '/api/dashboard/tools?nocache=1',
      '/api/dashboard/execution?nocache=1',
    ];

    const startMs = Date.now();
    let lastReconnect = Date.now();
    let windowRequests = 0;
    let windowErrors = 0;
    let windowLatencies: number[] = [];

    // Continuous traffic loop
    let trafficStop = false;
    const trafficPromise = (async () => {
      let i = 0;
      while (!trafficStop) {
        const path = endpoints[i % endpoints.length];
        const t0 = performance.now();
        try {
          const r = await fetch(`http://localhost:${PORT}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          await r.text();
          windowRequests++; totalRequests++;
          if (!r.ok) { windowErrors++; totalErrors++; }
        } catch {
          windowErrors++; totalErrors++;
        }
        windowLatencies.push(performance.now() - t0);
        i++;
        // Small delay between requests
        await sleep(50);
      }
    })();

    // Sampling loop
    while (Date.now() - startMs < DURATION_MS) {
      const elapsedMs = Date.now() - startMs;
      const mem = await getServerMemory(token);

      const avgLatency = windowLatencies.length > 0
        ? windowLatencies.reduce((a, b) => a + b, 0) / windowLatencies.length
        : 0;

      samples.push({
        timestamp: Date.now(),
        elapsedMs,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        requests: windowRequests,
        errors: windowErrors,
        avgLatencyMs: avgLatency,
        wsConnected,
      });

      console.error(`  [${(elapsedMs / 1000).toFixed(0).padStart(4)}s] RSS=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB reqs=${windowRequests} errs=${windowErrors} avg=${avgLatency.toFixed(0)}ms ws=${wsConnected ? 'on' : 'off'}`);

      // Reset window counters
      windowRequests = 0;
      windowErrors = 0;
      windowLatencies = [];

      // Reconnect WS every 60s
      if (Date.now() - lastReconnect > RECONNECT_INTERVAL_MS) {
        reconnectCount++;
        console.error(`  [reconnect #${reconnectCount}]`);
        openWs();
        lastReconnect = Date.now();
        await sleep(500);
      }

      await sleep(SAMPLE_INTERVAL_MS);
    }

    trafficStop = true;
    await trafficPromise;
    try { ws?.close(); } catch { /* */ }

  } finally {
    await killServer(child);
  }

  // ── Analysis ──────────────────────────────────────────────────────
  const first = samples[0];
  const last = samples[samples.length - 1];
  const rssGrowthPct = first && last && first.rss > 0
    ? ((last.rss - first.rss) / first.rss) * 100
    : 0;
  const heapGrowthPct = first && last && first.heapUsed > 0
    ? ((last.heapUsed - first.heapUsed) / first.heapUsed) * 100
    : 0;

  // Find peak
  const peakRss = Math.max(...samples.map((s) => s.rss));
  const peakHeap = Math.max(...samples.map((s) => s.heapUsed));

  // Stability: any sample with errors > 0
  const errorSamples = samples.filter((s) => s.errors > 0).length;
  const stabilityPct = ((samples.length - errorSamples) / samples.length) * 100;

  // Latency stability: max sample avg
  const maxAvgLatency = Math.max(...samples.map((s) => s.avgLatencyMs));

  const output = {
    timestamp: new Date().toISOString(),
    durationMs: DURATION_MS,
    samplesCount: samples.length,
    summary: {
      totalRequests,
      totalErrors,
      errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
      reconnectCount,
      memory: {
        startRss: first?.rss ?? 0,
        endRss: last?.rss ?? 0,
        peakRss,
        rssGrowthPct: parseFloat(rssGrowthPct.toFixed(2)),
        startHeap: first?.heapUsed ?? 0,
        endHeap: last?.heapUsed ?? 0,
        peakHeap,
        heapGrowthPct: parseFloat(heapGrowthPct.toFixed(2)),
      },
      stability: {
        stabilityPct: parseFloat(stabilityPct.toFixed(2)),
        errorSamples,
        maxAvgLatencyMs: parseFloat(maxAvgLatency.toFixed(2)),
      },
    },
    targetMet: {
      memoryGrowthUnder20pct: heapGrowthPct < 20,
      stabilityAbove99pct: stabilityPct >= 99,
      errorsUnder1pct: totalRequests > 0 ? (totalErrors / totalRequests) * 100 < 1 : true,
    },
    samples,
  };

  const allTargetsMet = output.targetMet.memoryGrowthUnder20pct
    && output.targetMet.stabilityAbove99pct
    && output.targetMet.errorsUnder1pct;

  const outPath = join(__dirname, 'phase7-longrun.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.error('');
  console.error('━'.repeat(60));
  console.error('  Summary');
  console.error('━'.repeat(60));
  console.error(`  Duration: ${(DURATION_MS / 1000).toFixed(0)}s (${samples.length} samples)`);
  console.error(`  Total requests: ${totalRequests}`);
  console.error(`  Total errors: ${totalErrors} (${output.summary.errorRate.toFixed(2)}%)`);
  console.error(`  Reconnects: ${reconnectCount}`);
  console.error(`  RSS: start=${(output.summary.memory.startRss / 1024 / 1024).toFixed(0)}MB end=${(output.summary.memory.endRss / 1024 / 1024).toFixed(0)}MB peak=${(peakRss / 1024 / 1024).toFixed(0)}MB growth=${rssGrowthPct.toFixed(1)}%`);
  console.error(`  Heap: start=${(output.summary.memory.startHeap / 1024 / 1024).toFixed(0)}MB end=${(output.summary.memory.endHeap / 1024 / 1024).toFixed(0)}MB peak=${(peakHeap / 1024 / 1024).toFixed(0)}MB growth=${heapGrowthPct.toFixed(1)}%`);
  console.error(`  Stability: ${stabilityPct.toFixed(1)}% (${errorSamples} samples with errors)`);
  console.error(`  Max avg latency: ${maxAvgLatency.toFixed(0)}ms`);
  console.error('');
  console.error(`  Memory growth <20%: ${output.targetMet.memoryGrowthUnder20pct ? 'YES' : 'NO'}`);
  console.error(`  Stability ≥99%: ${output.targetMet.stabilityAbove99pct ? 'YES' : 'NO'}`);
  console.error(`  Errors <1%: ${output.targetMet.errorsUnder1pct ? 'YES' : 'NO'}`);
  console.error(`  ${allTargetsMet ? '✓ TARGET MET' : '✗ TARGET NOT MET'}`);
  console.error(`\nSaved: ${outPath}`);

  console.log(JSON.stringify(output, null, 2));
  process.exit(allTargetsMet ? 0 : 1);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
