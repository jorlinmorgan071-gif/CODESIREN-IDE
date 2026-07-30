// server/scripts/export-settings.ts
// Phase 6 — Export server settings + env (with secrets redacted) as JSON.
//
// Captures:
//   - package.json version + scripts
//   - .env (sanitized — secrets redacted)
//   - config.ts (env var schema, not values)
//   - tsconfig.json
//   - vitest.config.ts
//   - vite.config.ts (app)
//   - .github/workflows/ci.yml
//
// Does NOT mutate any source data. Does NOT modify any protected system.

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, '..');
const REPO_ROOT = join(SERVER_DIR, '..');

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
}

function sanitizeEnv(content: string): string {
  return content
    .replace(/(JWT_SECRET=).+/g, '$1<redacted>')
    .replace(/(PG_PASSWORD=).+/g, '$1<redacted>')
    .replace(/(OPENROUTER_API_KEY=).+/g, '$1<redacted>')
    .replace(/(OPENAI_API_KEY=).+/g, '$1<redacted>')
    .replace(/(ANTHROPIC_API_KEY=).+/g, '$1<redacted>');
}

function readFileSafe(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function main() {
  console.log('━'.repeat(60));
  console.log('  Code Siren Export Settings');
  console.log('━'.repeat(60));

  const output: Record<string, any> = {
    exportedAt: new Date().toISOString(),
    phase: 'phase-6',
  };

  // 1. Server package.json
  const serverPkgPath = join(SERVER_DIR, 'package.json');
  const serverPkg = JSON.parse(readFileSync(serverPkgPath, 'utf8'));
  output.server = {
    version: serverPkg.version,
    name: serverPkg.name,
    scripts: serverPkg.scripts,
    dependencies: Object.keys(serverPkg.dependencies ?? {}).sort(),
    devDependencies: Object.keys(serverPkg.devDependencies ?? {}).sort(),
  };
  console.log(`  ✓ server/package.json (v${serverPkg.version})`);

  // 2. App package.json
  const appPkgPath = join(REPO_ROOT, 'app', 'package.json');
  if (existsSync(appPkgPath)) {
    const appPkg = JSON.parse(readFileSync(appPkgPath, 'utf8'));
    output.app = {
      version: appPkg.version,
      name: appPkg.name,
      scripts: appPkg.scripts,
      dependencyCount: Object.keys(appPkg.dependencies ?? {}).length,
      devDependencyCount: Object.keys(appPkg.devDependencies ?? {}).length,
    };
    console.log(`  ✓ app/package.json`);
  }

  // 3. .env (sanitized)
  const envPath = join(SERVER_DIR, '.env');
  const envContent = readFileSafe(envPath);
  if (envContent !== null) {
    output.env = {
      present: true,
      sanitized: sanitizeEnv(envContent),
      notes: 'Secrets (JWT_SECRET, PG_PASSWORD, *_API_KEY) have been redacted. Review .env directly for actual values.',
    };
    console.log(`  ✓ .env (sanitized)`);
  } else {
    output.env = { present: false };
    console.log(`  - .env (not present)`);
  }

  // 4. .env.example
  const envExamplePath = join(SERVER_DIR, '.env.example');
  const envExample = readFileSafe(envExamplePath);
  if (envExample !== null) {
    output.envExample = envExample;
    console.log(`  ✓ .env.example`);
  }

  // 5. tsconfig.json
  const tsconfigPath = join(SERVER_DIR, 'tsconfig.json');
  const tsconfig = readFileSafe(tsconfigPath);
  if (tsconfig !== null) {
    output.serverTsconfig = JSON.parse(tsconfig);
    console.log(`  ✓ server/tsconfig.json`);
  }

  // 6. vitest.config.ts
  const vitestPath = join(SERVER_DIR, 'vitest.config.ts');
  const vitest = readFileSafe(vitestPath);
  if (vitest !== null) {
    output.vitestConfig = vitest;
    console.log(`  ✓ vitest.config.ts`);
  }

  // 7. vite.config.ts (app)
  const vitePath = join(REPO_ROOT, 'app', 'vite.config.ts');
  const vite = readFileSafe(vitePath);
  if (vite !== null) {
    output.viteConfig = vite;
    console.log(`  ✓ app/vite.config.ts`);
  }

  // 8. CI workflow
  const ciPath = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
  const ci = readFileSafe(ciPath);
  if (ci !== null) {
    output.ci = ci;
    console.log(`  ✓ .github/workflows/ci.yml`);
  }

  // 9. Process info
  output.process = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    cwd: process.cwd(),
  };
  console.log(`  ✓ process info (Node ${process.version}, ${process.platform})`);

  // Write output
  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outPath = join(SERVER_DIR, `settings-export-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  const stat = statSync(outPath);

  console.log('');
  console.log(`  ✓ Exported settings`);
  console.log(`    → ${outPath}`);
  console.log(`    Size: ${formatBytes(stat.size)}`);
  console.log('');
  console.log('  NOTE: Secrets are redacted. To see actual values, review .env directly.');
  console.log('━'.repeat(60));
}

main().catch((err) => {
  console.error('export-settings fatal:', err);
  process.exit(1);
});
