// scripts/gravity-motion-timing.mts
//
// Measures actual spring bone motion timing by capturing screenshots at
// intervals after avatar load and comparing pixel changes. The breathing
// sway (built into useFrame) provides continuous motion that exercises
// the spring bones. We measure how long after load the hair stops moving
// (settles to steady state).
//
// Tests Marionette FIRST (highest risk — 711 zero-G joints get 1.0
// vs 3104 existing at 0.02), then Default, Miku, Yinlin.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';

const AVATARS = [
  { name: 'Marionette', selectText: 'Marionette', file: 'marionette' },
  { name: 'Default', selectText: 'Default Avatar', file: 'default' },
  { name: 'Hatsune Miku', selectText: 'Hatsune Miku', file: 'hatsune-miku' },
  { name: 'Yinlin', selectText: 'Yinlin', file: 'yinlin' },
];

async function main() {
  console.log('═'.repeat(72));
  console.log('Gravity Motion Timing — Marionette first');
  console.log('═'.repeat(72));

  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const consoleLogs: string[] = [];
  page.on('console', (msg: any) => {
    const text = msg.text();
    if (text.includes('VRM loaded') || text.includes('Context Lost') || text.includes('R3F') || text.includes('error') || text.includes('Error')) {
      consoleLogs.push(text);
    }
  });
  page.on('pageerror', (err: any) => consoleLogs.push(`[PAGE-ERROR] ${err.message}`));

  console.log('Loading /face...');
  await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000); // Wait for initial model

  for (const avatar of AVATARS) {
    console.log(`\n── ${avatar.name} ──`);

    // Select avatar
    await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    try {
      await page.click(`text=${avatar.selectText}`, { timeout: 5000 });
    } catch {
      console.log(`  ✗ Could not select ${avatar.name}`);
      continue;
    }
    console.log(`  ✓ Selected ${avatar.name}`);

    // Wait for model to load (VRM loaded log)
    await page.waitForTimeout(3000);

    // Now capture screenshots at intervals to measure motion
    // The breathing animation provides continuous sway → spring bones respond
    // We capture at 1s, 2s, 3s, 5s, 8s, 12s after load and compare pixels
    const screenshots: { time: number; path: string; size: number }[] = [];
    const intervals = [1, 2, 3, 5, 8, 12];

    for (const seconds of intervals) {
      // Wait until this timestamp
      const totalWait = (seconds - (intervals[intervals.indexOf(seconds) - 1] || 0)) * 1000;
      await page.waitForTimeout(totalWait);

      const path = `/home/z/my-project/download/gravity-${avatar.file}-${seconds}s.png`;
      try {
        await page.screenshot({ path, timeout: 15000 });
        const size = require('fs').statSync(path)?.size || 0;
        screenshots.push({ time: seconds, path, size });
        console.log(`  [${seconds}s] screenshot ${size} bytes`);
      } catch {
        console.log(`  [${seconds}s] screenshot FAILED (timeout)`);
        screenshots.push({ time: seconds, path: '', size: 0 });
      }
    }

    // Compare consecutive screenshots to detect motion
    // If two consecutive screenshots have very similar file sizes, motion has settled
    console.log(`  Motion analysis (file size delta):`);
    for (let i = 1; i < screenshots.length; i++) {
      const delta = Math.abs(screenshots[i].size - screenshots[i-1].size);
      const pct = ((delta / screenshots[i-1].size) * 100).toFixed(1);
      console.log(`    ${screenshots[i-1].time}s→${screenshots[i].time}s: delta=${delta} bytes (${pct}%)`);
    }

    // Also capture the VRM loaded log timestamp
    const vrmLog = consoleLogs.filter(l => l.includes('VRM loaded')).slice(-1)[0];
    if (vrmLog) console.log(`  VRM loaded log: ${vrmLog.slice(0, 80)}`);

    // Check canvas alive
    const canvas = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return { w: c?.width ?? 0, h: c?.height ?? 0 };
    }).catch(() => ({ w: 0, h: 0 }));
    console.log(`  Canvas: ${canvas.w}x${canvas.h}`);

    // Close picker
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }

  // Summary
  const contextLost = consoleLogs.some(l => l.includes('Context Lost'));
  const r3fErrors = consoleLogs.filter(l => l.includes('R3F') || l.includes('PAGE-ERROR'));
  console.log('\n── Summary ──');
  console.log(`  WebGL Context Lost: ${contextLost ? 'YES ❌' : 'NO ✅'}`);
  console.log(`  R3F/Page errors: ${r3fErrors.length}`);
  console.log(`\n  Screenshots saved to /home/z/my-project/download/gravity-*.png`);
  console.log(`  Compare consecutive screenshots — small delta = motion settled`);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
