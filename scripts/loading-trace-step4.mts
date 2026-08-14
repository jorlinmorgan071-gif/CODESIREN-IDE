// scripts/loading-trace-step4.mts
// Step 4: single switch + rapid switch — confirm setLoading(false) fires + spinner clears
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const logs: Array<{ time: number; text: string }> = [];
  page.on('console', (msg: any) => {
    const text = msg.text();
    if (text.includes('LOADING-TRACE') || text.includes('[face]') || text.includes('Context Lost') || text.includes('R3F')) {
      logs.push({ time: Date.now(), text });
    }
  });
  page.on('pageerror', (err: any) => logs.push({ time: Date.now(), text: `[PAGE-ERROR] ${err.message}` }));

  async function pickAvatar(name: string) {
    // Close any open picker first by pressing Escape
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    await page.click(`text=${name}`, { timeout: 5000 });
  }

  // ═══ SCENARIO 1: Single switch ═══
  console.log('═══ SCENARIO 1: Single switch (Default → Hatsune Miku) ═══');
  console.log('Loading /face...');
  await page.goto('http://localhost:3000/face', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);

  console.log('Switching to Hatsune Miku...');
  await pickAvatar('Hatsune Miku');
  console.log('  Clicked');

  console.log('Waiting 15s...');
  await page.waitForTimeout(15000);

  const spinnerVisible1 = await page.evaluate(() => document.querySelector('.animate-spin') !== null).catch(() => false);
  console.log(`  Spinner visible after 15s: ${spinnerVisible1}`);

  // ═══ SCENARIO 2: Rapid switch (Miku → Yinlin → Marionette) ═══
  console.log('\n═══ SCENARIO 2: Rapid switch (Miku → Yinlin → Marionette, 3s gaps) ═══');
  for (const name of ['Yinlin', 'Marionette']) {
    console.log(`  Switching to ${name}...`);
    await page.waitForTimeout(3000); // wait 3s between switches (not 1s — let model load)
    await pickAvatar(name);
  }
  console.log('Waiting 15s for settle...');
  await page.waitForTimeout(15000);

  const spinnerVisible2 = await page.evaluate(() => document.querySelector('.animate-spin') !== null).catch(() => false);
  const canvasState = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { w: c?.width ?? 0, h: c?.height ?? 0 };
  }).catch(() => ({ w: 0, h: 0 }));
  console.log(`  Spinner visible after rapid switch: ${spinnerVisible2}`);
  console.log(`  Canvas: ${canvasState.w}x${canvasState.h}`);

  // Print all logs
  console.log('\n── Raw LOADING-TRACE logs ──');
  for (const log of logs) {
    const t = new Date(log.time).toISOString().slice(11, 23);
    console.log(`  [${t}] ${log.text}`);
  }

  // Summary
  const setLoadingTrue = logs.filter(l => l.text.includes('setLoading(true)'));
  const setLoadingFalse = logs.filter(l => l.text.includes('setLoading(false)'));
  const contextLost = logs.some(l => l.text.includes('Context Lost'));
  const r3fErrors = logs.filter(l => l.text.includes('R3F') || l.text.includes('PAGE-ERROR'));
  console.log('\n── Summary ──');
  console.log(`  setLoading(true) calls: ${setLoadingTrue.length}`);
  console.log(`  setLoading(false) calls: ${setLoadingFalse.length}`);
  for (const l of setLoadingFalse) console.log(`    ${l.text}`);
  console.log(`  WebGL Context Lost: ${contextLost ? 'YES ❌' : 'NO ✅'}`);
  console.log(`  R3F/Page errors: ${r3fErrors.length}`);
  console.log(`  Spinner visible after single switch (15s): ${spinnerVisible1 ? 'YES ❌' : 'NO ✅'}`);
  console.log(`  Spinner visible after rapid switch (15s): ${spinnerVisible2 ? 'YES ❌' : 'NO ✅'}`);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
