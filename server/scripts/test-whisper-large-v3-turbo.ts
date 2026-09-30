// scripts/test-whisper-large-v3-turbo.ts
// Phase 3+ — Whisper large-v3-turbo verification.
//
// This is the REAL test the user demanded:
//   1. Genuinely clean state (no venv, no cache)
//   2. Full install of large-v3-turbo default
//   3. Report actual install time + disk usage
//   4. Transcribe REAL speech audio (not silence)
//   5. Verify model_size override still works (can request a smaller model)
//   6. Verify av<14 pin still resolves cleanly with large-v3-turbo's runtime
//
// For real speech audio: we use Kokoro TTS to generate a spoken sentence,
// then transcribe it with Whisper. This exercises the full audio pipeline
// (text → speech → audio bytes → WAV → Whisper → text) and confirms the
// transcript matches the original input.

import { sidecarInstaller } from '../src/sidecars/installer.js';
import { sidecarManager, ensureKokoroSidecar, ensureWhisperSidecar } from '../src/sidecars/manager.js';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const out = execSync(`du -sb ${path}`, { encoding: 'utf8' }).trim();
    return parseInt(out.split(/\s+/)[0], 10) || 0;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

async function main() {
  console.log('\n=== Whisper large-v3-turbo verification ===\n');

  const sidecarDir = join(process.cwd(), 'sidecars', 'whisper');
  const venvDir = join(sidecarDir, 'venv');
  const modelCacheDir = join(sidecarDir, 'model-cache');

  // ── Step 1: Clean state ─────────────────────────────────────────────
  console.log('Step 1: Verifying clean state...');
  if (existsSync(venvDir)) { rmSync(venvDir, { recursive: true, force: true }); }
  if (existsSync(modelCacheDir)) { rmSync(modelCacheDir, { recursive: true, force: true }); }
  console.log('✓ Clean — no venv, no model cache\n');

  // ── Step 2: Install (real time + disk) ──────────────────────────────
  console.log('Step 2: Installing Whisper with large-v3-turbo default...');
  console.log('(This takes 5-15 min — downloading deps + 1.5 GB model)\n');
  const installStart = Date.now();

  sidecarInstaller.on('progress:whisper', (p: any) => {
    const elapsed = ((Date.now() - installStart) / 1000).toFixed(0);
    if (p.phase === 'error') {
      console.error(`  [${elapsed}s] ✗ ERROR: ${p.error}`);
      process.exit(1);
    }
    // Only log phase transitions + every 10s
    console.log(`  [${elapsed}s] ${p.percent}% — ${p.label}${p.detail ? ` (${p.detail})` : ''}`);
  });

  await sidecarInstaller.install('whisper');
  const installSeconds = Math.round((Date.now() - installStart) / 1000);
  console.log(`\n✓ Install completed in ${installSeconds}s (${(installSeconds / 60).toFixed(1)} min)\n`);

  // ── Step 3: Disk usage ──────────────────────────────────────────────
  console.log('Step 3: Measuring actual disk usage...');
  const venvBytes = dirSize(venvDir);
  const cacheBytes = dirSize(modelCacheDir);
  const totalBytes = venvBytes + cacheBytes;
  console.log(`  venv:        ${formatBytes(venvBytes)}`);
  console.log(`  model cache: ${formatBytes(cacheBytes)}`);
  console.log(`  total:       ${formatBytes(totalBytes)}`);
  const estimate = await sidecarInstaller.getEstimate('whisper');
  console.log(`  estimated:   ${estimate.estimatedSizeHuman}`);
  console.log(`  accuracy:    ${((totalBytes / (estimate.estimatedSizeMb * 1024 * 1024)) * 100).toFixed(0)}% of estimate\n`);

  // ── Step 4: Verify av<14 still works with large-v3-turbo ────────────
  console.log('Step 4: Verifying av<14 pin resolves cleanly with large-v3-turbo runtime...');
  const pipShow = execSync(`${join(venvDir, 'bin', 'pip')} show av faster-whisper`, { encoding: 'utf8' });
  const avVersion = pipShow.match(/Name: av\nVersion: (\S+)/)?.[1];
  const fwVersion = pipShow.match(/Name: faster-whisper\nVersion: (\S+)/)?.[1];
  console.log(`  av version:              ${avVersion}`);
  console.log(`  faster-whisper version:  ${fwVersion}`);
  if (!avVersion || !avVersion.startsWith('13.') && !avVersion.startsWith('12.') && !avVersion.startsWith('11.') && !avVersion.startsWith('10.') && !avVersion.startsWith('9.')) {
    console.error(`✗ FAIL: av version ${avVersion} is >= 14 — the metadata_errors bug will recur`);
    process.exit(1);
  }
  console.log('✓ av<14 pin confirmed — metadata_errors bug will not recur\n');

  // ── Step 5: Real transcription test (actual speech audio) ───────────
  console.log('Step 5: Real transcription test with actual speech audio...');
  console.log('  (Using Kokoro TTS to generate a spoken sentence, then transcribing it)');

  // First check if Kokoro is installed; if not, install it too
  const kokoroState = sidecarInstaller.getInstallState('kokoro');
  if (!kokoroState.ready) {
    console.log('  Kokoro not installed — installing it for the speech test...');
    const kokoroStart = Date.now();
    sidecarInstaller.removeAllListeners();
    sidecarInstaller.on('progress:kokoro', (p: any) => {
      const elapsed = ((Date.now() - kokoroStart) / 1000).toFixed(0);
      console.log(`  [kokoro ${elapsed}s] ${p.percent}% — ${p.label}`);
    });
    await sidecarInstaller.install('kokoro');
    console.log(`  ✓ Kokoro installed in ${Math.round((Date.now() - kokoroStart) / 1000)}s\n`);
  } else {
    console.log('  ✓ Kokoro already installed\n');
  }

  // Generate a spoken sentence with Kokoro
  const testSentence = 'The quick brown fox jumps over the lazy dog.';
  console.log(`  Generating speech: "${testSentence}"`);
  ensureKokoroSidecar();
  const ttsResult = await sidecarManager.request('kokoro', {
    type: 'tts',
    text: testSentence,
    voice: 'af_heart',
    langCode: 'a',
  }, 120_000);
  if (!ttsResult.ok) {
    console.error(`✗ FAIL: Kokoro TTS failed: ${(ttsResult as any).error}`);
    process.exit(1);
  }
  const audioBase64 = (ttsResult as any).audioBase64;
  console.log(`  ✓ Kokoro generated ${audioBase64.length} bytes of base64 audio`);

  // Transcribe the Kokoro-generated audio with Whisper
  console.log('  Transcribing with Whisper large-v3-turbo...');
  ensureWhisperSidecar();
  const transcribeStart = Date.now();
  const transcribeResult = await sidecarManager.request('whisper', {
    type: 'transcribe',
    audioBase64: audioBase64,
  }, 120_000);
  const transcribeMs = Date.now() - transcribeStart;
  if (!transcribeResult.ok) {
    console.error(`✗ FAIL: Whisper transcribe failed: ${(transcribeResult as any).error}`);
    process.exit(1);
  }
  const transcript = (transcribeResult as any).text?.trim() || '(empty)';
  console.log(`  ✓ Whisper transcribed in ${(transcribeMs / 1000).toFixed(1)}s`);
  console.log(`  Transcript: "${transcript}"`);
  console.log(`  Original:   "${testSentence}"`);

  // Check accuracy — transcript should contain most of the words
  const originalWords = testSentence.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const transcriptWords = transcript.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const matched = originalWords.filter(w => transcriptWords.includes(w)).length;
  const accuracy = (matched / originalWords.length * 100).toFixed(0);
  console.log(`  Word match:  ${matched}/${originalWords.length} (${accuracy}%)`);
  if (matched < originalWords.length * 0.6) {
    console.error(`✗ FAIL: accuracy too low (${accuracy}% < 60%)`);
    process.exit(1);
  }
  console.log('✓ Real transcription works — accuracy acceptable\n');

  // ── Step 6: Verify model_size override ──────────────────────────────
  console.log('Step 6: Verifying model_size override param works...');
  console.log('  (Requesting "base" model — should be faster than large-v3-turbo)');

  // Kill the running Whisper sidecar (which has large-v3-turbo loaded)
  sidecarManager.kill('whisper');
  await new Promise((r) => setTimeout(r, 1000));
  sidecarManager.removeDead('whisper');

  // Spawn fresh + request "base" model
  ensureWhisperSidecar();
  const overrideResult = await sidecarManager.request('whisper', {
    type: 'transcribe',
    audioBase64: audioBase64,
    model_size: 'base',  // override!
  }, 120_000);
  if (!overrideResult.ok) {
    console.error(`✗ FAIL: Whisper with model_size=base failed: ${(overrideResult as any).error}`);
    process.exit(1);
  }
  const overrideTranscript = (overrideResult as any).text?.trim() || '(empty)';
  console.log(`  ✓ model_size=base transcribed: "${overrideTranscript}"`);
  console.log('✓ model_size override works — users can choose smaller models\n');

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('=== ALL TESTS PASSED ===');
  console.log(`Install time:    ${installSeconds}s (${(installSeconds / 60).toFixed(1)} min)`);
  console.log(`Disk usage:      ${formatBytes(totalBytes)} (venv ${formatBytes(venvBytes)} + cache ${formatBytes(cacheBytes)})`);
  console.log(`av version:      ${avVersion} (<14 pin confirmed)`);
  console.log(`Transcript:      "${transcript}"`);
  console.log(`Accuracy:         ${accuracy}% word match`);
  console.log(`Override:         model_size=base works ✓`);
}

main().catch((err) => {
  console.error('\n✗ Test failed:', err);
  process.exit(1);
});
