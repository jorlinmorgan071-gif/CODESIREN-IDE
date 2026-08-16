// scripts/pose-gravity-screenshots.mts
//
// Step 4: Pose correction + gravity fix verification
// 1. Test Marionette FIRST (0.02 existing gravity vs 0.5 new — check for issues)
// 2. Screenshot all 4 avatars in FaceView post-pose-correction
// 3. Check for WebGL context loss, R3F errors, canvas stability

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';

const AVATARS = [
  { name: 'Marionette', selectText: 'Marionette', file: 'marionette' },  // FIRST — highest risk
  { name: 'Default', selectText: 'Default Avatar', file: 'default' },
  { name: 'Hatsune Miku', selectText: 'Hatsune Miku', file: 'hatsune-miku' },
  { name: 'Yinlin', selectText: 'Yinlin', file: 'yinlin' },
];

async function main() {
  console.log('═'.repeat(72));
  console.log('Pose + Gravity Verification — Marionette first, then all 4');
  console.log('═'.repeat(72));

  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const logs: string[] = [];
  page.on('console', (msg: any) => {
    const text = msg.text();
    if (text.includes('Context Lost') || text.includes('R3F') || text.includes('error') || text.includes('Error') || text.includes('face')) {
      logs.push(text);
    }
  });
  page.on('pageerror', (err: any) => logs.push(`[PAGE-ERROR] ${err.message}`));

  console.log('Loading /face...');
  await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);

  for (const avatar of AVATARS) {
    console.log(`\n── ${avatar.name} ──`);

    // Open picker + select avatar
    await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    try {
      await page.click(`text=${avatar.selectText}`, { timeout: 5000 });
      console.log(`  ✓ Selected ${avatar.name}`);
    } catch {
      console.log(`  ✗ Could not select ${avatar.name}`);
    }

    // Wait for model to load
    await page.waitForTimeout(8000);

    // Screenshot
    const path = `/home/z/my-project/download/pose-${avatar.file}.png`;
    await page.screenshot({ path, timeout: 10000 }).catch(() => {});
    console.log(`  Screenshot: ${path}`);

    // Check canvas
    const canvas = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return { w: c?.width ?? 0, h: c?.height ?? 0 };
    }).catch(() => ({ w: 0, h: 0 }));
    console.log(`  Canvas: ${canvas.w}x${canvas.h}`);

    // Close picker for next iteration
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }

  // Summary
  const contextLost = logs.some(l => l.includes('Context Lost'));
  const r3fErrors = logs.filter(l => l.includes('R3F') || l.includes('PAGE-ERROR'));
  console.log('\n── Summary ──');
  console.log(`  WebGL Context Lost: ${contextLost ? 'YES ❌' : 'NO ✅'}`);
  console.log(`  R3F/Page errors: ${r3fErrors.length}`);
  console.log(`\n  Screenshots:`);
  for (const a of AVATARS) {
    console.log(`    /home/z/my-project/download/pose-${a.file}.png`);
  }

  // Print relevant logs
  if (logs.length > 0) {
    console.log('\n── Relevant logs ──');
    for (const l of logs.slice(-10)) console.log(`  ${l}`);
  }

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
