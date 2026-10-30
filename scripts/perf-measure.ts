// scripts/perf-measure.ts
// Phase 5 — Lightweight per-metric measurement script.
// Run individual measurements with `--metric=<name>`:
//   cold-boot, agent-latency, trace-lookup, dashboard-load, memory, warm-boot
//
// Or `--all` for everything (skip build by default — use --build to include).

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = '/home/z/my-project/extracted/code_siren/server';
const APP_DIR = '/home/z/my-project/extracted/code_siren/app';
const PORT = 3097;

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
}

async function waitForServerReady(child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
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

async function startServer(): Promise<ChildProcess> {
  // Verify port is free before spawning
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(300) });
      // Server still alive — wait
      await sleep(300);
    } catch {
      // Port is free — proceed
      break;
    }
  }

  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JWT_SECRET: 'perf-secret-at-least-32-chars-long-xxxxxx',
      PORT: String(PORT),
      NODE_ENV: 'production',
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
        // Wait a tiny bit longer to ensure server is fully initialized (not just first-response)
        await sleep(200);
        return child;
      }
    } catch {
      // not ready
    }
    await sleep(150);
  }
  try { child.kill('SIGKILL'); } catch { /* */ }
  throw new Error(`Server did not become ready in 30s`);
}

async function killServer(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  // Wait up to 30s for port to be released (graceful shutdown can take time)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(500) });
      // Server still alive — keep waiting
      await sleep(500);
    } catch {
      // Port is free
      return;
    }
  }
  // Force-kill if still alive after 30s
  try { child.kill('SIGKILL'); } catch { /* */ }
  await sleep(1000);
}

async function registerUser(): Promise<string> {
  const res = await fetch(`http://localhost:${PORT}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `perf-${Date.now()}@code-siren.local`,
      password: 'perf-password-baseline',
      name: 'Perf',
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const body = await res.json() as { token: string };
  return body.token;
}

async function sendAgentTask(token: string): Promise<{ taskId: string; firstChunkMs: number }> {
  const sendStart = Date.now();
  const wsUrl = `ws://localhost:${PORT}/ws?token=${token}&projectId=00000000-0000-0000-0000-000000000000`;
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('WS open error')));
    setTimeout(() => reject(new Error('WS open timeout')), 8000);
  });

  const firstChunkPromise = new Promise<number>((resolve) => {
    const handler = (ev: MessageEvent) => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.event === 'agent:chunk' || evt.event === 'agent:complete' || evt.event === 'agent:error') {
          ws.removeEventListener('message', handler);
          resolve(Date.now() - sendStart);
        }
      } catch { /* */ }
    };
    ws.addEventListener('message', handler);
  });

  const sendRes = await fetch(`http://localhost:${PORT}/api/agents/architect-agent/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      description: 'perf test say hello',
      type: 'chat',
      executionMode: 'single-shot',
      origin: 'api',
    }),
  });
  if (!sendRes.ok) throw new Error(`send failed: ${sendRes.status}`);
  const sendBody = await sendRes.json() as { taskId: string };

  const firstChunkMs = await Promise.race([
    firstChunkPromise,
    sleep(15_000).then(() => -1),
  ]);
  ws.close();
  return { taskId: sendBody.taskId, firstChunkMs };
}

async function measureEndpoint(token: string, path: string): Promise<{ ms: number; status: number }> {
  const start = Date.now();
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await res.text();
  return { ms: Date.now() - start, status: res.status };
}

async function measureDashboardLoad(token: string) {
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
  const per: Array<{ endpoint: string; ms: number }> = [];
  const totalStart = Date.now();
  for (const ep of endpoints) {
    const r = await measureEndpoint(token, ep);
    per.push({ endpoint: ep, ms: r.ms });
  }
  return { totalMs: Date.now() - totalStart, per };
}

// ── Metric implementations ──────────────────────────────────────────────

async function mColdBoot(): Promise<Record<string, unknown>> {
  console.error('measuring cold boot…');
  const start = Date.now();
  const child = await startServer();
  const ms = Date.now() - start;
  await killServer(child);
  return { coldBootMs: ms };
}

async function mWarmBoot(): Promise<Record<string, unknown>> {
  console.error('  warm-boot: starting first boot…');
  const c1 = await startServer();
  console.error('  warm-boot: first boot ready, killing…');
  const killStart = Date.now();
  await killServer(c1);
  const killMs = Date.now() - killStart;
  console.error(`  warm-boot: first boot killed in ${killMs}ms, starting warm…`);
  const start = Date.now();
  const c2 = await startServer();
  const ms = Date.now() - start;
  console.error(`  warm-boot: warm boot ready in ${ms}ms`);
  await killServer(c2);
  return { warmBootMs: ms, warmBootKillMs: killMs };
}

async function mAgentLatency(): Promise<Record<string, unknown>> {
  console.error('measuring agent latency…');
  const child = await startServer();
  try {
    const token = await registerUser();
    const { taskId, firstChunkMs } = await sendAgentTask(token);
    return { agentLatencyMs: firstChunkMs, taskId };
  } finally {
    await killServer(child);
  }
}

async function mMemory(): Promise<Record<string, unknown>> {
  console.error('measuring memory…');
  const child = await startServer();
  try {
    const token = await registerUser();
    const res = await fetch(`http://localhost:${PORT}/api/dashboard/system`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as { memory: { rss: number; heapUsed: number; heapTotal: number; external: number } };
    return { memory: body.memory };
  } finally {
    await killServer(child);
  }
}

