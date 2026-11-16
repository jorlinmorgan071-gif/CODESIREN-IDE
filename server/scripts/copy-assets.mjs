// server/scripts/copy-assets.mjs
//
// Post-build step: copies non-TypeScript assets that tsc leaves behind.
//
// tsc compiles src/**/*.ts → dist/src/**/*.js (rootDir="./" preserves the
// src/ prefix) but does NOT copy:
//   - src/db/migrations/*.sql   (loaded at runtime by db/migrate.ts via __dirname)
//   - src/skills/library/*.toml (loaded at boot by skills/library/index.ts via __dirname)
//
// Both loaders resolve paths with `dirname(fileURLToPath(import.meta.url))`,
// so the assets must sit next to the compiled .js files in dist/src/. Without
// this step, `npm run build` produces a dist/ that crashes on boot with
// "library directory not found" / "no migrations found".
//
// Run automatically as the `postbuild` step in the `build` npm script.
// Safe to re-run.

import { readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname); // server/

// rootDir="./" → compiled JS lives under dist/src/, so assets go there too.
const assetDirs = [
  { src: 'src/db/migrations', dest: 'dist/src/db/migrations', ext: '.sql' },
  { src: 'src/skills/library', dest: 'dist/src/skills/library', ext: '.toml' },
];

let copied = 0;
for (const { src, dest, ext } of assetDirs) {
  const srcAbs = join(root, src);
  const destAbs = join(root, dest);
  if (!existsSync(srcAbs)) {
    console.warn(`[copy-assets] source missing: ${src} (skipped)`);
    continue;
  }
  mkdirSync(destAbs, { recursive: true });
  const files = readdirSync(srcAbs).filter(f => f.endsWith(ext));
  for (const file of files) {
    copyFileSync(join(srcAbs, file), join(destAbs, file));
    copied += 1;
  }
  console.log(`[copy-assets] ${src} → ${dest} (${files.length} ${ext} files)`);
}
console.log(`[copy-assets] copied ${copied} asset files to dist/`);

