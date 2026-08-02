// scripts/generate-voice-test-audio.mts
//
// Generates a real speech WAV file using ZaiTTSProvider (already proven to work).
// This gives us real audio that the z-ai ASR can transcribe — a proper
// round-trip test for the voice pipeline.
//
// Output: /tmp/voice-test-input.wav

import { ZaiTTSProvider } from '../server/src/systems/voice/tts-provider.js';
import { writeFileSync } from 'node:fs';

async function main() {
  console.log('Generating real speech audio via ZaiTTSProvider...');
  const provider = new ZaiTTSProvider();
  const result = await provider.speak('What time is it?');
  console.log(`Generated: ${result.audioBase64.length} chars base64, ${result.durationMs}ms, ${result.format} ${result.sampleRate}Hz`);

  const wavBytes = Buffer.from(result.audioBase64, 'base64');
  const outPath = '/tmp/voice-test-input.wav';
  writeFileSync(outPath, wavBytes);
  console.log(`Saved: ${outPath} (${wavBytes.length} bytes)`);

  // Verify RIFF header
  const riff = wavBytes.slice(0, 4).toString('ascii');
  const wave = wavBytes.slice(8, 12).toString('ascii');
  console.log(`WAV header: ${riff}/${wave} (expected RIFF/WAVE)`);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    console.error('FAIL: invalid WAV header');
    process.exit(1);
  }
  console.log('✓ Valid WAV file generated');
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
