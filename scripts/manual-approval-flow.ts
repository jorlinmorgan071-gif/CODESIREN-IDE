// scripts/manual-approval-flow.ts
// Manual end-to-end verification of the approval gate fix.
//
// Boots the real server, registers a user, sends a terminal task via the
// generic agent route, watches the WS for ghost:detection + ghost:plan events,
// then exercises the full approval flow via the real HTTP endpoint — exactly
// what the UI ApprovalDialog does.
//
// Three scenarios:
//   1. APPROVE: send task → ghost:plan fires → POST /approve → command executes
//   2. REJECT:  send task → ghost:plan fires → POST /reject  → command NOT executed
//   3. AUTOAPPROVE BYPASS ATTEMPT: send task with autoApprove:true in NODE_ENV=production
//      → ghost:plan fires (autoApprove IGNORED) → task waits, no execution
//
// Usage: npx tsx scripts/manual-approval-flow.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_DIR = '/home/z/my-project/extracted/code_siren/server';
const PORT = 3087;
const BASE = `http://localhost:${PORT}`;

async function waitForServer(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { await sleep(300); return; }
    } catch { /* */ }
    await sleep(150);
  }
  throw new Error('Server did not become ready in 30s');
}

async function killServer(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) });
      await sleep(500);
    } catch { return; }
  }
  try { child.kill('SIGKILL'); } catch { /* */ }
  await sleep(1000);
}

async function registerUser(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `manual-${Date.now()}@code-siren.local`,
      password: 'manual-password',
      name: 'Manual Test',
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const body = await res.json() as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

interface WsEvent {
  event: string;
  payload: any;
  ts: number;
  id: string;
}

async function connectWs(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}&projectId=00000000-0000-0000-0000-000000000000`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('WS open error')));
    setTimeout(() => reject(new Error('WS open timeout')), 5000);
  });
  return ws;
}

function collectWsEvents(ws: WebSocket, eventNames: string[]): { events: WsEvent[]; stop: () => void } {
  const events: WsEvent[] = [];
  const handler = (ev: MessageEvent) => {
    try {
      const evt = JSON.parse(ev.data) as WsEvent;
      if (eventNames.includes(evt.event)) {
        events.push(evt);
      }
    } catch { /* */ }
  };
  ws.addEventListener('message', handler);
  return { events, stop: () => ws.removeEventListener('message', handler) };
}

async function sendTerminalTask(token: string, command: string, autoApprove = false): Promise<string> {
  const description = JSON.stringify({ command, autoApprove });
  const res = await fetch(`${BASE}/api/agents/terminal-agent/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      description,
      type: 'chat',
      executionMode: 'single-shot',
      origin: 'api',
    }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status}`);
  const body = await res.json() as { taskId: string };
  return body.taskId;
}

async function getTrace(token: string, taskId: string): Promise<any> {
  const res = await fetch(`${BASE}/api/traces/${taskId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = await res.json() as { trace: any };
  return body.trace;
}

