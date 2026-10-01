import { sidecarInstaller } from '../src/sidecars/installer.js';

async function main() {
  const start = Date.now();
  sidecarInstaller.on('progress:kokoro', (p: any) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`[${elapsed}s] ${p.percent}% — ${p.label}${p.detail ? ` (${p.detail})` : ''}`);
  });
  await sidecarInstaller.install('kokoro');
  console.log(`Kokoro installed in ${((Date.now() - start) / 1000).toFixed(0)}s`);
}
main();
