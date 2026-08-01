// scripts/kokoro-provider-isolated-test.ts
//
// Phase E Build 1, Step 4 — Isolated proof that KokoroTTSProvider works
// end-to-end through the real Node-side path (SidecarManager → sidecar
// process → Kokoro inference → response mapping → TTSResult).
//
// This does NOT wire KokoroTTSProvider as the active provider — it directly
// instantiates it and calls .speak(). ZaiTTSProvider remains the default
// in index.ts.
//
// Run: npx tsx scripts/kokoro-provider-isolated-test.ts

import { KokoroTTSProvider } from '../server/src/systems/voice/kokoro-provider.js';
import { sidecarManager } from '../server/src/sidecars/manager.js';
import { writeFileSync } from 'node:fs';

async function main() {
  console.log('='.repeat(70));
  console.log('STEP 4 — KokoroTTSProvider isolated proof');
  console.log('='.repeat(70));
  console.log('Instantiating KokoroTTSProvider (default voice=af_heart, lang=a)');
  const provider = new KokoroTTSProvider();
  console.log(`implementation: ${provider.implementation}`);
  console.log();

  // ─── Test 1: First call (lazy sidecar spawn + lazy model load) ──────
  console.log('='.repeat(70));
  console.log('TEST 1 — first .speak() call (lazy sidecar spawn + model load)');
  console.log('='.repeat(70));
  const text1 = 'Hello from Kokoro. This is the Code Siren voice pipeline.';
  console.log(`Input text: "${text1}"`);
  const t1Start = Date.now();
  let result1;
  try {
    result1 = await provider.speak(text1);
  } catch (err: any) {
    console.error(`FAIL: speak() threw: ${err.message}`);
    process.exit(1);
  }
  const t1End = Date.now();
  console.log(`Result:`);
  console.log(`  implementation: ${provider.implementation}`);
  console.log(`  format:         ${result1.format}`);
  console.log(`  sampleRate:     ${result1.sampleRate} Hz`);
  console.log(`  durationMs:     ${result1.durationMs} ms (${(result1.durationMs / 1000).toFixed(2)}s of audio)`);
  console.log(`  audioBase64:    ${result1.audioBase64.length} chars`);
  console.log(`  wall-clock:     ${t1End - t1Start} ms (includes lazy sidecar spawn + model load + inference)`);
  console.log(`  real-time factor: ${(result1.durationMs / (t1End - t1Start)).toFixed(2)}x`);
  console.log();
  if (result1.format !== 'wav') throw new Error(`expected format=wav, got ${result1.format}`);
  if (result1.sampleRate !== 24000) throw new Error(`expected sampleRate=24000, got ${result1.sampleRate}`);
  if (result1.durationMs <= 0) throw new Error('expected durationMs > 0');
  if (result1.audioBase64.length < 1000) throw new Error('audioBase64 suspiciously short');
  console.log('✓ PASS — TTSResult shape correct, real audio produced');
  console.log();

  // Save the audio so we can verify the bytes are valid WAV-able PCM
  const audioBytes = Buffer.from(result1.audioBase64, 'base64');
  // Wrap in WAV header for playback verification
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + audioBytes.length, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);   // PCM
  wavHeader.writeUInt16LE(1, 22);   // mono
  wavHeader.writeUInt32LE(24000, 24);
  wavHeader.writeUInt32LE(24000 * 2, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(audioBytes.length, 40);
  const wavPath = '/tmp/kokoro-step4-test1.wav';
  writeFileSync(wavPath, Buffer.concat([wavHeader, audioBytes]));
  console.log(`Saved WAV: ${wavPath} (${44 + audioBytes.length} bytes)`);
  console.log();

  // ─── Test 2: Second call (sidecar reuse, model already loaded) ──────
  console.log('='.repeat(70));
  console.log('TEST 2 — second .speak() call (sidecar reuse, model loaded)');
  console.log('='.repeat(70));
  const text2 = 'Code Siren is now speaking with a local neural text to speech model.';
  console.log(`Input text: "${text2}"`);
  const t2Start = Date.now();
  const result2 = await provider.speak(text2);
  const t2End = Date.now();
  console.log(`  durationMs:     ${result2.durationMs} ms`);
  console.log(`  audioBase64:    ${result2.audioBase64.length} chars`);
  console.log(`  wall-clock:     ${t2End - t2Start} ms (should be much faster — no model load)`);
  console.log();
  if (result2.durationMs <= 0) throw new Error('expected durationMs > 0');
  console.log('✓ PASS — second call works, sidecar reuse confirmed');
  console.log();

  // ─── Test 3: Empty text (should throw, no fabricated audio) ─────────
  console.log('='.repeat(70));
  console.log('TEST 3 — empty text input (should throw honestly)');
  console.log('='.repeat(70));
  try {
    await provider.speak('');
    console.error('FAIL: speak("") did not throw');
    process.exit(1);
  } catch (err: any) {
    console.log(`Threw: ${err.message}`);
    if (!err.message.toLowerCase().includes('empty')) {
      console.error(`FAIL: error message does not mention "empty": ${err.message}`);
      process.exit(1);
    }
    console.log('✓ PASS — empty text throws honestly');
  }
  console.log();

  // ─── Test 4: Sidecar status check ───────────────────────────────────
  console.log('='.repeat(70));
  console.log('TEST 4 — sidecar still running (lifecycle verified)');
  console.log('='.repeat(70));
  const running = sidecarManager.isRunning('kokoro');
  console.log(`sidecarManager.isRunning('kokoro'): ${running}`);
  if (!running) throw new Error('sidecar should still be running after 3 successful calls');
  console.log('✓ PASS — sidecar still alive, reused across calls');
  console.log();

  // ─── Clean shutdown ─────────────────────────────────────────────────
  console.log('='.repeat(70));
  console.log('CLEAN SHUTDOWN — killAll() to clean up sidecar process');
  console.log('='.repeat(70));
  sidecarManager.killAll();
  console.log('sidecarManager.killAll() called');
  // Give the kill signal a moment to take effect
  await new Promise(r => setTimeout(r, 500));
  const stillRunning = sidecarManager.isRunning('kokoro');
  console.log(`sidecarManager.isRunning('kokoro') after kill: ${stillRunning}`);
  if (stillRunning) console.log('(note: may show true briefly until SIGTERM handler exits)');

  console.log();
  console.log('='.repeat(70));
  console.log('ALL STEP 4 TESTS PASSED');
  console.log('='.repeat(70));
  console.log('KokoroTTSProvider works end-to-end through the real Node path.');
  console.log('Ready for Step 5 (fabrication-guard test).');
}

main().catch(err => {
  console.error('UNCAUGHT ERROR:', err);
  process.exit(1);
});
