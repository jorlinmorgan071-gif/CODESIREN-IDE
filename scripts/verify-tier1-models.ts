// Quick verification script — registers a user, gets a token, hits the
// Tier 1 chat endpoint, and prints the server log line that confirms
// which model the orchestrator is calling.
import { spawn } from 'node:child_process';

const SERVER_DIR = '/home/z/my-project/extracted/code_siren/server';
const PORT = '3099'; // non-default to avoid conflicts

const env = {
  ...process.env,
  OPENROUTER_API_KEY: 'test-key-for-log-verification',
  JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long-for-verification',
  PORT,
  NODE_ENV: 'development',
};

const server = spawn('npx', ['tsx', 'src/index.ts'], {
  cwd: SERVER_DIR,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const logLines = [];
server.stdout.on('data', (d) => {
  const s = d.toString();
  logLines.push(...s.split('\n').filter(Boolean));
  process.stdout.write('[server] ' + s);
});
server.stderr.on('data', (d) => process.stderr.write('[server err] ' + d.toString()));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; }
  catch { return { status: res.status, text }; }
}

(async () => {
  // Wait for server to boot
  await sleep(4000);

  const BASE = `http://localhost:${PORT}/api`;

  // Register (or login if exists)
  const email = `verify@test.local`;
  const password = 'verify-password-1234';
  let regRes = await fetchJson(`${BASE}/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ email, password, name: 'Verify User' }),
  });
  let token;
  if (regRes.status === 409 || regRes.status === 400) {
    const loginRes = await fetchJson(`${BASE}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    token = loginRes.json?.token;
  } else {
    token = regRes.json?.token;
  }
  if (!token) {
    console.log('[verify] FAILED to get token. regRes:', JSON.stringify(regRes));
    server.kill();
    process.exit(1);
  }
  console.log('[verify] got token');

  // Get settings — confirm the new models are returned
  const settingsRes = await fetchJson(`${BASE}/orchestrator/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('[verify] settings tier1Models:');
  for (const m of (settingsRes.json?.tier1Models || [])) {
    console.log(`  - ${m.id}  (label: ${m.label}, desc: ${m.desc ?? '—'})`);
  }
  console.log(`[verify] default tier1Model: ${settingsRes.json?.settings?.tier1Model}`);
  console.log(`[verify] default engine: ${settingsRes.json?.settings?.engine}`);

  // Hit the Tier 1 chat endpoint — the server will log the model ID
  // before the fetch fails (since we're using a test key). We don't
  // need the actual response to succeed; we just need the log line.
  const chatRes = await fetchJson(`${BASE}/orchestrator/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: 'verify-session', message: 'Hello, which model are you?' }),
  });
  console.log('[verify] chat endpoint response status:', chatRes.status);
  console.log('[verify] chat endpoint response body:', JSON.stringify(chatRes.json ?? chatRes.text));

  // Wait a moment for the log line to flush
  await sleep(1500);

  // Find and print the log line that confirms the model ID
  console.log('\n[verify] --- searching server logs for the model log line ---');
  const modelLogLines = logLines.filter((l) => l.includes('orchestrator:tier1') || l.includes('streaming chat via'));
  if (modelLogLines.length > 0) {
    for (const l of modelLogLines) {
      console.log(`  >>> ${l}`);
    }
    console.log('\n[verify] SUCCESS — model ID confirmed in server log');
  } else {
    console.log('  (no orchestrator:tier1 log line found — check full server output above)');
  }

  server.kill();
  process.exit(0);
})().catch((err) => {
  console.error('[verify] crashed:', err);
  server.kill();
  process.exit(1);
});
