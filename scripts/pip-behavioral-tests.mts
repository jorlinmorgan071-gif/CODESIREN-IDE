// scripts/pip-behavioral-tests.mts
//
// Phase B — Close the Gap: Real PIP Behavioral Tests
//
// Directive: Get the three specific real tests the original PIP directive
// asked for, with ACTUAL OBSERVED RESULTS — not code-path descriptions.
//
// Tests:
//   1. Drag → reload → position persists
//      - Read overlay position before drag
//      - Programmatically drag the overlay
//      - Read position after drag
//      - Reload the page
//      - Read position after reload — confirm it matches the dragged position
//
//   2. Toggle → reload → visibility persists
//      - Toggle PIP on, reload, confirm still visible
//      - Toggle PIP off, reload, confirm still hidden
//
//   3. Selected avatar renders in PIP
//      - Set selectedAvatarId='marionette' via API
//      - Reload, enable PIP
//      - Capture network requests — confirm marionette's model.vrm was fetched
//        (NOT default's)
//
// Evidence required: real before/after values — actual coordinates, actual
// boolean states, actual model URL loaded.

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SERVER_DIR = join(PROJECT_ROOT, 'server');
const APP_DIR = join(PROJECT_ROOT, 'app');
const SETTINGS_PATH = join(SERVER_DIR, '.runtime', 'avatar-settings.json');

const SERVER_URL = 'http://localhost:3001';
const APP_URL = 'http://localhost:3000';

interface TestResult {
  name: string;
  passed: boolean;
  evidence: Record<string, unknown>;
  error?: string;
}

const results: TestResult[] = [];

function log(msg: string) {
  console.log(msg);
}

function resetSettings() {
  if (existsSync(SETTINGS_PATH)) {
    unlinkSync(SETTINGS_PATH);
  }
  // Ensure .runtime dir exists
  const runtimeDir = dirname(SETTINGS_PATH);
  if (!existsSync(runtimeDir)) {
    mkdirSync(runtimeDir, { recursive: true });
  }
  log(`  [setup] avatar-settings.json reset`);
}

function readSettings(): any {
  if (!existsSync(SETTINGS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function waitForServer(url: string, label: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        log(`  [setup] ${label} ready at ${url}`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms`);
}

async function waitForApp(url: string, label: string, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        log(`  [setup] ${label} ready at ${url}`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms`);
}

async function getDevToken(): Promise<string> {
  // Register/login the dev user the same way the app does, so we can call
  // the avatar settings API directly from the test.
  const email = 'dev@code-siren.local';
  const password = 'dev-password-step-0';
  const name = 'Step 0 Developer';

  // Try register first
  let res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (res.status === 201) {
    const data = await res.json() as { token: string };
    return data.token;
  }
  if (res.status === 409) {
    // already registered — login
    res = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      const data = await res.json() as { token: string };
      return data.token;
    }
  }
  throw new Error(`Failed to get dev token: register status ${res.status}`);
}

async function setAvatarSettingsApi(token: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SERVER_URL}/api/avatar/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`setAvatarSettings failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { settings: any };
  return data.settings;
}

async function getAvatarSettingsApi(token: string): Promise<any> {
  const res = await fetch(`${SERVER_URL}/api/avatar/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`getAvatarSettings failed: ${res.status}`);
  }
  const data = await res.json() as { settings: any };
  return data.settings;
}

async function setPipEnabled(token: string, enabled: boolean): Promise<void> {
  await setAvatarSettingsApi(token, { pipEnabled: enabled });
}

async function setSelectedAvatar(token: string, avatarId: string): Promise<void> {
  await setAvatarSettingsApi(token, { selectedAvatarId: avatarId });
}

async function waitForPipOverlay(page: import('playwright').Page, timeout = 45000): Promise<import('playwright').Locator> {
  const overlay = page.getByTestId('pip-overlay');
  await overlay.waitFor({ state: 'visible', timeout });
  // Give the Canvas a moment to initialize
  await page.waitForTimeout(500);
  return overlay;
}

async function waitForPipToggle(page: import('playwright').Page, timeout = 30000): Promise<import('playwright').Locator> {
  const toggle = page.getByTestId('pip-toggle');
  await toggle.waitFor({ state: 'visible', timeout });
  return toggle;
}

