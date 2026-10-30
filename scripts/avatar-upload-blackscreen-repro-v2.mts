// scripts/avatar-upload-blackscreen-repro-v2.mts
//
// V2: More resilient — uses shorter screenshot timeouts, captures console
// logs continuously, and doesn't let a screenshot timeout abort the whole
// script. The goal is to capture the FULL console output during the upload
// sequence even if the page becomes unresponsive.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';
const MIKU_VRM = '/home/z/my-project/app/public/models/avatars/hatsune-miku/model.vrm';

async function main() {
  console.log('═'.repeat(72));
  console.log('Avatar Upload Black Screen — Step 1 Reproduction (V2)');
  console.log('═'.repeat(72));
  console.log('');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-accelerated-2d-canvas',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const allConsoleLogs: Array<{ type: string; text: string; time: number }> = [];
  page.on('console', (msg: any) => {
    allConsoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      time: Date.now(),
    });
  });

  const pageErrors: Array<{ message: string; time: number }> = [];
  page.on('pageerror', (err: any) => {
    pageErrors.push({ message: err.message, time: Date.now() });
  });

  console.log('Step 1: Load /face...');
  await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  console.log('Step 2: Open picker + click Upload...');
  await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  await page.locator('button:has(svg.lucide-upload)').first().click({ timeout: 5000 });
  await page.waitForTimeout(2000);

  console.log('Step 3: Set file input (uploading miku.vrm)...');
  await page.locator('input[type="file"]').first().setInputFiles(MIKU_VRM);
  console.log('  ✓ File set');

  console.log('\nStep 4: Wait 25s, polling every 5s for responsiveness...');
  for (let i = 1; i <= 5; i++) {
    await page.waitForTimeout(5000);

    // Try a quick screenshot with short timeout
    try {
      await page.screenshot({
        path: `/tmp/upload-repro-v2-${i*5}s.png`,
        timeout: 8000,
      });
      console.log(`  [${i*5}s] screenshot captured`);
    } catch (err: any) {
      console.log(`  [${i*5}s] SCREENSHOT TIMEOUT — page likely frozen: ${err.message.slice(0, 80)}`);
    }

    // Check responsiveness via evaluate (short timeout)
    try {
      const state = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const body = document.body;
        return {
          canvasExists: !!canvas,
          canvasW: canvas?.width ?? 0,
          canvasH: canvas?.height ?? 0,
          bodyChildCount: body?.childElementCount ?? 0,
          hasErrorText: !!document.querySelector('[style*="siren-red"]'),
          url: window.location.href,
        };
      });
      console.log(`  [${i*5}s] state: canvas=${state.canvasW}x${state.canvasH} body children=${state.bodyChildCount} errorVisible=${state.hasErrorText} url=${state.url.slice(-30)}`);
    } catch (err: any) {
      console.log(`  [${i*5}s] EVALUATE TIMEOUT — page is frozen: ${err.message.slice(0, 80)}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(72));
  console.log('FULL CONSOLE OUTPUT (all types, chronological, unedited)');
  console.log('═'.repeat(72));
  for (const log of allConsoleLogs) {
    const timeStr = new Date(log.time).toISOString().slice(11, 23);
    console.log(`  [${timeStr}] [${log.type.toUpperCase()}] ${log.text}`);
  }

  console.log('\n' + '═'.repeat(72));
  console.log('PAGE ERRORS (uncaught exceptions)');
  console.log('═'.repeat(72));
  if (pageErrors.length === 0) {
    console.log('  (none)');
  } else {
    for (const err of pageErrors) {
      const timeStr = new Date(err.time).toISOString().slice(11, 23);
      console.log(`  [${timeStr}] ${err.message}`);
    }
  }

  console.log('\n' + '═'.repeat(72));
  console.log('SUMMARY');
  console.log('═'.repeat(72));
  console.log(`  Total console logs: ${allConsoleLogs.length}`);
  console.log(`  Error logs: ${allConsoleLogs.filter(l => l.type === 'error').length}`);
  console.log(`  Warning logs: ${allConsoleLogs.filter(l => l.type === 'warning').length}`);
  console.log(`  Page errors (uncaught): ${pageErrors.length}`);

  await browser.close();
}

main().catch(err => { console.error('SCRIPT CRASHED:', err); process.exit(1); });
