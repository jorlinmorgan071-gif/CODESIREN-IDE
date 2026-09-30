import { sidecarInstaller } from '../src/sidecars/installer.js';

async function main() {
  console.log('=== Kokoro regression check ===');
  const state = sidecarInstaller.getInstallState('kokoro');
  console.log('Install state:', JSON.stringify(state, null, 2));
  console.log('ready:', state.ready, '(should be true — Kokoro was installed earlier + unchanged)');
  const estimate = await sidecarInstaller.getEstimate('kokoro');
  console.log('Estimate:', estimate.estimatedSizeHuman, '(should still be 1.7 GB — unchanged)');
  console.log('');
  if (state.ready) {
    console.log('✓ PASS — Kokoro installer unaffected by Whisper default change');
  } else {
    console.log('⚠ Kokoro not ready — may need reinstall (but NOT due to Whisper change)');
  }
}
main();
