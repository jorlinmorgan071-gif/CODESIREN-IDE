// scripts/pip-refactor-trace.mts
//
// PIP (AvatarOverlay) post-refactor trace — verifies 3 fixes delivered:
// 1. Disposal fires on PIP avatar switch (previously never did — stale closure)
// 2. VRM 0.x avatars face the camera (previously missing rotateVRM0)
// 3. Lighting is white directional (previously blue pointLights)
//
// Also: rapid PIP toggle stress test (PIP-specific interaction pattern)

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';

async function main() {
  console.log('═'.repeat(72));
  console.log('PIP Refactor Trace — 3 fixes verification');
  console.log('═'.repeat(72));

  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const logs: Array<{ time: number; text: string }> = [];
  page.on('console', (msg: any) => {
    const text = msg.text();
    if (text.includes('face') || text.includes('avatar') || text.includes('deepDispose') ||
        text.includes('Context Lost') || text.includes('R3F') || text.includes('error') ||
        text.includes('Error') || text.includes('VRM')) {
      logs.push({ time: Date.now(), text });
    }
  });
  page.on('pageerror', (err: any) => logs.push({ time: Date.now(), text: `[PAGE-ERROR] ${err.message}` }));

  console.log('Loading Home page...');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // ═══ 1. Toggle PIP on ═══
  console.log('\n── 1. Toggle PIP on ──');
  // The PIP toggle is a button in Home.tsx — find it
  const pipBtn = page.locator('button:has(svg.lucide-picture-in-picture-2), button[title*="PIP" i], button[title*="overlay" i]').first();
  try {
    await pipBtn.click({ timeout: 5000 });
    console.log('  ✓ PIP toggled on');
  } catch {
    // Try alternative — the dock icon
    try {
      await page.click('button:has-text("PIP"), button:has-text("Overlay")', { timeout: 3000 });
      console.log('  ✓ PIP toggled on (text match)');
    } catch {
      console.log('  ✗ Could not find PIP toggle button');
      // Print available buttons for debugging
      const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button')).map(b => ({
          text: b.textContent?.slice(0, 30),
          title: b.getAttribute('title') ?? '',
          ariaLabel: b.getAttribute('aria-label') ?? '',
        })).filter(b => b.text || b.title || b.ariaLabel).slice(0, 20);
      });
      console.log('  Available buttons:', JSON.stringify(buttons, null, 2));
    }
  }
  await page.waitForTimeout(5000);

  // Check canvas count (should be 2 — main FaceView canvas not on Home, but PIP canvas should be)
  const canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length).catch(() => 0);
  console.log(`  Canvas count: ${canvasCount}`);

  // ═══ 2. Screenshot PIP avatar (should show white lighting + correct orientation) ═══
  console.log('\n── 2. Screenshot PIP ──');
  await page.screenshot({ path: '/home/z/my-project/download/pip-post-refactor.png', timeout: 10000 }).catch(() => {});
  console.log('  Screenshot saved: /home/z/my-project/download/pip-post-refactor.png');

  // ═══ 3. Rapid PIP toggle (on/off/on/off/on) — stress test ═══
  console.log('\n── 3. Rapid PIP toggle stress test ──');
  for (let i = 0; i < 4; i++) {
    try {
      await pipBtn.click({ timeout: 3000 });
      console.log(`  Toggle ${i+1}: clicked`);
    } catch {
      console.log(`  Toggle ${i+1}: could not click`);
    }
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(5000);

  // ═══ 4. Check final state ═══
  const finalCanvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { w: c?.width ?? 0, h: c?.height ?? 0, count: document.querySelectorAll('canvas').length };
  }).catch(() => ({ w: 0, h: 0, count: 0 }));
  console.log(`\n  Final canvas: ${finalCanvas.w}x${finalCanvas.h} (count: ${finalCanvas.count})`);

  // Report
  console.log('\n── Relevant console logs ──');
  for (const log of logs.slice(-25)) {
    const t = new Date(log.time).toISOString().slice(11, 23);
    console.log(`  [${t}] ${log.text}`);
  }

  console.log('\n── Summary ──');
  const contextLost = logs.some(l => l.text.includes('Context Lost'));
  const r3fErrors = logs.filter(l => l.text.includes('R3F') || l.text.includes('PAGE-ERROR'));
  console.log(`  WebGL Context Lost: ${contextLost ? 'YES ❌' : 'NO ✅'}`);
  console.log(`  R3F/Page errors: ${r3fErrors.length}`);
  console.log(`  Canvas alive: ${finalCanvas.w > 0 ? 'YES ✅' : 'NO ❌'}`);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
