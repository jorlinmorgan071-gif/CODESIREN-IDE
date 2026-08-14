// Quick loading trace — switch avatars and capture [LOADING-TRACE] logs
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
    if (text.includes('LOADING-TRACE') || text.includes('[face]') || text.includes('Context Lost')) {
      logs.push({ time: Date.now(), text });
    }
  });

  console.log('Loading /face...');
  await page.goto('http://localhost:3000/face', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);

  console.log('Switching to Hatsune Miku...');
  await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
  await page.waitForTimeout(2000);
  // Try multiple selectors
  try {
    await page.click('text=Hatsune Miku', { timeout: 5000 });
    console.log('  Clicked Hatsune Miku');
  } catch {
    try {
      await page.locator('text=Hatsune Miku').first().click({ timeout: 5000 });
      console.log('  Clicked Hatsune Miku (locator)');
    } catch {
      // Maybe the name is different — try Yinlin
      try {
        await page.click('text=Yinlin', { timeout: 5000 });
        console.log('  Clicked Yinlin');
      } catch {
        console.log('  Could not find any avatar button');
        // Print what's visible
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
        console.log(`  Body text: ${bodyText}`);
      }
    }
  }

  console.log('Waiting 15s for switch to complete...');
  await page.waitForTimeout(15000);

  // Check if spinner is still visible
  const spinnerVisible = await page.evaluate(() => {
    const spinner = document.querySelector('.animate-spin');
    return spinner !== null;
  }).catch(() => false);

  console.log(`\nSpinner still visible after 15s: ${spinnerVisible}`);

  console.log('\n── Raw LOADING-TRACE logs ──');
  for (const log of logs) {
    const t = new Date(log.time).toISOString().slice(11, 23);
    console.log(`  [${t}] ${log.text}`);
  }

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
