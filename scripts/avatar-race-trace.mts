// scripts/avatar-race-trace.mts
//
// Directive: Avatar Switch/Dispose Race — Step 1b runtime trace.
//
// Runs three real scenarios against the live app + server, captures every
// [RACE-TRACE] console log with timestamps, and prints the raw ordered
// sequence for each scenario.
//
// Scenarios:
//   A: Slow switch A→B (wait for full load each time)
//   B: Rapid switch A→B→C (click before each finishes loading)
//   C: Upload flow → handleAvatarUploaded (auto-select after upload)

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
  // The picker button is in top-right, shows the current avatar name + a ChevronDown icon
  // It contains a <User> icon + the avatar name + a <ChevronDown> icon
  // Find the button that contains the User icon (lucide-user)
  const pickerBtn = page.locator('button:has(svg.lucide-user)').first();
  try {
    await pickerBtn.click({ timeout: 3000 });
    await page.waitForTimeout(500);
  } catch {
    return false;
  }

  // Now the picker is open. Find the button with the avatar name text.
  // The avatar list items are <button> elements containing the avatar name.
  // Use getByText to find the right one, then click the parent button.
  try {
    // The name appears in a <span> inside the button. Use text= selector.
    const avatarBtn = page.locator(`button:has(span:has-text("${avatarName}"))`).first();
    await avatarBtn.click({ timeout });
    return true;
  } catch {
    // Fallback: try just text=
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
  console.log('Avatar Switch/Dispose Race — Runtime Trace');
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
  // SCENARIO A: Slow switch A→B (wait for load)
  // ════════════════════════════════════════════════════════════════════
  console.log('═══ SCENARIO A: Slow switch A→B (wait for load) ═══');
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

    console.log('  Switching to Hatsune Miku (slow)...');
    const ok = await openPickerAndClickAvatar(page, 'Hatsune Miku');
    console.log(`  ${ok ? '✓' : '✗'} Clicked Hatsune Miku`);
    await page.waitForTimeout(8000);

    console.log('\n── SCENARIO A: Raw log output (ordered by timestamp) ──');
    for (const log of logs) {
      console.log(`  [${log.time.toFixed(1)}ms] ${log.text}`);
    }

    await page.close();
  }
  console.log('');

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

    // Rapid: click B, then C, then back to A — with only 500ms between clicks
    // (don't wait for loads to finish)
    console.log('  Rapid: Miku → Yinlin → Marionette (500ms gaps)...');
    for (const name of ['Hatsune Miku', 'Yinlin', 'Marionette']) {
      const ok = await openPickerAndClickAvatar(page, name, 3000);
      console.log(`  ${ok ? '✓' : '✗'} Clicked ${name}`);
      await page.waitForTimeout(500);
    }

    console.log('  Waiting 12s for settle...');
    await page.waitForTimeout(12000);

    console.log('\n── SCENARIO B: Raw log output (ordered by timestamp) ──');
    for (const log of logs) {
      console.log(`  [${log.time.toFixed(1)}ms] ${log.text}`);
    }

    await page.close();
  }
  console.log('');

  // ════════════════════════════════════════════════════════════════════
  // SCENARIO C: Upload flow → handleAvatarUploaded
  // ════════════════════════════════════════════════════════════════════
  console.log('═══ SCENARIO C: Upload flow → handleAvatarUploaded ═══');
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

    // Open the avatar picker first (upload button is inside the picker)
    console.log('  Opening avatar picker...');
    const pickerBtn = page.locator('button:has(svg.lucide-user)').first();
    await pickerBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1000);

    // Find the upload button — it has an Upload icon (lucide-upload) + "Upload" text
    console.log('  Clicking Upload button...');
    const uploadBtn = page.locator('button:has(svg.lucide-upload)').first();
    try {
      await uploadBtn.click({ timeout: 5000 });
      console.log('  ✓ Clicked Upload button');
    } catch {
      console.log('  ✗ Could not find Upload button');
    }
    await page.waitForTimeout(2000);

    // The upload dialog should now be open. Find the file input.
    // Set the file directly on the input element.
    const defaultVrmPath = '/home/z/my-project/app/public/models/avatars/default/model.vrm';
    console.log(`  Setting file input to ${defaultVrmPath}...`);
    const fileInput = page.locator('input[type="file"]').first();
    try {
      await fileInput.setInputFiles(defaultVrmPath);
      console.log('  ✓ Set input file');
    } catch {
      console.log('  ✗ Could not set input file');
    }

    // Wait for upload + auto-select to complete
    console.log('  Waiting 15s for upload + auto-select...');
    await page.waitForTimeout(15000);

    console.log('\n── SCENARIO C: Raw log output (ordered by timestamp) ──');
    for (const log of logs) {
      console.log(`  [${log.time.toFixed(1)}ms] ${log.text}`);
    }

    await page.close();
  }

  await browser.close();
  console.log('\n═'.repeat(72));
  console.log('Trace complete.');
  console.log('═'.repeat(72));
}

main().catch(err => { console.error(err); process.exit(1); });
