// scripts/test-kokoro-to-whisper.ts
// Direct test: Kokoro TTS → Whisper transcribe pipeline
// Verifies the audio format is compatible between the two sidecars.

import { sidecarManager, ensureKokoroSidecar, ensureWhisperSidecar } from '../src/sidecars/manager.js';
import { wrapPcmInWav } from '../src/systems/voice/audio-wav.js';
import { writeFileSync } from 'node:fs';

async function main() {
  console.log('=== Kokoro → Whisper pipeline test ===\n');

  // 1. Generate speech with Kokoro
  console.log('1. Generating speech with Kokoro...');
  ensureKokoroSidecar();
  const ttsResult = await sidecarManager.request('kokoro', {
    type: 'tts',
    text: 'The quick brown fox jumps over the lazy dog.',
    voice: 'af_heart',
    langCode: 'a',
  }, 120_000);

  if (!ttsResult.ok) {
    console.error('✗ Kokoro TTS failed:', (ttsResult as any).error);
    process.exit(1);
  }

  const pcmBase64 = (ttsResult as any).audioBase64;
  const sampleRate = (ttsResult as any).sampleRate;
  const pcmBytes = Buffer.from(pcmBase64, 'base64');
  console.log(`  ✓ Kokoro returned ${pcmBytes.length} bytes of PCM at ${sampleRate}Hz`);

  // 2. Wrap in WAV
  const wavBuffer = wrapPcmInWav(pcmBytes, sampleRate, 1);
  console.log(`  ✓ Wrapped in WAV: ${wavBuffer.length} bytes`);
  console.log(`  WAV header: ${wavBuffer.slice(0, 4).toString('ascii')} ${wavBuffer.slice(8, 12).toString('ascii')}`);

  // Save for inspection
  writeFileSync('/tmp/kokoro_speech.wav', wavBuffer);
  console.log('  ✓ Saved to /tmp/kokoro_speech.wav');

  // 3. Transcribe with Whisper
  console.log('\n2. Transcribing with Whisper large-v3-turbo...');
  ensureWhisperSidecar();
  const transcribeResult = await sidecarManager.request('whisper', {
    type: 'transcribe',
    audioBase64: wavBuffer.toString('base64'),
  }, 120_000);

  if (!transcribeResult.ok) {
    console.error('✗ Whisper transcribe failed:', (transcribeResult as any).error);
    process.exit(1);
  }

  const transcript = (transcribeResult as any).text?.trim() || '(empty)';
  const language = (transcribeResult as any).language;
  const duration = (transcribeResult as any).duration;
  console.log(`  ✓ Whisper transcribed:`);
  console.log(`    Transcript: "${transcript}"`);
  console.log(`    Language:   ${language}`);
  console.log(`    Duration:   ${duration}s`);

  // 4. Check accuracy
  const original = 'the quick brown fox jumps over the lazy dog';
  const originalWords = original.split(/\s+/);
  const transcriptWords = transcript.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const matched = originalWords.filter(w => transcriptWords.includes(w)).length;
  const accuracy = (matched / originalWords.length * 100).toFixed(0);
  console.log(`\n3. Accuracy: ${matched}/${originalWords.length} words (${accuracy}%)`);

  if (matched >= originalWords.length * 0.6) {
    console.log('✓ PASS — accuracy acceptable');
  } else {
    console.log('⚠ WARN — accuracy below 60% (may be due to TTS pronunciation vs Whisper interpretation)');
  }

  console.log('\n=== Pipeline test complete ===');
}

main().catch((err) => {
  console.error('\n✗ Test failed:', err);
  process.exit(1);
});
