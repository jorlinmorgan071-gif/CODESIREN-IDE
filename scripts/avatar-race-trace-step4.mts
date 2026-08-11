// scripts/avatar-race-trace-step4.mts
//
// Step 4 verification for the avatar disposal closure fix.
//
// Scenarios:
//   B: Rapid switch A→B→C (no wait) — confirm willDispose=true now (was false)
//   C: Upload flow → handleAvatarUploaded — forced URL change via custom avatar
//   D: Stability — after upload, switch back to default (one more switch)
//
// All scenarios capture [RACE-TRACE] logs with timestamps.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';

interface LogEntry {
  time: number;
  type: string;
  text: string;
}

async function openPickerAndClickAvatar(page: any, avatarName: string, timeout = 5000): Promise<boolean> {
  const pickerBtn = page.locator('button:has(svg.lucide-user)').first();
  try {
    await pickerBtn.click({ timeout: 3000 });
    await page.waitForTimeout(500);
  } catch {
    return false;
  }
  try {
    const avatarBtn = page.locator(`button:has(span:has-text("${avatarName}"))`).first();
    await avatarBtn.click({ timeout });
    return true;
  } catch {
    try {
      await page.click(`text="${avatarName}"`, { timeout });
      return true;
    } catch {
      return false;
    }
  }
}

async function main() {
  console.log('═'.repeat(72));
  console.log('Avatar Disposal Fix — Step 4 Verification');
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

  // ════════════════════════════════════════════════════════════════════
  // SCENARIO B: Rapid switch A→B→C (no wait between)
  // ════════════════════════════════════════════════════════════════════
  console.log('═══ SCENARIO B: Rapid switch A→B→C (no wait) ═══');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const logs: LogEntry[] = [];

    page.on('console', (msg: any) => {
      const text = msg.text();
      if (text.includes('[RACE-TRACE]') || text.includes('[face]')) {
        logs.push({ time: performance.now(), type: msg.type(), text });
      }
    });

    console.log('  Loading /face...');
    await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);

    console.log('  Rapid: Miku → Yinlin → Marionette (500ms gaps)...');
    for (const name of ['Hatsune Miku', 'Yinlin', 'Marionette']) {
      const ok = await openPickerAndClickAvatar(page, name, 3000);
      console.log(`  ${ok ? '✓' : '✗'} Clicked ${name}`);
      await page.waitForTimeout(500);
    }

    console.log('  Waiting 12s for settle...');
    await page.waitForTimeout(12000);

    console.log('\n── SCENARIO B: Raw log output ──');
    for (const log of logs) {
      console.log(`  [${log.time.toFixed(1)}ms] ${log.text}`);
    }

    // Summary: did disposal fire?
    const willDisposeTrue = logs.filter(l => l.text.includes('willDispose=true'));
    const deepDisposeDone = logs.filter(l => l.text.includes('deepDispose DONE'));
    const useLoaderClearDone = logs.filter(l => l.text.includes('useLoader.clear DONE'));
    console.log(`\n── SCENARIO B: Summary ──`);
    console.log(`  willDispose=true occurrences: ${willDisposeTrue.length}`);
    console.log(`  deepDispose DONE occurrences: ${deepDisposeDone.length}`);
    console.log(`  useLoader.clear DONE occurrences: ${useLoaderClearDone.length}`);

    await page.close();
  }
  console.log('');

  // ════════════════════════════════════════════════════════════════════
  // SCENARIO C: Upload flow → forced URL change via custom avatar
  // ════════════════════════════════════════════════════════════════════
  console.log('═══ SCENARIO C: Upload flow → forced URL change ═══');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const logs: LogEntry[] = [];

    page.on('console', (msg: any) => {
      const text = msg.text();
      if (text.includes('[RACE-TRACE]') || text.includes('[face]')) {
        logs.push({ time: performance.now(), type: msg.type(), text });
      }
    });

    console.log('  Loading /face...');
    await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);

    // First, select Default Avatar (so we start from a known state)
    console.log('  Selecting Default Avatar first (known starting state)...');
    await openPickerAndClickAvatar(page, 'Default Avatar');
    await page.waitForTimeout(5000);

    // Now open picker + click Upload
    console.log('  Opening picker + clicking Upload...');
    const pickerBtn = page.locator('button:has(svg.lucide-user)').first();
    await pickerBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1000);

    const uploadBtn = page.locator('button:has(svg.lucide-upload)').first();
    try {
      await uploadBtn.click({ timeout: 5000 });
      console.log('  ✓ Clicked Upload button');
    } catch {
      console.log('  ✗ Could not find Upload button');
    }
    await page.waitForTimeout(2000);

    // Set file input — use hatsune-miku.vrm (different from default) so the
    // custom avatar gets a genuinely different model
    const uploadVrmPath = '/home/z/my-project/app/public/models/avatars/hatsune-miku/model.vrm';
    console.log(`  Setting file input to ${uploadVrmPath}...`);
    const fileInput = page.locator('input[type="file"]').first();
    try {
      await fileInput.setInputFiles(uploadVrmPath);
      console.log('  ✓ Set input file');
    } catch {
      console.log('  ✗ Could not set input file');
    }

    // Wait for upload + auto-select to complete
    console.log('  Waiting 15s for upload + auto-select...');
    await page.waitForTimeout(15000);

    console.log('\n── SCENARIO C: Raw log output ──');
    for (const log of logs) {
      console.log(`  [${log.time.toFixed(1)}ms] ${log.text}`);
    }

    const willDisposeTrue = logs.filter(l => l.text.includes('willDispose=true'));
    const deepDisposeDone = logs.filter(l => l.text.includes('deepDispose DONE'));
    console.log(`\n── SCENARIO C: Summary ──`);
    console.log(`  willDispose=true occurrences: ${willDisposeTrue.length}`);
    console.log(`  deepDispose DONE occurrences: ${deepDisposeDone.length}`);

    // ════════════════════════════════════════════════════════════════════
    // SCENARIO D: Stability — switch back to Default after upload
    // (uses the SAME page so we can verify state continuity)
    // ════════════════════════════════════════════════════════════════════
    console.log('\n═══ SCENARIO D: Stability — custom → Default (after upload) ═══');
    console.log('  Clicking Default Avatar (switching back from custom)...');
    const ok = await openPickerAndClickAvatar(page, 'Default Avatar');
    console.log(`  ${ok ? '✓' : '✗'} Clicked Default Avatar`);
    await page.waitForTimeout(8000);

    // Capture logs from scenario D (filter by timestamp after scenario C ended)
    console.log('\n── SCENARIO D: Raw log output (this scenario only) ──');
    // Get the last 25 logs (scenario D's logs)
    const recentLogs = logs.slice(-25);
    for (const log of recentLogs) {
      console.log(`  [${log.time.toFixed(1)}ms] ${log.text}`);
    }

    const dWillDispose = recentLogs.filter(l => l.text.includes('willDispose=true'));
    const dDeepDispose = recentLogs.filter(l => l.text.includes('deepDispose DONE'));
    const dVrmLoaded = recentLogs.filter(l => l.text.includes('VRM loaded with'));
    console.log(`\n── SCENARIO D: Summary ──`);
    console.log(`  willDispose=true: ${dWillDispose.length}`);
    console.log(`  deepDispose DONE: ${dDeepDispose.length}`);
    console.log(`  VRM loaded (new model renders): ${dVrmLoaded.length}`);

    await page.close();
  }

  await browser.close();
  console.log('\n═'.repeat(72));
  console.log('Step 4 trace complete.');
  console.log('═'.repeat(72));
}

main().catch(err => { console.error(err); process.exit(1); });
