// server/scripts/benchmark.ts
// npm run benchmark — measures key performance metrics.

import { performance } from 'node:perf_hooks';

const PORT = process.env.PORT ?? '3001';
const BASE = `http://localhost:${PORT}`;

async function timedFetch(path: string, opts: RequestInit = {}): Promise<{ ms: number; status: number; ok: boolean }> {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });
    const ms = performance.now() - start;
    return { ms, status: res.status, ok: res.ok };
  } catch {
    return { ms: performance.now() - start, status: 0, ok: false };
  }
}

async function main() {
  console.log('━'.repeat(50));
  console.log('  Code Siren Benchmark');
  console.log('━'.repeat(50));

  // Register
  const email = `bench-${Date.now()}@test.com`;
  const regRes = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test-password-123', name: 'Bench' }),
  });
  const { token } = await regRes.json();

  const results: Array<{ name: string; ms: number; ok: boolean }> = [];

  // 1. Health check latency
  const h = await timedFetch('/api/health');
  results.push({ name: 'GET /api/health', ms: h.ms, ok: h.ok });

  // 2. Agent list latency
  const a = await timedFetch('/api/agents', { headers: { Authorization: `Bearer ${token}` } });
  results.push({ name: 'GET /api/agents', ms: a.ms, ok: a.ok });

  // 3. Traces list latency
  const t = await timedFetch('/api/traces?limit=10', { headers: { Authorization: `Bearer ${token}` } });
  results.push({ name: 'GET /api/traces', ms: t.ms, ok: t.ok });

  // 4. Models/engines latency
  const m = await timedFetch('/api/models/engines', { headers: { Authorization: `Bearer ${token}` } });
  results.push({ name: 'GET /api/models/engines', ms: m.ms, ok: m.ok });

  // 5. Agent send latency (dispatch only, no LLM)
  const s = await timedFetch('/api/agents/architect-agent/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ description: 'benchmark test', type: 'chat', executionMode: 'single-shot', origin: 'api' }),
  });
  results.push({ name: 'POST /api/agents/send', ms: s.ms, ok: s.ok });

  // 6. Sandbox execute latency
  const sb = await timedFetch('/api/sandbox/execute', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ code: 'log(1+1)', timeoutMs: 5000 }),
  });
  results.push({ name: 'POST /api/sandbox/execute', ms: sb.ms, ok: sb.ok });

  // Print results
  console.log('');
  console.log('  Endpoint                          Latency    Status');
  console.log('  ─────────────────────────────────────────────────────');
  for (const r of results) {
    const status = r.ok ? '✓' : '✗';
    const ms = r.ms.toFixed(1).padStart(7);
    console.log(`  ${r.name.padEnd(35)} ${ms}ms  ${status}`);
  }

  const avg = results.reduce((a, r) => a + r.ms, 0) / results.length;
  console.log('');
  console.log(`  Average latency: ${avg.toFixed(1)}ms`);
  console.log('━'.repeat(50));
  process.exit(0);
}

main().catch(() => {
  console.log('  ✗ Benchmark failed — is the server running?');
  process.exit(1);
});
