// scripts/avatar-upload-blackscreen-repro.mts
//
// Reproduces the upload-triggered black screen. Captures all console output
// including [TIMING-TRACE] logs from FaceView.tsx.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';
const MIKU_VRM = '/home/z/my-project/app/public/models/avatars/hatsune-miku/model.vrm';

async function main() {
  console.log('═'.repeat(72));
  console.log('Avatar Upload Timing Trace — Step 2 verification');
  console.log('═'.repeat(72));

  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const allLogs: Array<{ type: string; text: string; time: number }> = [];
  page.on('console', (msg: any) => {
    allLogs.push({ type: msg.type(), text: msg.text(), time: Date.now() });
  });

  const pageErrors: Array<{ message: string; time: number }> = [];
  page.on('pageerror', (err: any) => {
    pageErrors.push({ message: err.message, time: Date.now() });
  });

  console.log('Loading /face...');
  await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  console.log('Opening picker + clicking Upload...');
  await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  await page.locator('button:has(svg.lucide-upload)').first().click({ timeout: 5000 });
  await page.waitForTimeout(2000);

  console.log('Setting file input (miku.vrm)...');
  await page.locator('input[type="file"]').first().setInputFiles(MIKU_VRM);
  console.log('  ✓ File set');

  console.log('Waiting 35s (15s+ post-upload observation), polling every 5s...');
  for (let i = 1; i <= 7; i++) {
    await page.waitForTimeout(5000);
    try {
      const state = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        return { w: c?.width ?? 0, h: c?.height ?? 0 };
      });
      console.log(`  [${i*5}s] canvas=${state.w}x${state.h}`);
    } catch {
      console.log(`  [${i*5}s] EVALUATE TIMEOUT — page frozen`);
    }
  }

  console.log('\n' + '═'.repeat(72));
  console.log('FULL CONSOLE OUTPUT (TIMING-TRACE + face + errors)');
  console.log('═'.repeat(72));
  for (const log of allLogs) {
    if (log.text.includes('PREVIEW-TRACE') || log.text.includes('STEP4-TRACE') || log.text.includes('[face]') || log.text.includes('Context Lost') || log.text.includes('R3F') || log.type === 'error') {
      const t = new Date(log.time).toISOString().slice(11, 23);
      console.log(`  [${t}] [${log.type.toUpperCase()}] ${log.text}`);
    }
  }

  console.log('\n' + '═'.repeat(72));
  console.log('PAGE ERRORS (uncaught)');
  console.log('═'.repeat(72));
  for (const err of pageErrors) {
    const t = new Date(err.time).toISOString().slice(11, 23);
    console.log(`  [${t}] ${err.message}`);
  }
  if (pageErrors.length === 0) console.log('  (none)');

  console.log('\n' + '═'.repeat(72));
  console.log('SUMMARY');
  console.log('═'.repeat(72));
  const contextLost = allLogs.some(l => l.text.includes('Context Lost'));
  console.log(`  WebGL Context Lost: ${contextLost}`);
  console.log(`  Page errors: ${pageErrors.length}`);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