async function mTraceLookup(): Promise<Record<string, unknown>> {
  console.error('measuring trace lookup…');
  const child = await startServer();
  try {
    const token = await registerUser();
    const { taskId } = await sendAgentTask(token);
    await sleep(800);
    // Measure 5 lookups, take avg
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await measureEndpoint(token, `/api/traces/${taskId}`);
      times.push(r.ms);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return { traceLookupMs: avg, traceLookupSamples: times, taskId };
  } finally {
    await killServer(child);
  }
}

async function mDashboardLoad(): Promise<Record<string, unknown>> {
  console.error('measuring dashboard load…');
  const child = await startServer();
  try {
    const token = await registerUser();
    const r = await measureDashboardLoad(token);
    return { dashboardLoadMs: r.totalMs, perEndpoint: r.per };
  } finally {
    await killServer(child);
  }
}

async function mBundle(): Promise<Record<string, unknown>> {
  console.error('measuring bundle size + build duration…');
  const start = Date.now();
  const result = spawn('npm', ['run', 'build'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve) => result.on('close', () => resolve()));
  const durationMs = Date.now() - start;

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
  return {
    buildDurationMs: durationMs,
    bundleJsBytes: jsBytes,
    bundleCssBytes: cssBytes,
    bundleJsHuman: formatBytes(jsBytes),
    bundleCssHuman: formatBytes(cssBytes),
  };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const label = args.find((a) => a.startsWith('--label='))?.split('=')[1] ?? 'baseline';
  const metrics = args.filter((a) => a.startsWith('--metric=')).map((a) => a.split('=')[1]);
  const doAll = args.includes('--all') || metrics.length === 0;
  const includeBuild = args.includes('--build') || (doAll && !args.includes('--no-build'));

  console.error(`─`.repeat(60));
  console.error(`  Perf measurement (label=${label})`);
  console.error(`  metrics=${doAll ? 'ALL' : metrics.join(',')}`);
  console.error(`  build=${includeBuild ? 'yes' : 'no'}`);
  console.error(`─`.repeat(60));

  const result: Record<string, unknown> = {
    label,
    timestamp: new Date().toISOString(),
  };

  const todo: Array<[string, () => Promise<Record<string, unknown>>]> = [];
  if (doAll || metrics.includes('cold-boot')) todo.push(['cold-boot', mColdBoot]);
  if (doAll || metrics.includes('warm-boot')) todo.push(['warm-boot', mWarmBoot]);
  if (doAll || metrics.includes('agent-latency')) todo.push(['agent-latency', mAgentLatency]);
  if (doAll || metrics.includes('memory')) todo.push(['memory', mMemory]);
  if (doAll || metrics.includes('trace-lookup')) todo.push(['trace-lookup', mTraceLookup]);
  if (doAll || metrics.includes('dashboard-load')) todo.push(['dashboard-load', mDashboardLoad]);
  if (includeBuild || metrics.includes('bundle')) todo.push(['bundle', mBundle]);

  for (const [name, fn] of todo) {
    try {
      const r = await fn();
      Object.assign(result, r);
      console.error(`  ✓ ${name}: ${JSON.stringify(r).slice(0, 200)}`);
    } catch (err: any) {
      console.error(`  ✗ ${name}: ${err.message}`);
      result[`${name}_error`] = err.message;
    }
  }

  // Save
  const outPath = join(__dirname, `perf-${label}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.error(`\nSaved: ${outPath}`);

  // Stdout for piping
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