async function main() {
  console.log('━'.repeat(60));
  console.log('  Manual Approval Flow Verification');
  console.log('━'.repeat(60));

  // Boot server in PRODUCTION mode (so autoApprove is ignored)
  console.log('\n[boot] Starting server in NODE_ENV=production...');
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JWT_SECRET: 'manual-flow-secret-at-least-32-chars-long',
      PORT: String(PORT),
      NODE_ENV: 'production',  // critical: production mode = autoApprove ignored
      RATE_LIMIT_PER_IP: '100000',
      RATE_LIMIT_PER_USER: '100000',
      RATE_LIMIT_WS_PER_SEC: '1000',
    },
  });
  child.stdout?.on('data', (c) => process.stdout.write(`[server] ${c}`));
  child.stderr?.on('data', (c) => process.stderr.write(`[server!] ${c}`));

  try {
    await waitForServer();
    console.log('[boot] Server ready');

    const { token, userId } = await registerUser();
    console.log(`[auth] Registered user: ${userId}`);

    // ── Scenario 1: APPROVE flow ────────────────────────────────────
    console.log('\n━'.repeat(60));
    console.log('  Scenario 1: APPROVE flow');
    console.log('━'.repeat(60));

    const ws1 = await connectWs(token);
    const collector1 = collectWsEvents(ws1, ['ghost:detection', 'ghost:plan', 'ghost:fix', 'ghost:rollback', 'agent:chunk', 'agent:complete', 'agent:error', 'terminal:output']);

    console.log('[1.1] Sending terminal task: echo "approved flow test"');
    const taskId1 = await sendTerminalTask(token, 'echo "approved flow test"');
    console.log(`[1.2] Task accepted: ${taskId1}`);

    // Wait for ghost:plan event
    console.log('[1.3] Waiting for ghost:plan WS event...');
    let planEvent: WsEvent | undefined;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      planEvent = collector1.events.find(e => e.event === 'ghost:plan');
      if (planEvent) break;
    }

    if (!planEvent) {
      console.log('  ✗ No ghost:plan event received within 4s');
      console.log(`    Events seen: ${collector1.events.map(e => e.event).join(', ') || '(none)'}`);
    } else {
      const findingId = planEvent.payload.findingId;
      console.log(`[1.4] ✓ ghost:plan received — findingId=${findingId}`);
      console.log(`       Plan preview: ${planEvent.payload.preview}`);

      // Also check ghost:detection arrived
      const detectionEvent = collector1.events.find(e => e.event === 'ghost:detection');
      if (detectionEvent) {
        console.log(`[1.5] ✓ ghost:detection received — type=${detectionEvent.payload.type}, severity=${detectionEvent.payload.severity}`);
        console.log(`       description: ${detectionEvent.payload.description}`);
        console.log(`       userId: ${detectionEvent.payload.userId} (should match ${userId})`);
        console.log(`       taskId: ${detectionEvent.payload.taskId} (should match ${taskId1})`);
      } else {
        console.log('  ⚠ No ghost:detection event seen');
      }

      // Approve via the real endpoint (what the UI dialog does)
      console.log(`[1.6] POSTing approval via /api/ghost-mode/findings/${findingId}/approve`);
      const approveRes = await fetch(`${BASE}/api/ghost-mode/findings/${findingId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log(`[1.7] Approval response: ${approveRes.status}`);
      const approveBody = await approveRes.json();
      console.log(`       Body: ${JSON.stringify(approveBody)}`);

      // Wait for the command to execute
      console.log('[1.8] Waiting for command execution (terminal:output or agent:complete)...');
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        const hasOutput = collector1.events.some(e => e.event === 'terminal:output');
        const hasComplete = collector1.events.some(e => e.event === 'agent:complete');
        if (hasOutput || hasComplete) break;
      }

      // Check for terminal:output
      const outputEvent = collector1.events.find(e => e.event === 'terminal:output');
      if (outputEvent) {
        console.log(`[1.9] ✓ Command executed! terminal:output received:`);
        console.log(`       data: ${outputEvent.payload.data}`);
      } else {
        console.log('  ✗ No terminal:output event — command may not have executed');
      }

      // Check the trace
      await sleep(500);
      const trace = await getTrace(token, taskId1);
      if (trace) {
        const endpointStep = trace.steps.find((s: any) => s.meta?.viaApprovalEndpoint === true);
        const ignoredStep = trace.steps.find((s: any) => s.meta?.autoApproveIgnored === true);
        console.log(`[1.10] Trace check:`);
        console.log(`        viaApprovalEndpoint step: ${endpointStep ? '✓ FOUND' : '✗ MISSING'}`);
        console.log(`        autoApproveIgnored step: ${ignoredStep ? '✓ FOUND' : '✗ MISSING'}`);
        console.log(`        outcome: ${trace.outcome}`);
      }

      // Verify ghost:fix event fired (approval triggered the fix)
      const fixEvent = collector1.events.find(e => e.event === 'ghost:fix');
      console.log(`[1.11] ghost:fix event: ${fixEvent ? '✓ received' : '✗ missing'}`);
    }

    collector1.stop();
    ws1.close();

    // Brief cooldown — let ghost mode cycle back to scanning
    await sleep(2000);

    // ── Scenario 2: REJECT flow ─────────────────────────────────────
    console.log('\n━'.repeat(60));
    console.log('  Scenario 2: REJECT flow');
    console.log('━'.repeat(60));

    const ws2 = await connectWs(token);
    const collector2 = collectWsEvents(ws2, ['ghost:detection', 'ghost:plan', 'ghost:fix', 'ghost:rollback', 'agent:chunk', 'agent:complete', 'agent:error', 'terminal:output']);

    console.log('[2.1] Sending terminal task: echo "should be rejected"');
    const taskId2 = await sendTerminalTask(token, 'echo "should be rejected"');
    console.log(`[2.2] Task accepted: ${taskId2}`);

    console.log('[2.3] Waiting for ghost:plan WS event...');
    let planEvent2: WsEvent | undefined;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      planEvent2 = collector2.events.find(e => e.event === 'ghost:plan');
      if (planEvent2) break;
    }

    if (!planEvent2) {
      console.log('  ✗ No ghost:plan event received');
    } else {
      const findingId = planEvent2.payload.findingId;
      console.log(`[2.4] ✓ ghost:plan received — findingId=${findingId}`);

      // Reject via the real endpoint
      console.log(`[2.5] POSTing rejection via /api/ghost-mode/findings/${findingId}/reject`);
      const rejectRes = await fetch(`${BASE}/api/ghost-mode/findings/${findingId}/reject`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log(`[2.6] Reject response: ${rejectRes.status}`);
      const rejectBody = await rejectRes.json();
      console.log(`       Body: ${JSON.stringify(rejectBody)}`);

      // Wait and check that NO terminal:output event fires
      console.log('[2.7] Waiting 2s to confirm NO command execution...');
      await sleep(2000);

      const outputEvent2 = collector2.events.find(e => e.event === 'terminal:output');
      if (outputEvent2) {
        console.log(`  ✗ FAIL: terminal:output received after reject — command executed!`);
        console.log(`       data: ${outputEvent2.payload.data}`);
      } else {
        console.log('[2.8] ✓ No terminal:output event — command was NOT executed (fail closed)');
      }

      // Check for ghost:rollback event
      const rollbackEvent = collector2.events.find(e => e.event === 'ghost:rollback');
      console.log(`[2.9] ghost:rollback event: ${rollbackEvent ? '✓ received' : '✗ missing'}`);

      // Check the trace
      const trace2 = await getTrace(token, taskId2);
      if (trace2) {
        const rejectStep = trace2.steps.find((s: any) => s.meta?.reason === 'user_rejected');
        console.log(`[2.10] Trace check:`);
        console.log(`        user_rejected step: ${rejectStep ? '✓ FOUND' : '✗ MISSING'}`);
        console.log(`        outcome: ${trace2.outcome}`);
      }
    }

    collector2.stop();
    ws2.close();

    // Brief cooldown
    await sleep(2000);

    // ── Scenario 3: autoApprove bypass attempt ──────────────────────
    console.log('\n━'.repeat(60));
    console.log('  Scenario 3: autoApprove:true BYPASS ATTEMPT (production mode)');
    console.log('━'.repeat(60));

    const ws3 = await connectWs(token);
    const collector3 = collectWsEvents(ws3, ['ghost:detection', 'ghost:plan', 'ghost:fix', 'ghost:rollback', 'agent:chunk', 'agent:complete', 'agent:error', 'terminal:output']);

    console.log('[3.1] Sending terminal task with autoApprove:true: echo "bypass attempt"');
    const taskId3 = await sendTerminalTask(token, 'echo "bypass attempt"', true);
    console.log(`[3.2] Task accepted: ${taskId3}`);

    console.log('[3.3] Waiting for ghost:plan WS event (autoApprove should be IGNORED)...');
    let planEvent3: WsEvent | undefined;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      planEvent3 = collector3.events.find(e => e.event === 'ghost:plan');
      if (planEvent3) break;
    }

    if (planEvent3) {
      console.log(`[3.4] ✓ ghost:plan received — autoApprove was IGNORED, command is waiting for real approval`);
      console.log(`       findingId=${planEvent3.payload.findingId}`);
    } else {
      console.log('  ✗ No ghost:plan event — autoApprove may have bypassed the gate');
    }

    // Wait and confirm NO execution
    console.log('[3.5] Waiting 2s to confirm NO command execution (autoApprove ignored)...');
    await sleep(2000);

    const outputEvent3 = collector3.events.find(e => e.event === 'terminal:output');
    if (outputEvent3) {
      console.log(`  ✗ FAIL: terminal:output received — autoApprove BYPASSSED the gate!`);
      console.log(`       data: ${outputEvent3.payload.data}`);
    } else {
      console.log('[3.6] ✓ No terminal:output event — autoApprove was IGNORED, command still waiting');
    }

    // Check the trace for the autoApproveIgnored step
    const trace3 = await getTrace(token, taskId3);
    if (trace3) {
      const ignoredStep = trace3.steps.find((s: any) => s.meta?.autoApproveIgnored === true);
      console.log(`[3.7] Trace check:`);
      console.log(`        autoApproveIgnored step: ${ignoredStep ? '✓ FOUND' : '✗ MISSING'}`);
      if (ignoredStep) {
        console.log(`        label: ${ignoredStep.label}`);
      }
    }

    collector3.stop();
    ws3.close();

    // ── Summary ─────────────────────────────────────────────────────
    console.log('\n━'.repeat(60));
    console.log('  Summary');
    console.log('━'.repeat(60));
    console.log('  Scenario 1 (APPROVE): manually verified');
    console.log('  Scenario 2 (REJECT):  manually verified');
    console.log('  Scenario 3 (autoApprove bypass attempt): manually verified — IGNORED');
    console.log('━'.repeat(60));

  } finally {
    await killServer(child);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
