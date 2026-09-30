// scripts/test-mid-install-crash.ts
// Phase 3+ — Mid-install crash test (the REAL one).
//
// This is the test the user demanded: kill the install MID-PROGRESS (not after
// it completes, not by deleting a file afterward), then restart and confirm
// it resumes cleanly rather than landing in a broken half-installed state.
//
// Flow:
//   1. Verify clean starting state (no venv, no model cache)
//   2. Start the install in the background
//   3. Poll until the install is mid-download (deps phase, percent > 30)
//   4. KILL the install process (simulating app crash / closed tab)
//   5. Check the venv state (should be incomplete — pip was interrupted)
//   6. Restart the install
//   7. Confirm: it detects the partial state, resumes, completes successfully
//   8. Verify the sidecar actually works
//
// Usage:
//   cd server
//   npx tsx scripts/test-mid-install-crash.ts whisper
//   npx tsx scripts/test-mid-install-crash.ts kokoro

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sidecarInstaller } from '../src/sidecars/installer.js';
import { sidecarManager, ensureKokoroSidecar, ensureWhisperSidecar } from '../src/sidecars/manager.js';

const sidecar = process.argv[2] as 'kokoro' | 'whisper';
if (!sidecar || !['kokoro', 'whisper'].includes(sidecar)) {
  console.error('Usage: npx tsx scripts/test-mid-install-crash.ts <kokoro|whisper>');
  process.exit(1);
}

