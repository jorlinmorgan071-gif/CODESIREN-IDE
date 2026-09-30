import { sidecarManager, ensureWhisperSidecar } from '../src/sidecars/manager.js';
import { wrapPcmInWav } from '../src/systems/voice/audio-wav.js';
import { ensureKokoroSidecar } from '../src/sidecars/manager.js';

(async () => {
  console.log('=== model_size override test ===');
  console.log('Default is large-v3-turbo. Requesting model_size=base should override.');
  
  // Generate speech with Kokoro
  ensureKokoroSidecar();
  const tts = await sidecarManager.request('kokoro', {
    type: 'tts',
    text: 'Hello world.',
    voice: 'af_heart',
    langCode: 'a',
  }, 60_000);
  
  if (!tts.ok) { console.error('Kokoro failed'); process.exit(1); }
  const wav = wrapPcmInWav(Buffer.from(tts.audioBase64, 'base64'), tts.sampleRate, 1);
  console.log('Generated speech audio');
  
  // Kill any running whisper sidecar + restart fresh
  sidecarManager.kill('whisper');
  await new Promise(r => setTimeout(r, 1000));
  sidecarManager.removeDead('whisper');
  
  // Request transcribe with model_size=base override
  ensureWhisperSidecar();
  console.log('Requesting transcribe with model_size=base...');
  const result = await sidecarManager.request('whisper', {
    type: 'transcribe',
    audioBase64: wav.toString('base64'),
    model_size: 'base',  // OVERRIDE
  }, 120_000);
  
  if (!result.ok) {
    console.error('✗ Override failed:', result.error);
    process.exit(1);
  }
  
  console.log('✓ Override works:');
  console.log('  Transcript:', result.text);
  console.log('  (base model was used instead of default large-v3-turbo)');
  process.exit(0);
})();
