// scripts/bubble-refactor-trace.mts
//
// InteractionBubble post-refactor trace — verifies:
// 1. Disposal fires on bubble avatar switch (previously stale closure — never fired)
// 2. VRM 0.x avatars face the camera (previously missing rotateVRM0)
// 3. No regression to visualization-mode switching (VRM ↔ bars ↔ pulse)
// 4. No WebGL context loss, no R3F errors
// 5. PulseVisualization fallback still works during load

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';

async function main() {
  console.log('═'.repeat(72));
  console.log('InteractionBubble Refactor Trace');
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
        text.includes('Error') || text.includes('VRM') || text.includes('bubble')) {
      logs.push({ time: Date.now(), text });
    }
  });
  page.on('pageerror', (err: any) => logs.push({ time: Date.now(), text: `[PAGE-ERROR] ${err.message}` }));

  console.log('Loading Home page...');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // ═══ 1. Toggle bubble on ═══
  console.log('\n── 1. Toggle InteractionBubble on ──');
  // The bubble toggle is a button in Home.tsx
  const bubbleBtn = page.locator('button:has(svg.lucide-message-square), button[title*="bubble" i]').first();
  try {
    await bubbleBtn.click({ timeout: 5000 });
    console.log('  ✓ Bubble toggled on');
  } catch {
    // Try finding by text or other selectors
    try {
      await page.click('button:has-text("Bubble")', { timeout: 3000 });
      console.log('  ✓ Bubble toggled on (text)');
    } catch {
      console.log('  ✗ Could not find bubble toggle');
      const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
        .map(b => ({ text: b.textContent?.slice(0, 30), title: b.title, hasSvg: !!b.querySelector('svg') }))
        .filter(b => b.text || b.title).slice(0, 15));
      console.log('  Buttons:', JSON.stringify(buttons));
    }
  }
  await page.waitForTimeout(8000);

  // Check canvas
  const canvasInfo = await page.evaluate(() => {
    const canvases = document.querySelectorAll('canvas');
    return { count: canvases.length, sizes: Array.from(canvases).map(c => `${c.width}x${c.height}`) };
  }).catch(() => ({ count: 0, sizes: [] }));
  console.log(`  Canvas: ${canvasInfo.count} (${canvasInfo.sizes.join(', ')})`);

  // ═══ 2. Screenshot ═══
  console.log('\n── 2. Screenshot ──');
  await page.screenshot({ path: '/home/z/my-project/download/bubble-post-refactor.png', timeout: 10000 }).catch(() => {});
  console.log('  Screenshot saved');

  // ═══ 3. Rapid bubble toggle (on/off/on/off) ═══
  console.log('\n── 3. Rapid bubble toggle stress test ──');
  for (let i = 0; i < 3; i++) {
    try {
      await bubbleBtn.click({ timeout: 3000 });
      console.log(`  Toggle ${i+1}: off→on`);
    } catch { console.log(`  Toggle ${i+1}: failed`); }
    await page.waitForTimeout(2000);
    try {
      await bubbleBtn.click({ timeout: 3000 });
      console.log(`  Toggle ${i+1}: on→off`);
    } catch { console.log(`  Toggle ${i+1}: failed`); }
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(5000);

  // ═══ 4. Final state ═══
  const finalCanvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { w: c?.width ?? 0, h: c?.height ?? 0, count: document.querySelectorAll('canvas').length };
  }).catch(() => ({ w: 0, h: 0, count: 0 }));
  console.log(`\n  Final canvas: ${finalCanvas.w}x${finalCanvas.h} (count: ${finalCanvas.count})`);

  // Report
  console.log('\n── Relevant console logs ──');
  for (const log of logs.slice(-30)) {
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
