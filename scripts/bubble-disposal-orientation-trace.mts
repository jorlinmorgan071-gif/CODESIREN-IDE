// scripts/bubble-disposal-orientation-trace.mts
//
// InteractionBubble — disposal + orientation verification:
// 1. Open bubble
// 2. Switch avatar (Default → Hatsune Miku — a VRM 0.x model)
// 3. Capture [HOOK-TRACE] logs — confirm willDispose=true fires
// 4. Screenshot the bubble with Miku (VRM 0.x) — confirm facing camera
// 5. Switch back to Default — confirm disposal fires again

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';

async function main() {
  console.log('═'.repeat(72));
  console.log('Bubble Disposal + Orientation Trace');
  console.log('═'.repeat(72));

  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const logs: Array<{ time: number; text: string }> = [];
  page.on('console', (msg: any) => {
    const text = msg.text();
    if (text.includes('HOOK-TRACE') || text.includes('[face]') || text.includes('Context Lost') || text.includes('R3F') || text.includes('PAGE-ERROR')) {
      logs.push({ time: Date.now(), text });
    }
  });
  page.on('pageerror', (err: any) => logs.push({ time: Date.now(), text: `[PAGE-ERROR] ${err.message}` }));

  console.log('Loading Home page...');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // ═══ 1. Open the bubble ═══
  console.log('\n── 1. Open InteractionBubble ──');
  // Find the bubble toggle button — it's in the dock or has a MessageSquare icon
  const bubbleBtn = page.locator('button:has(svg.lucide-message-square)').first();
  try {
    await bubbleBtn.click({ timeout: 5000 });
    console.log('  ✓ Bubble opened');
  } catch {
    // Try other approaches
    try {
      // The dock has chat icon
      await page.locator('.dock-glass button').first().click({ timeout: 3000 });
      console.log('  ✓ Bubble opened (dock)');
    } catch {
      console.log('  ✗ Could not open bubble');
    }
  }
  await page.waitForTimeout(8000);

  // Screenshot initial state (Default avatar in bubble)
  await page.screenshot({ path: '/home/z/my-project/download/bubble-1-default.png', timeout: 10000 }).catch(() => {});
  console.log('  Screenshot 1: bubble-1-default.png');

  // ═══ 2. Switch to Hatsune Miku (VRM 0.x) via FaceView ═══
  // The bubble reads avatarUrl from the same settings as FaceView.
  // We need to navigate to /face, switch avatar, then come back.
  console.log('\n── 2. Navigate to /face + switch to Hatsune Miku ──');
  await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // Open picker + select Hatsune Miku
  await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
  await page.waitForTimeout(2000);
  try {
    await page.click('text=Hatsune Miku', { timeout: 5000 });
    console.log('  ✓ Selected Hatsune Miku');
  } catch {
    console.log('  ✗ Could not select Hatsune Miku');
  }
  await page.waitForTimeout(8000);

  // Screenshot Miku in FaceView (for comparison)
  await page.screenshot({ path: '/home/z/my-project/download/bubble-2-faceview-miku.png', timeout: 10000 }).catch(() => {});
  console.log('  Screenshot 2: bubble-2-faceview-miku.png');

  // ═══ 3. Navigate back to Home — bubble should now show Miku ═══
  console.log('\n── 3. Navigate back to Home (bubble should show Miku) ──');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // Open bubble again
  try {
    await bubbleBtn.click({ timeout: 5000 });
    console.log('  ✓ Bubble re-opened');
  } catch {
    console.log('  ✗ Could not re-open bubble');
  }
  await page.waitForTimeout(8000);

  // Screenshot Miku in bubble
  await page.screenshot({ path: '/home/z/my-project/download/bubble-3-miku-in-bubble.png', timeout: 10000 }).catch(() => {});
  console.log('  Screenshot 3: bubble-3-miku-in-bubble.png');

  // ═══ 4. Switch back to Default via /face ═══
  console.log('\n── 4. Switch back to Default ──');
  await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
  await page.waitForTimeout(2000);
  try {
    await page.click('text=Default Avatar', { timeout: 5000 });
    console.log('  ✓ Selected Default Avatar');
  } catch {
    try {
      await page.click('text=Default', { timeout: 5000 });
      console.log('  ✓ Selected Default');
    } catch {
      console.log('  ✗ Could not select Default');
    }
  }
  await page.waitForTimeout(8000);

  // ═══ 5. Report ═══
  console.log('\n── Raw HOOK-TRACE + face logs ──');
  for (const log of logs) {
    const t = new Date(log.time).toISOString().slice(11, 23);
    console.log(`  [${t}] ${log.text}`);
  }

  // Summary
  const disposalLogs = logs.filter(l => l.text.includes('HOOK-TRACE'));
  const willDisposeTrue = logs.filter(l => l.text.includes('willDispose=true'));
  const deepDisposeDone = logs.filter(l => l.text.includes('deepDispose DONE'));
  const contextLost = logs.some(l => l.text.includes('Context Lost'));
  const r3fErrors = logs.filter(l => l.text.includes('R3F') || l.text.includes('PAGE-ERROR'));

  console.log('\n── Summary ──');
  console.log(`  Total HOOK-TRACE logs: ${disposalLogs.length}`);
  console.log(`  willDispose=true occurrences: ${willDisposeTrue.length}`);
  for (const l of willDisposeTrue) console.log(`    ${l.text}`);
  console.log(`  deepDispose DONE occurrences: ${deepDisposeDone.length}`);
  for (const l of deepDisposeDone) console.log(`    ${l.text}`);
  console.log(`  WebGL Context Lost: ${contextLost ? 'YES ❌' : 'NO ✅'}`);
  console.log(`  R3F/Page errors: ${r3fErrors.length}`);

  console.log('\n  Screenshots saved:');
  console.log('    /home/z/my-project/download/bubble-1-default.png (Default in bubble)');
  console.log('    /home/z/my-project/download/bubble-2-faceview-miku.png (Miku in FaceView)');
  console.log('    /home/z/my-project/download/bubble-3-miku-in-bubble.png (Miku in bubble)');

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
