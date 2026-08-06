// scripts/custom-avatar-tests.mts
//
// Phase B: Custom VRM avatar upload — real behavioral tests.
//
// Tests:
//   1. Upload a real .vrm file → server saves it → manifest includes it
//   2. Uploaded avatar is selectable (POST /api/avatar/settings with its ID)
//   3. Uploaded avatar's model.vrm is fetchable
//   4. Rename the avatar → manifest reflects the new name
//   5. Name conflict check works (rejects duplicates)
//   6. Delete the avatar → manifest no longer includes it, files removed
//   7. Built-in avatars cannot be deleted (404)

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SERVER_DIR = join(PROJECT_ROOT, 'server');
const APP_DIR = join(PROJECT_ROOT, 'app');

const SERVER_URL = 'http://localhost:3001';
const APP_URL = 'http://localhost:3000';
const DEFAULT_VRM_PATH = join(APP_DIR, 'public', 'models', 'avatars', 'default', 'model.vrm');

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

async function waitForServer(url: string, label: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        log(`  [setup] ${label} ready at ${url}`);
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms`);
}

async function waitForApp(url: string, label: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        log(`  [setup] ${label} ready at ${url}`);
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms`);
}

async function getDevToken(): Promise<string> {
  const email = 'dev@code-siren.local';
  const password = 'dev-password-step-0';
  const name = 'Step 0 Developer';
  let res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (res.status === 201) {
    return (await res.json() as { token: string }).token;
  }
  if (res.status === 409) {
    res = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) return (await res.json() as { token: string }).token;
  }
  throw new Error(`Failed to get dev token: ${res.status}`);
}

