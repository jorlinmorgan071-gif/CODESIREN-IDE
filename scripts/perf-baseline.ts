// scripts/perf-baseline.ts
// Phase 5 Step 1 — Baseline measurement for Code Siren server + app.
//
// Measures:
//   1. Cold boot time      — server startup to "HTTP http://localhost:PORT"
//   2. Warm boot time      — restart after cold (modules cached)
//   3. Agent latency       — POST /api/agents/:id/send → first WS chunk
//   4. Memory usage        — process.memoryUsage() at steady state
//   5. Trace lookup        — GET /api/traces/:taskId (existing task)
//   6. Dashboard load      — GET all 10 /api/dashboard/* sequentially
//   7. Build duration      — `npm run build` for app
//   8. Bundle size         — dist/assets/index-*.js + .css
//
// Usage: npx tsx scripts/perf-baseline.ts [--label=baseline|after] [--skip-build] [--skip-warm]
//
// Output: JSON to stdout + human-readable summary to stderr.
// Saves a JSON snapshot to /home/z/my-project/scripts/perf-<label>.json

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = '/home/z/my-project/extracted/code_siren/server';
const APP_DIR = '/home/z/my-project/extracted/code_siren/app';
const PORT = 3098;

const label = process.argv.find((a) => a.startsWith('--label='))?.split('=')[1] ?? 'baseline';
const skipBuild = process.argv.includes('--skip-build');
const skipWarm = process.argv.includes('--skip-warm');

interface Metrics {
  label: string;
  timestamp: string;
  coldBootMs: number;
  warmBootMs: number;
  agentLatencyMs: number;        // POST send → first WS chunk
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  traceLookupMs: number;         // GET /api/traces/:taskId
  dashboardLoadMs: number;       // sum of all 10 dashboard GETs
  dashboardEndpoints: Array<{ endpoint: string; ms: number; status: number }>;
  buildDurationMs: number;
  bundleSize: {
    jsBytes: number;
    cssBytes: number;
    jsHuman: string;
    cssHuman: string;
  };
}

async function waitForServerReady(child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const onStdout = (chunk: Buffer) => {
      const s = chunk.toString();
      if (s.includes(`HTTP  http://localhost:${PORT}`)) {
        child.stdout?.off('data', onStdout);
        resolve();
      }
      if (Date.now() - start > timeoutMs) {
        child.stdout?.off('data', onStdout);
        reject(new Error(`Server not ready in ${timeoutMs}ms`));
      }
    };
    child.stdout?.on('data', onStdout);
  });
}

async function startServer(): Promise<{ child: ChildProcess; ready: number; started: number }> {
  const started = Date.now();
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JWT_SECRET: 'perf-baseline-secret-at-least-32-chars-long',
      PORT: String(PORT),
      NODE_ENV: 'production',
    },
  });
  await waitForServerReady(child);
  const ready = Date.now();
  return { child, ready, started };
}