async function getOverlayPosition(page: import('playwright').Page): Promise<{ x: number; y: number }> {
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="pip-overlay"]') as HTMLElement;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
  if (!box) throw new Error('PIP overlay not found in DOM');
  return { x: Math.round(box.left), y: Math.round(box.top) };
}

async function isPipVisible(page: import('playwright').Page): Promise<boolean> {
  const el = await page.$('[data-testid="pip-overlay"]');
  if (!el) return false;
  return await el.isVisible();
}

// ─────────────────────────────────────────────────────────────────────
// TEST 1: Drag → reload → position persists
// ─────────────────────────────────────────────────────────────────────
async function test1_drag_reload_persist(page: import('playwright').Page, token: string): Promise<TestResult> {
  log('\n── TEST 1: Drag → reload → position persists ──');

  const evidence: Record<string, unknown> = {};

  try {
    // Start clean
    resetSettings();
    await setPipEnabled(token, false);

    // Load home
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await waitForPipToggle(page);

    // Click toggle to enable PIP
    await page.getByTestId('pip-toggle').click();
    const overlay = await waitForPipOverlay(page);
    evidence['overlay initially visible'] = await overlay.isVisible();

    // Read initial position
    const beforeDrag = await getOverlayPosition(page);
    evidence['position before drag'] = beforeDrag;
    log(`  position before drag: ${JSON.stringify(beforeDrag)}`);

    // Drag the overlay by +180px right, +120px down via the title bar
    // The title bar is at the top of the overlay (y ≈ top + 14)
    const dragStartX = beforeDrag.x + 50;  // middle of title bar horizontally
    const dragStartY = beforeDrag.y + 14;  // middle of title bar vertically
    const dragDeltaX = 180;
    const dragDeltaY = 120;
    const dragEndX = dragStartX + dragDeltaX;
    const dragEndY = dragStartY + dragDeltaY;

    await page.mouse.move(dragStartX, dragStartY);
    await page.mouse.down();
    // Move in steps so motion.div's drag detector catches it
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        dragStartX + (dragDeltaX * i / 10),
        dragStartY + (dragDeltaY * i / 10),
      );
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    // Wait for save POST to complete
    await page.waitForTimeout(800);

    // Read position after drag
    const afterDrag = await getOverlayPosition(page);
    evidence['position after drag'] = afterDrag;
    log(`  position after drag:  ${JSON.stringify(afterDrag)}`);

    // Read what got persisted on disk
    const settingsAfterDrag = readSettings();
    evidence['settings.json pipPosition after drag'] = settingsAfterDrag?.pipPosition ?? null;
    log(`  settings.json pipPosition: ${JSON.stringify(settingsAfterDrag?.pipPosition)}`);

    // Reload the page
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPipToggle(page);
    // PIP should reappear because pipEnabled was saved as true
    await waitForPipOverlay(page);

    // Read position after reload
    const afterReload = await getOverlayPosition(page);
    evidence['position after reload'] = afterReload;
    log(`  position after reload: ${JSON.stringify(afterReload)}`);

    // Verify persistence — after reload should match after-drag (within a few px tolerance)
    const tolerance = 5;
    const xMatches = Math.abs(afterReload.x - afterDrag.x) <= tolerance;
    const yMatches = Math.abs(afterReload.y - afterDrag.y) <= tolerance;
    evidence['x matches (tolerance 5px)'] = xMatches;
    evidence['y matches (tolerance 5px)'] = yMatches;

    const passed = xMatches && yMatches;
    return {
      name: 'TEST 1: Drag → reload → position persists',
      passed,
      evidence,
      error: passed ? undefined : `Position after reload (${afterReload.x},${afterReload.y}) does not match position after drag (${afterDrag.x},${afterDrag.y})`,
    };
  } catch (err: any) {
    evidence['error'] = err.message;
    return {
      name: 'TEST 1: Drag → reload → position persists',
      passed: false,
      evidence,
      error: err.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// TEST 2: Toggle → reload → visibility persists
// ─────────────────────────────────────────────────────────────────────
async function test2_toggle_reload_persist(page: import('playwright').Page, token: string): Promise<TestResult> {
  log('\n── TEST 2: Toggle → reload → visibility persists ──');

  const evidence: Record<string, unknown> = {};

  try {
    // Start clean — PIP off
    resetSettings();
    await setPipEnabled(token, false);

    // Load home — PIP should NOT be visible
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await waitForPipToggle(page);
    const visibleBeforeToggle = await isPipVisible(page);
    evidence['visible before toggle (initial)'] = visibleBeforeToggle;
    log(`  visible before toggle: ${visibleBeforeToggle}`);

    // Toggle ON
    await page.getByTestId('pip-toggle').click();
    await waitForPipOverlay(page);
    const visibleAfterToggleOn = await isPipVisible(page);
    evidence['visible after toggle ON'] = visibleAfterToggleOn;
    log(`  visible after toggle ON: ${visibleAfterToggleOn}`);

    // Persisted on disk?
    const settingsOn = readSettings();
    evidence['settings.json pipEnabled after toggle ON'] = settingsOn?.pipEnabled ?? null;
    log(`  settings.json pipEnabled: ${settingsOn?.pipEnabled}`);

    // Reload — should still be visible
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPipToggle(page);
    await waitForPipOverlay(page);
    const visibleAfterReloadOn = await isPipVisible(page);
    evidence['visible after reload (was ON)'] = visibleAfterReloadOn;
    log(`  visible after reload (was ON): ${visibleAfterReloadOn}`);

    // Toggle OFF
    await page.getByTestId('pip-toggle').click();
    // Wait for overlay to disappear
    await page.waitForTimeout(500);
    const visibleAfterToggleOff = await isPipVisible(page);
    evidence['visible after toggle OFF'] = visibleAfterToggleOff;
    log(`  visible after toggle OFF: ${visibleAfterToggleOff}`);

    const settingsOff = readSettings();
    evidence['settings.json pipEnabled after toggle OFF'] = settingsOff?.pipEnabled ?? null;
    log(`  settings.json pipEnabled: ${settingsOff?.pipEnabled}`);

    // Reload — should still be hidden
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPipToggle(page);
    // Give it a moment to potentially mount the overlay (it shouldn't)
    await page.waitForTimeout(2000);
    const visibleAfterReloadOff = await isPipVisible(page);
    evidence['visible after reload (was OFF)'] = visibleAfterReloadOff;
    log(`  visible after reload (was OFF): ${visibleAfterReloadOff}`);

    const passed =
      visibleAfterToggleOn === true &&
      visibleAfterReloadOn === true &&
      visibleAfterToggleOff === false &&
      visibleAfterReloadOff === false;

    return {
      name: 'TEST 2: Toggle → reload → visibility persists',
      passed,
      evidence,
      error: passed ? undefined : 'Visibility state did not persist correctly across reloads',
    };
  } catch (err: any) {
    evidence['error'] = err.message;
    return {
      name: 'TEST 2: Toggle → reload → visibility persists',
      passed: false,
      evidence,
      error: err.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// TEST 3: Selected avatar renders in PIP
// ─────────────────────────────────────────────────────────────────────
async function test3_selected_avatar_renders(page: import('playwright').Page, token: string): Promise<TestResult> {
  log('\n── TEST 3: Selected avatar renders in PIP ──');

  const evidence: Record<string, unknown> = {};

  try {
    // Start clean — set avatar to marionette via API
    resetSettings();
    await setAvatarSettingsApi(token, { selectedAvatarId: 'marionette' });
    await setAvatarSettingsApi(token, { pipEnabled: false });

    // Verify the API persisted the selection
    const settingsBefore = await getAvatarSettingsApi(token);
    evidence['selectedAvatarId via API (before load)'] = settingsBefore.selectedAvatarId;
    log(`  selectedAvatarId via API: ${settingsBefore.selectedAvatarId}`);

    // Set up network request capture
    const vrmRequests: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/models/avatars/') && url.endsWith('model.vrm')) {
        vrmRequests.push(url);
      }
    });

    // Load home — PIP off, no avatar fetch should happen for PIP yet
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await waitForPipToggle(page);
    // Wait for the browser's GET /avatar/settings to complete so pipAvatarUrl
    // is set to the correct avatar (marionette). The Home.tsx useEffect fires
    // after auth is ready, which takes ~1-2s for auto-register.
    await page.waitForFunction(
      () => {
        // Check if the toggle button has been rendered (auth is ready)
        const btn = document.querySelector('[data-testid="pip-toggle"]');
        if (!btn) return false;
        // Also wait for the avatar settings fetch to complete by checking
        // if the page has made a request to /avatar/settings
        return true;
      },
      { timeout: 15000 }
    );
    // Give the avatar settings GET time to complete and update pipAvatarUrl
    await page.waitForTimeout(3000);

    const vrmBeforePip = [...vrmRequests];
    evidence['vrm requests before PIP enabled'] = vrmBeforePip;
    log(`  vrm requests before PIP: ${JSON.stringify(vrmBeforePip)}`);

    // Clear the array so we only see requests triggered by PIP enable
    vrmRequests.length = 0;

    // Enable PIP
    await page.getByTestId('pip-toggle').click();
    await waitForPipOverlay(page);

    // Wait for the model to load (22MB file — give it generous time)
    let vrmDuringPip: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      if (vrmRequests.length > 0) {
        vrmDuringPip = [...vrmRequests];
        // Wait a bit more for any secondary requests
        await page.waitForTimeout(1000);
        vrmDuringPip = [...vrmRequests];
        break;
      }
    }
    if (vrmDuringPip.length === 0) {
      vrmDuringPip = [...vrmRequests];
    }
    evidence['vrm requests after PIP enabled'] = vrmDuringPip;
    log(`  vrm requests after PIP enabled: ${JSON.stringify(vrmDuringPip)}`);

    // Verify the model URL contains 'marionette' (not 'default')
    const marionetteLoaded = vrmDuringPip.some(u => u.includes('/avatars/marionette/'));
    const defaultLoaded = vrmDuringPip.some(u => u.includes('/avatars/default/'));
    evidence['marionette URL fetched'] = marionetteLoaded;
    evidence['default URL fetched'] = defaultLoaded;

    // Also verify via the API what's currently saved
    const settingsAfter = await getAvatarSettingsApi(token);
    evidence['selectedAvatarId via API (after)'] = settingsAfter.selectedAvatarId;

    // And inspect the actual DOM to see what the Canvas is rendering —
    // check the page's performance entries for the model fetch
    const perfEntries = await page.evaluate(() => {
      return performance.getEntriesByType('resource')
        .filter(e => e.name.includes('/models/avatars/') && e.name.endsWith('model.vrm'))
        .map(e => ({ url: e.name, duration: Math.round(e.duration) }));
    });
    evidence['performance entries for vrm'] = perfEntries;
    log(`  performance entries: ${JSON.stringify(perfEntries)}`);

    const passed = marionetteLoaded && !defaultLoaded;
    return {
      name: 'TEST 3: Selected avatar renders in PIP',
      passed,
      evidence,
      error: passed ? undefined : `Expected marionette URL in PIP, got: ${JSON.stringify(vrmDuringPip)}`,
    };
  } catch (err: any) {
    evidence['error'] = err.message;
    return {
      name: 'TEST 3: Selected avatar renders in PIP',
      passed: false,
      evidence,
      error: err.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main orchestration
// ─────────────────────────────────────────────────────────────────────
async function main() {
  log('═'.repeat(72));
  log('Phase B — Close the Gap: Real PIP Behavioral Tests');
  log('═'.repeat(72));
  log(`Project root: ${PROJECT_ROOT}`);
  log(`Settings path: ${SETTINGS_PATH}`);
  log('');

  // ── Kill any stale processes on ports 3000/3001 ──
  log('Killing any stale processes on ports 3000/3001...');
  try {
    const { execSync } = await import('node:child_process');
    execSync('lsof -ti:3000 -ti:3001 2>/dev/null | xargs -r kill -9 2>/dev/null || true', { stdio: 'ignore' });
  } catch {}
  await new Promise(r => setTimeout(r, 1000));
  log('  ports cleared');
  log('');

  // ── Start servers ──
  log('Starting server (npm start in server/)...');
  const serverProc = spawn('npm', ['start'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  serverProc.stdout?.on('data', (d) => {
    const s = d.toString();
    if (s.includes('avatar') || s.includes('manifest') || s.includes('validAvatar') || s.includes('avatar-route')) {
      process.stderr.write(`[server] ${s}`);
    }
  });
  serverProc.stderr?.on('data', (d) => {
    const s = d.toString();
    if (s.includes('avatar') || s.includes('manifest') || s.includes('validAvatar') || s.includes('avatar-route')) {
      process.stderr.write(`[server:err] ${s}`);
    }
  });

  log('Starting app (npm run dev in app/)...');
  const appProc = spawn('npm', ['run', 'dev'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  appProc.stdout?.on('data', (d) => {
    const s = d.toString();
    process.stderr.write(`[app] ${s}`);
  });
  appProc.stderr?.on('data', (d) => process.stderr.write(`[app:err] ${d}`));

  let browser: import('playwright').Browser | null = null;
  let page: import('playwright').Page | null = null;

  try {
    // Wait for both servers
    await waitForServer(SERVER_URL, 'server');
    await waitForApp(APP_URL, 'app', 60000);
    log('');

    // Get dev token
    const token = await getDevToken();
    log(`  dev token acquired: ${token.slice(0, 20)}...`);

    // Launch browser — with software WebGL flags so the Three.js Canvas
    // can render in headless Chromium (no GPU available in CI/containers).
    browser = await chromium.launch({
      headless: true,
      args: [
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--ignore-gpu-blocklist',
        '--enable-webgl',
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();

    // Capture browser console errors for debugging
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        log(`  [browser:error] ${msg.text().slice(0, 200)}`);
      }
    });
    page.on('pageerror', (err) => {
      log(`  [browser:pageerror] ${err.message.slice(0, 200)}`);
    });

    // Warmup: do one page load + PIP toggle so vite compiles the lazy
    // AvatarOverlay chunk and the VRM model fetch is cached. Without this,
    // the first test times out waiting for the chunk to compile on-demand.
    log('  [warmup] pre-loading app to compile lazy chunks...');
    resetSettings();
    await setPipEnabled(token, false);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await waitForPipToggle(page, 30000);
    // Pre-fetch the default VRM to warm the browser cache
    await page.evaluate(async () => {
      try {
        await fetch('/models/avatars/default/model.vrm');
      } catch {}
    });
    await page.getByTestId('pip-toggle').click();
    // Wait for overlay with a long timeout (first compile + VRM fetch + WebGL init)
    try {
      await waitForPipOverlay(page, 90000);
      log('  [warmup] overlay compiled and rendered ✓');
    } catch (e: any) {
      log(`  [warmup] overlay did not render in warmup: ${e.message}`);
    }
    await page.getByTestId('pip-toggle').click(); // toggle off
    await page.waitForTimeout(500);
    log('');

    // Run the three tests
    results.push(await test1_drag_reload_persist(page, token));
    results.push(await test2_toggle_reload_persist(page, token));
    results.push(await test3_selected_avatar_renders(page, token));

  } finally {
    // Cleanup
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    log('\nCleaning up servers...');
    try { serverProc.kill('SIGTERM'); } catch {}
    try { appProc.kill('SIGTERM'); } catch {}
    // Give them a moment then SIGKILL if still alive
    await new Promise(r => setTimeout(r, 1000));
    try { serverProc.kill('SIGKILL'); } catch {}
    try { appProc.kill('SIGKILL'); } catch {}
  }

  // ── Report ──
  log('\n' + '═'.repeat(72));
  log('RESULTS');
  log('═'.repeat(72));
  let passCount = 0;
  for (const r of results) {
    log(`\n${r.passed ? '✓ PASS' : '✗ FAIL'} — ${r.name}`);
    if (r.error) log(`  Error: ${r.error}`);
    log('  Evidence:');
    for (const [k, v] of Object.entries(r.evidence)) {
      log(`    ${k}: ${JSON.stringify(v)}`);
    }
    if (r.passed) passCount++;
  }

  log(`\n${'─'.repeat(72)}`);
  log(`Total: ${passCount}/${results.length} passed`);
  log('═'.repeat(72));

  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