async function main() {
  log('═'.repeat(72));
  log('Phase B — Custom VRM Avatar Behavioral Tests');
  log('═'.repeat(72));
  log('');

  // Kill stale processes
  log('Killing any stale processes on ports 3000/3001...');
  try {
    const { execSync } = await import('node:child_process');
    execSync('lsof -ti:3000 -ti:3001 2>/dev/null | xargs -r kill -9 2>/dev/null || true', { stdio: 'ignore' });
  } catch {}
  await new Promise(r => setTimeout(r, 1000));

  // Verify the source VRM exists
  if (!existsSync(DEFAULT_VRM_PATH)) {
    log(`FATAL: Default VRM not found at ${DEFAULT_VRM_PATH}`);
    process.exit(1);
  }
  const vrmBuffer = readFileSync(DEFAULT_VRM_PATH);
  log(`  [setup] source VRM: ${DEFAULT_VRM_PATH} (${(vrmBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

  // Start server
  log('Starting server...');
  const serverProc = spawn('npm', ['start'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  serverProc.stderr?.on('data', (d) => {
    const s = d.toString();
    if (s.includes('avatar') || s.includes('custom-')) {
      process.stderr.write(`[server] ${s}`);
    }
  });

  // Start app (vite dev server — serves static files from app/public)
  log('Starting app (vite dev server)...');
  const appProc = spawn('npm', ['run', 'dev'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  appProc.stderr?.on('data', (d) => process.stderr.write(`[app:err] ${d}`));

  try {
    await waitForServer(SERVER_URL, 'server', 30000);
    await waitForApp(APP_URL, 'app', 30000);
    log('');

    const token = await getDevToken();
    log(`  dev token acquired`);
    log('');

    let customAvatarId: string | null = null;

    // ─── TEST 1: Upload a custom VRM ────────────────────────────────────
    log('── TEST 1: Upload a custom VRM ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        const formData = new FormData();
        const fileBlob = new Blob([vrmBuffer], { type: 'application/octet-stream' });
        formData.append('file', fileBlob, 'my-test-avatar.vrm');

        const metadata = {
          name: 'Test Custom Avatar',
          format: '1.0' as const,
          expressionCount: 18,
          expressionPresets: ['happy', 'sad', 'angry', 'surprised', 'relaxed', 'aa', 'ee', 'ih', 'oh', 'ou', 'blink'],
          meshCount: 12,
          materialCount: 8,
          boneCount: 65,
          textureCount: 5,
          triangleCount: 25000,
          hasLookAt: true,
          hasSpringBone: true,
          hasHumanoid: true,
          issues: [],
        };
        formData.append('metadata', JSON.stringify(metadata));

        const res = await fetch(`${SERVER_URL}/api/avatar/custom`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });

        evidence['upload status'] = res.status;
        if (!res.ok) {
          const errText = await res.text();
          evidence['error body'] = errText;
          throw new Error(`Upload failed: ${res.status} ${errText}`);
        }
        const data = await res.json() as { avatar: any };
        evidence['returned avatar id'] = data.avatar.id;
        evidence['returned avatar name'] = data.avatar.name;
        evidence['isCustom flag'] = data.avatar.isCustom;
        evidence['format'] = data.avatar.format;
        evidence['expressionCount'] = data.avatar.expressionCount;

        customAvatarId = data.avatar.id;
        log(`  uploaded: id=${customAvatarId}, name="${data.avatar.name}"`);
        results.push({ name: 'TEST 1: Upload custom VRM', passed: !!customAvatarId, evidence });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'TEST 1: Upload custom VRM', passed: false, evidence, error: err.message });
      }
    }

    // ─── TEST 2: Manifest includes the custom avatar ───────────────────
    log('\n── TEST 2: Manifest includes custom avatar ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        const res = await fetch(`${SERVER_URL}/api/avatar/manifest`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as { avatars: any[] };
        const customAvatars = data.avatars.filter(a => a.isCustom);
        const found = customAvatars.find(a => a.id === customAvatarId);
        evidence['total avatars'] = data.avatars.length;
        evidence['custom avatars count'] = customAvatars.length;
        evidence['custom avatar found'] = !!found;
        evidence['custom avatar name'] = found?.name;
        log(`  manifest has ${data.avatars.length} avatars (${customAvatars.length} custom)`);
        log(`  found our custom avatar: ${!!found}`);
        results.push({
          name: 'TEST 2: Manifest includes custom avatar',
          passed: !!found,
          evidence,
        });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'TEST 2: Manifest includes custom avatar', passed: false, evidence, error: err.message });
      }
    }

    // ─── TEST 3: Custom avatar is selectable ───────────────────────────
    log('\n── TEST 3: Custom avatar is selectable ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        const res = await fetch(`${SERVER_URL}/api/avatar/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ selectedAvatarId: customAvatarId }),
        });
        evidence['set selectedAvatarId status'] = res.status;
        const data = await res.json() as { settings: any };
        evidence['persisted selectedAvatarId'] = data.settings.selectedAvatarId;

        // Verify via GET
        const getRes = await fetch(`${SERVER_URL}/api/avatar/settings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const getData = await getRes.json() as { settings: any };
        evidence['GET selectedAvatarId'] = getData.settings.selectedAvatarId;
        log(`  selectedAvatarId persisted: ${getData.settings.selectedAvatarId}`);
        results.push({
          name: 'TEST 3: Custom avatar is selectable',
          passed: getData.settings.selectedAvatarId === customAvatarId,
          evidence,
        });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'TEST 3: Custom avatar is selectable', passed: false, evidence, error: err.message });
      }
    }

    // ─── TEST 4: Custom avatar's model.vrm is fetchable ────────────────
    log('\n── TEST 4: Custom avatar model.vrm is fetchable ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        // Custom avatars are served by the API server (not vite) at
        // /models/avatars/custom/<id>/model.vrm
        const url = `${SERVER_URL}/models/avatars/custom/${customAvatarId}/model.vrm`;
        const res = await fetch(url);
        evidence['fetch status'] = res.status;
        evidence['content-type'] = res.headers.get('content-type');
        const buf = await res.arrayBuffer();
        evidence['file size bytes'] = buf.byteLength;
        evidence['matches original size'] = buf.byteLength === vrmBuffer.length;
        // Check VRM magic bytes
        const view = new DataView(buf);
        const magic = view.getUint32(0, true);
        evidence['glTF magic (0x46546C67)'] = `0x${magic.toString(16)}`;
        evidence['is valid VRM'] = magic === 0x46546C67;
        log(`  fetched ${buf.byteLength} bytes, valid VRM: ${magic === 0x46546C67}`);
        results.push({
          name: 'TEST 4: Custom avatar model.vrm fetchable',
          passed: res.ok && magic === 0x46546C67 && buf.byteLength === vrmBuffer.length,
          evidence,
        });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'TEST 4: Custom avatar model.vrm fetchable', passed: false, evidence, error: err.message });
      }
    }

    // ─── TEST 5: Rename the avatar ─────────────────────────────────────
    log('\n── TEST 5: Rename avatar ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        const newName = 'My Renamed Avatar';
        const res = await fetch(`${SERVER_URL}/api/avatar/custom/${customAvatarId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: newName }),
        });
        evidence['rename status'] = res.status;
        const data = await res.json() as { avatar: any };
        evidence['new name'] = data.avatar?.name;
        evidence['id unchanged'] = data.avatar?.id === customAvatarId;
        log(`  renamed to "${data.avatar?.name}", id unchanged: ${data.avatar?.id === customAvatarId}`);

        // Verify via manifest
        const manifestRes = await fetch(`${SERVER_URL}/api/avatar/manifest`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const manifestData = await manifestRes.json() as { avatars: any[] };
        const found = manifestData.avatars.find(a => a.id === customAvatarId);
        evidence['manifest name'] = found?.name;
        results.push({
          name: 'TEST 5: Rename avatar',
          passed: found?.name === newName && data.avatar?.id === customAvatarId,
          evidence,
        });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'TEST 5: Rename avatar', passed: false, evidence, error: err.message });
      }
    }

    // ─── TEST 6: Name conflict check ───────────────────────────────────
    log('\n── TEST 6: Name conflict check ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        // Try to upload with name "Default Avatar" (built-in) — should conflict
        const checkRes = await fetch(`${SERVER_URL}/api/avatar/custom/check-name?name=${encodeURIComponent('Default Avatar')}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const checkData = await checkRes.json() as { conflict: boolean };
        evidence['"Default Avatar" conflict'] = checkData.conflict;

        // Try with a unique name — should not conflict
        const uniqueRes = await fetch(`${SERVER_URL}/api/avatar/custom/check-name?name=${encodeURIComponent('Unique-Name-12345')}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const uniqueData = await uniqueRes.json() as { conflict: boolean };
        evidence['"Unique-Name-12345" conflict'] = uniqueData.conflict;
        log(`  "Default Avatar" conflict: ${checkData.conflict}, unique name conflict: ${uniqueData.conflict}`);
        results.push({
          name: 'TEST 6: Name conflict check',
          passed: checkData.conflict === true && uniqueData.conflict === false,
          evidence,
        });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'TEST 6: Name conflict check', passed: false, evidence, error: err.message });
      }
    }

    // ─── TEST 7: Delete the avatar ─────────────────────────────────────
    log('\n── TEST 7: Delete avatar ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        const res = await fetch(`${SERVER_URL}/api/avatar/custom/${customAvatarId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        evidence['delete status'] = res.status;
        const data = await res.json() as { deleted: boolean; settingsReset?: boolean };
        evidence['deleted flag'] = data.deleted;
        evidence['settingsReset'] = data.settingsReset;
        log(`  deleted: ${data.deleted}, settingsReset: ${data.settingsReset}`);

        // Verify via manifest
        const manifestRes = await fetch(`${SERVER_URL}/api/avatar/manifest`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const manifestData = await manifestRes.json() as { avatars: any[] };
        const stillThere = manifestData.avatars.find(a => a.id === customAvatarId);
        evidence['avatar still in manifest'] = !!stillThere;

        // Verify file is gone
        const filePath = join(APP_DIR, 'public', 'models', 'avatars', 'custom', customAvatarId!, 'model.vrm');
        evidence['file removed'] = !existsSync(filePath);
        log(`  avatar in manifest: ${!!stillThere}, file removed: ${!existsSync(filePath)}`);
        results.push({
          name: 'TEST 7: Delete avatar',
          passed: data.deleted && !stillThere && !existsSync(filePath),
          evidence,
        });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'TEST 7: Delete avatar', passed: false, evidence, error: err.message });
      }
    }

    // ─── TEST 8: Built-in avatar cannot be deleted ─────────────────────
    log('\n── TEST 8: Built-in avatar cannot be deleted ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        const res = await fetch(`${SERVER_URL}/api/avatar/custom/default`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        evidence['delete default status'] = res.status;
        const data = await res.json() as { error: string };
        evidence['error message'] = data.error;
        log(`  delete default → ${res.status}: ${data.error}`);
        results.push({
          name: 'TEST 8: Built-in cannot be deleted',
          passed: res.status === 404,
          evidence,
        });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'TEST 8: Built-in cannot be deleted', passed: false, evidence, error: err.message });
      }
    }

  } finally {
    log('\nCleaning up server + app...');
    try { serverProc.kill('SIGTERM'); } catch {}
    try { appProc.kill('SIGTERM'); } catch {}
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