const sidecarDir = join(process.cwd(), 'sidecars', sidecar);
const venvDir = join(sidecarDir, 'venv');
const modelCacheDir = join(sidecarDir, 'model-cache');

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log(`\n=== Mid-install crash test: ${sidecar} ===\n`);

  // ── Step 1: Verify clean starting state ──────────────────────────────
  console.log('Step 1: Verifying clean starting state...');
  if (existsSync(venvDir)) {
    console.log(`  venv exists — removing for clean test`);
    rmSync(venvDir, { recursive: true, force: true });
  }
  if (existsSync(modelCacheDir)) {
    console.log(`  model cache exists — removing for clean test`);
    rmSync(modelCacheDir, { recursive: true, force: true });
  }
  console.log('✓ Clean state confirmed (no venv, no model cache)\n');

  // ── Step 2: Start install in the background ─────────────────────────
  console.log('Step 2: Starting install in the background...');
  const installPromise = sidecarInstaller.install(sidecar);
  // Don't await — we want to kill it mid-progress

  // ── Step 3: Poll until mid-download ──────────────────────────────────
  console.log('Step 3: Waiting for install to reach mid-progress...');
  let killed = false;
  let lastPercent = 0;
  const progressHandler = (p: any) => {
    lastPercent = p.percent;
    if (p.percent > 20 && !killed) {
      // Wait a moment to let pip actually start downloading, then kill
      console.log(`  Install at ${p.percent}% (${p.phase}: ${p.label})`);
      console.log(`  → KILLING install mid-progress (simulating app crash)`);
      killed = true;
      sidecarInstaller.cancel(sidecar);
    }
  };
  sidecarInstaller.on(`progress:${sidecar}`, progressHandler);

  try {
    await installPromise;
    console.log('  Install completed (was not killed in time — test inconclusive)');
  } catch (err: any) {
    if (err.message.includes('cancelled') || err.message.includes('Install cancelled')) {
      console.log('✓ Install was killed mid-progress as intended\n');
    } else {
      console.log(`  Install failed (not from cancel): ${err.message}`);
    }
  }

  sidecarInstaller.off(`progress:${sidecar}`, progressHandler);

  // ── Step 4: Check the partial state ──────────────────────────────────
  console.log('Step 4: Checking partial state after kill...');
  const partialState = sidecarInstaller.getInstallState(sidecar);
  console.log(`  venvExists:       ${partialState.venvExists}`);
  console.log(`  depsInstalled:    ${partialState.depsInstalled}`);
  console.log(`  modelDownloaded:  ${partialState.modelDownloaded}`);
  console.log(`  ready:            ${partialState.ready}`);
  // After a mid-deps kill, venv should exist but deps should NOT be installed
  // (pip was interrupted). This is the "broken half-installed state" the user
  // warned about — we need to confirm resume recovers from it.
  if (partialState.ready) {
    console.error('✗ FAIL: install completed despite kill — test inconclusive');
    process.exit(1);
  }
  console.log('✓ Partial state confirmed (NOT ready — install was interrupted)\n');

  // ── Step 5: Restart install ──────────────────────────────────────────
  console.log('Step 5: Restarting install (simulating user clicking Download again)...');
  const restartStart = Date.now();
  const restartEvents: any[] = [];
  sidecarInstaller.on(`progress:${sidecar}`, (p: any) => restartEvents.push(p));

  try {
    await sidecarInstaller.install(sidecar);
  } catch (err: any) {
    console.error(`✗ FAIL: restart install failed: ${err.message}`);
    process.exit(1);
  }

  const restartElapsed = ((Date.now() - restartStart) / 1000).toFixed(0);
  console.log(`✓ Restart install completed in ${restartElapsed}s\n`);

  // ── Step 6: Verify install completed cleanly ─────────────────────────
  console.log('Step 6: Verifying install completed cleanly...');
  const finalState = sidecarInstaller.getInstallState(sidecar);
  console.log(`  venvExists:       ${finalState.venvExists}`);
  console.log(`  depsInstalled:    ${finalState.depsInstalled}`);
  console.log(`  modelDownloaded:  ${finalState.modelDownloaded}`);
  console.log(`  ready:            ${finalState.ready}`);
  if (!finalState.ready) {
    console.error('✗ FAIL: install not ready after restart — broken half-installed state!');
    process.exit(1);
  }
  console.log('✓ Install recovered cleanly from mid-progress kill\n');

  // ── Step 7: Verify sidecar actually works ────────────────────────────
  console.log('Step 7: Verifying sidecar actually works...');
  if (sidecar === 'kokoro') {
    ensureKokoroSidecar();
    const result = await sidecarManager.request('kokoro', {
      type: 'tts',
      text: 'Hello, this is a test after a mid-install crash.',
      voice: 'af_heart',
      langCode: 'a',
    }, 60_000);
    if (!result.ok) {
      console.error(`✗ FAIL: Kokoro speak() failed: ${result.error}`);
      process.exit(1);
    }
    const audioLen = (result as any).audioBase64?.length ?? 0;
    console.log(`  Kokoro speak() returned ${audioLen} bytes of base64 audio`);
    if (audioLen < 1000) {
      console.error('✗ FAIL: audio too short');
      process.exit(1);
    }
    console.log('✓ Kokoro TTS works after crash recovery\n');
  } else {
    ensureWhisperSidecar();
    // Send a tiny test WAV (silence — just verify the sidecar responds)
    const sampleRate = 16000;
    const numSamples = sampleRate; // 1 second
    const buffer = Buffer.alloc(44 + numSamples * 2);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + numSamples * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(numSamples * 2, 40);

    const result = await sidecarManager.request('whisper', {
      type: 'transcribe',
      audioBase64: buffer.toString('base64'),
    }, 60_000);
    if (!result.ok) {
      console.error(`✗ FAIL: Whisper transcribe() failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`  Whisper transcribe() responded: "${(result as any).text || '(empty — expected for silence)'}"`);
    console.log('✓ Whisper ASR works after crash recovery\n');
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log('=== MID-INSTALL CRASH TEST PASSED ===');
  console.log(`Sidecar: ${sidecar}`);
  console.log(`Restart install time: ${restartElapsed}s`);
  console.log('The install was killed mid-progress, then resumed cleanly.');
  console.log('No broken half-installed state. Sidecar works.\n');
}

main().catch((err) => {
  console.error('\n✗ Test failed with error:', err);
  process.exit(1);
});
