// scripts/test-dashboard-endpoints.ts
// Phase 4 smoke test — boot the server, hit every /api/dashboard/* endpoint,
// verify they return JSON. Read-only — no state changes.
//
// Usage: npx tsx scripts/test-dashboard-endpoints.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_DIR = '/home/z/my-project/extracted/code_siren/server';

async function main() {
  console.log('─'.repeat(60));
  console.log('  Phase 4 Dashboard smoke test');
  console.log('─'.repeat(60));

  // Start the server
  console.log('[boot] starting server…');
  const server: ChildProcess = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JWT_SECRET: 'test-secret-at-least-32-chars-long-xxxx',
      PORT: '3099',  // avoid clobbering anything on 3001
      NODE_ENV: 'test',
    },
  });

  let serverLog = '';
  server.stdout?.on('data', (chunk) => {
    const s = chunk.toString();
    serverLog += s;
    process.stdout.write(`[server] ${s}`);
  });
  server.stderr?.on('data', (chunk) => {
    const s = chunk.toString();
    serverLog += s;
    process.stderr.write(`[server!] ${s}`);
  });

  // Wait for the server to be ready
  console.log('[boot] waiting for server ready…');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (serverLog.includes('HTTP  http://localhost:3099')) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    console.error('[boot] server did not become ready in 30s');
    server.kill('SIGKILL');
    process.exit(1);
  }
  console.log('[boot] server ready');

  // Register a test user → get JWT
  console.log('[auth] registering test user…');
  const regRes = await fetch('http://localhost:3099/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `dash-test-${Date.now()}@code-siren.local`,
      password: 'dash-test-password',
      name: 'Dash Test',
    }),
  });
  if (!regRes.ok) {
    console.error(`[auth] register failed: HTTP ${regRes.status}`);
    server.kill('SIGKILL');
    process.exit(1);
  }
  const regBody = await regRes.json() as { token: string };
  const token = regBody.token;
  console.log('[auth] got JWT');

  // Hit every dashboard endpoint
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

  let pass = 0;
  let fail = 0;
  for (const ep of endpoints) {
    try {
      const res = await fetch(`http://localhost:3099${ep}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.error(`  ✗ ${ep} → HTTP ${res.status}`);
        fail++;
        continue;
      }
      const body = await res.json();
      const keys = Object.keys(body).slice(0, 5).join(', ');
      console.log(`  ✓ ${ep} → 200 OK  (keys: ${keys}…)`);
      pass++;
    } catch (err: any) {
      console.error(`  ✗ ${ep} → ${err.message}`);
      fail++;
    }
  }

  console.log('─'.repeat(60));
  console.log(`  Result: ${pass}/${endpoints.length} endpoints OK, ${fail} failed`);
  console.log('─'.repeat(60));

  server.kill('SIGTERM');
  await sleep(500);
  server.kill('SIGKILL');

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
