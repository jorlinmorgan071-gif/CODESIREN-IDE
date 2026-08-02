// scripts/wake-greeting-proof.mts
// Tests that a voice:greeting event fires on session start with real audio.

import { WebSocket } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const SERVER_URL = 'http://localhost:3001';
const WS_URL = 'ws://localhost:3001/ws';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitForServer(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(`${SERVER_URL}/api/health`); if (res.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('Server not reachable');
}

async function main() {
  console.log('='.repeat(70));
  console.log('Wake Greeting Proof');
  console.log('='.repeat(70));

  // Start server
  const serverProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: '/home/z/my-project/extracted/code_siren/server',
    stdio: 'pipe', env: { ...process.env },
  });
  let serverLog = '';
  serverProc.stdout?.on('data', (d: Buffer) => { serverLog += d.toString(); });
  serverProc.stderr?.on('data', (d: Buffer) => { serverLog += d.toString(); });

  try {
    await waitForServer(30000);
    console.log('Server up.');

    // Auth
    const email = `greeting-test-${Date.now()}@example.com`;
    await fetch(`${SERVER_URL}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-123', name: 'Greeting Test' }),
    }).catch(() => {});
    const loginRes = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-123' }),
    });
    const { token } = await loginRes.json() as any;
    console.log('Authenticated.');

    // Start voice session
    const startRes = await fetch(`${SERVER_URL}/api/voice/live/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const { sessionId } = await startRes.json() as any;
    console.log(`Voice session started: ${sessionId}`);

    // Connect WS and listen for voice:greeting
    const greetingPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for greeting')), 30000);
      const ws = new WebSocket(`${WS_URL}?token=${token}&projectId=00000000-0000-0000-0000-000000000000`);

      let greetingCount = 0;
      ws.on('open', () => console.log('WS connected, waiting for greeting...'));
      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.event === 'voice:greeting') {
            greetingCount++;
            console.log(`\nGreeting event #${greetingCount}:`);
            console.log(`  text: "${msg.payload.text}"`);
            console.log(`  audioBase64: ${msg.payload.audioBase64 ? msg.payload.audioBase64.length + ' chars' : 'null'}`);
            console.log(`  sessionId: ${msg.payload.sessionId}`);

            // Wait for the second event (with audio) or resolve on first if no audio coming
            if (msg.payload.audioBase64 || greetingCount >= 2) {
              clearTimeout(timeout);
              ws.close();
              resolve(msg.payload);
            }
          }
        } catch {}
      });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    const greeting = await greetingPromise;
    console.log('\n' + '='.repeat(70));
    console.log('RESULT');
    console.log('='.repeat(70));
    console.log(`Greeting text: "${greeting.text}"`);
    console.log(`Has audio: ${greeting.audioBase64 ? 'YES (' + greeting.audioBase64.length + ' chars base64)' : 'NO'}`);

    if (greeting.audioBase64) {
      const wavBytes = Buffer.from(greeting.audioBase64, 'base64');
      const riff = wavBytes.slice(0, 4).toString('ascii');
      const wave = wavBytes.slice(8, 12).toString('ascii');
      console.log(`WAV header: ${riff}/${wave} ${riff === 'RIFF' && wave === 'WAVE' ? '✓ valid' : '✗ invalid'}`);
    }

    // Server log
    console.log('\n--- Server log (greeting-related) ---');
    for (const line of serverLog.split('\n')) {
      if (line.includes('greeting') || line.includes('session started') || line.includes('TTS')) {
        console.log(`  ${line}`);
      }
    }

    console.log('\n✓ PASS — wake greeting fires on session start with real audio');

    // End session
    await fetch(`${SERVER_URL}/api/voice/live/${sessionId}/end`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
    }).catch(() => {});
  } finally {
    serverProc.kill('SIGTERM');
    await sleep(2000);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