async function registerUser(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`http://localhost:${PORT}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `perf-${Date.now()}@code-siren.local`,
      password: 'perf-password-baseline',
      name: 'Perf Baseline',
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const body = await res.json() as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

async function sendAgentTask(token: string): Promise<{ taskId: string; firstChunkMs: number }> {
  const sendStart = Date.now();
  const wsUrl = `ws://localhost:${PORT}/ws?token=${token}&projectId=00000000-0000-0000-0000-000000000000`;
  // Use the global WebSocket (Node 22+ has it native)
  const ws = new WebSocket(wsUrl);

  // Wait for WS open
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e: Event) => reject(new Error('WS error: ' + (e as ErrorEvent).message ?? 'unknown')));
    setTimeout(() => reject(new Error('WS open timeout')), 5000);
  });

  // Set up listener for first agent:chunk BEFORE we send the task
  const firstChunkPromise = new Promise<number>((resolve) => {
    const handler = (ev: MessageEvent) => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.event === 'agent:chunk' || evt.event === 'agent:complete' || evt.event === 'agent:error') {
          ws.removeEventListener('message', handler);
          resolve(Date.now() - sendStart);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
  });

  // Send task to architect agent (uses stub engine — fast)
  const sendRes = await fetch(`http://localhost:${PORT}/api/agents/architect-agent/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      description: 'perf baseline test — say hello',
      type: 'chat',
      executionMode: 'single-shot',
      origin: 'api',
    }),
  });
  if (!sendRes.ok) throw new Error(`send failed: ${sendRes.status}`);
  const sendBody = await sendRes.json() as { taskId: string };

  // Wait for first chunk (timeout 10s)
  const firstChunkMs = await Promise.race([
    firstChunkPromise,
    sleep(10_000).then(() => -1),
  ]);

  ws.close();
  return { taskId: sendBody.taskId, firstChunkMs };
}

async function measureEndpoint(token: string, path: string): Promise<{ ms: number; status: number }> {
  const start = Date.now();
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Drain body
  await res.text();
  return { ms: Date.now() - start, status: res.status };
}

async function measureDashboardLoad(token: string): Promise<{ totalMs: number; perEndpoint: Array<{ endpoint: string; ms: number; status: number }> }> {
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
  const perEndpoint: Array<{ endpoint: string; ms: number; status: number }> = [];
  const totalStart = Date.now();
  for (const ep of endpoints) {
    const r = await measureEndpoint(token, ep);
    perEndpoint.push({ endpoint: ep, ms: r.ms, status: r.status });
  }
  return { totalMs: Date.now() - totalStart, perEndpoint };
}

async function measureBuild(): Promise<{ durationMs: number; jsBytes: number; cssBytes: number }> {
  const start = Date.now();
  const result = spawn('npm', ['run', 'build'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  result.stdout?.on('data', (c) => stdout.push(c.toString()));
  result.stderr?.on('data', (c) => stderr.push(c.toString()));
  await new Promise<void>((resolve) => result.on('close', () => resolve()));
  const durationMs = Date.now() - start;

  // Find the JS + CSS bundle sizes
  const assetsDir = join(APP_DIR, 'dist', 'assets');
  let jsBytes = 0;
  let cssBytes = 0;
  if (existsSync(assetsDir)) {
    for (const file of readdirSync(assetsDir)) {
      const stat = statSync(join(assetsDir, file));
      if (file.endsWith('.js')) jsBytes += stat.size;
      else if (file.endsWith('.css')) cssBytes += stat.size;
    }
  }
  return { durationMs, jsBytes, cssBytes };
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
}

async function main() {
  console.error('─'.repeat(60));
  console.error(`  Phase 5 Baseline Measurement (label=${label})`);
  console.error('─'.repeat(60));

  // ── 1. Cold boot ──────────────────────────────────────────────────────
  console.error('[1/8] Cold boot…');
  const coldStart = Date.now();
  const { child, ready, started } = await startServer();
  const coldBootMs = ready - coldStart;
  console.error(`  cold boot: ${coldBootMs}ms`);

  // Register user (needed for all subsequent calls)
  const { token } = await registerUser();

  // ── 2. Warm boot — kill + restart, tsx cache is warm ──────────────────
  let warmBootMs = 0;
  let child2 = child;
  if (skipWarm) {
    console.error('[2/8] Warm boot — SKIPPED (--skip-warm)');
  } else {
    console.error('[2/8] Warm boot…');
    child.kill('SIGTERM');
    await sleep(2500);
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    await sleep(1500);
    const warmStart = Date.now();
    const warm = await startServer();
    child2 = warm.child;
    warmBootMs = Date.now() - warmStart;
    console.error(`  warm boot: ${warmBootMs}ms`);
  }

  // Re-register (token from cold boot is still valid since same JWT secret)
  // Reuse same token — JWT is stateless.

  // ── 3. Agent latency ──────────────────────────────────────────────────
  console.error('[3/8] Agent latency…');
  const { taskId, firstChunkMs } = await sendAgentTask(token);
  console.error(`  agent latency (send → first chunk): ${firstChunkMs}ms  (taskId=${taskId.slice(0, 8)})`);

  // Wait for trace to be persisted
  await sleep(500);

  // ── 5. Trace lookup ───────────────────────────────────────────────────
  console.error('[4/8] Trace lookup…');
  const traceResult = await measureEndpoint(token, `/api/traces/${taskId}`);
  console.error(`  trace lookup: ${traceResult.ms}ms (status ${traceResult.status})`);

  // ── 6. Dashboard load ─────────────────────────────────────────────────
  console.error('[5/8] Dashboard load…');
  const dash = await measureDashboardLoad(token);
  console.error(`  dashboard load (10 endpoints): ${dash.totalMs}ms`);

  // ── 4. Memory usage ───────────────────────────────────────────────────
  console.error('[6/8] Memory usage…');
  const memRes = await fetch(`http://localhost:${PORT}/api/dashboard/system`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const memBody = await memRes.json() as { memory: { rss: number; heapUsed: number; heapTotal: number; external: number } };
  console.error(`  RSS: ${formatBytes(memBody.memory.rss)}, heap used: ${formatBytes(memBody.memory.heapUsed)}`);

  // Kill server before build measurement
  child2.kill('SIGTERM');
  await sleep(500);
  child2.kill('SIGKILL');

  // ── 7. Build duration ─────────────────────────────────────────────────
  let build = { durationMs: 0, jsBytes: 0, cssBytes: 0 };
  if (skipBuild) {
    console.error('[7/8] Build duration — SKIPPED (--skip-build)');
    // Still measure bundle size from existing dist
    const assetsDir = join(APP_DIR, 'dist', 'assets');
    if (existsSync(assetsDir)) {
      for (const file of readdirSync(assetsDir)) {
        const stat = statSync(join(assetsDir, file));
        if (file.endsWith('.js')) build.jsBytes += stat.size;
        else if (file.endsWith('.css')) build.cssBytes += stat.size;
      }
    }
  } else {
    console.error('[7/8] Build duration…');
    build = await measureBuild();
    console.error(`  build: ${build.durationMs}ms, JS: ${formatBytes(build.jsBytes)}, CSS: ${formatBytes(build.cssBytes)}`);
  }

  // ── 8. Bundle size ────────────────────────────────────────────────────
  console.error('[8/8] Bundle size recorded.');

  const metrics: Metrics = {
    label,
    timestamp: new Date().toISOString(),
    coldBootMs,
    warmBootMs,
    agentLatencyMs: firstChunkMs,
    memory: memBody.memory,
    traceLookupMs: traceResult.ms,
    dashboardLoadMs: dash.totalMs,
    dashboardEndpoints: dash.perEndpoint,
    buildDurationMs: build.durationMs,
    bundleSize: {
      jsBytes: build.jsBytes,
      cssBytes: build.cssBytes,
      jsHuman: formatBytes(build.jsBytes),
      cssHuman: formatBytes(build.cssBytes),
    },
  };

  // Save snapshot
  const outPath = join(__dirname, `perf-${label}.json`);
  writeFileSync(outPath, JSON.stringify(metrics, null, 2));
  console.error(`\nSnapshot saved: ${outPath}`);

  // Print summary
  console.error('─'.repeat(60));
  console.error('  Summary');
  console.error('─'.repeat(60));
  console.error(`  Cold boot:        ${coldBootMs}ms`);
  console.error(`  Warm boot:        ${warmBootMs}ms`);
  console.error(`  Agent latency:    ${firstChunkMs}ms`);
  console.error(`  Trace lookup:     ${traceResult.ms}ms`);
  console.error(`  Dashboard load:   ${dash.totalMs}ms (${dash.perEndpoint.length} endpoints)`);
  console.error(`  RSS:              ${formatBytes(memBody.memory.rss)}`);
  console.error(`  Heap used:        ${formatBytes(memBody.memory.heapUsed)}`);
  console.error(`  Build duration:   ${build.durationMs}ms`);
  console.error(`  Bundle JS:        ${formatBytes(build.jsBytes)}`);
  console.error(`  Bundle CSS:       ${formatBytes(build.cssBytes)}`);

  // Also emit JSON to stdout for piping
  console.log(JSON.stringify(metrics, null, 2));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
