// scripts/identify-second-radio-button.mts
//
// Investigates why the click-through proof found 2 Radio-icon buttons when
// only 1 "Live conversation" button is expected. Prints the outerHTML of
// each match + its parent tooltip wrapper so we can see what the second
// button actually is.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';

async function main() {
  console.log('═'.repeat(72));
  console.log('Identify the second Radio-icon button');
  console.log('═'.repeat(72));

  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Find all buttons containing the lucide-radio svg
  const radioButtons = page.locator('button:has(svg.lucide-radio)');
  const count = await radioButtons.count();
  console.log(`\nTotal buttons with Radio icon: ${count}\n`);

  for (let i = 0; i < count; i++) {
    console.log(`── Button #${i + 1} ──`);
    const outerHTML = await radioButtons.nth(i).evaluate((btn: any) => btn.outerHTML);
    console.log('outerHTML:');
    console.log(outerHTML);

    // Get the tooltip text from the PremiumTooltip wrapper
    const tooltipText = await radioButtons.nth(i).evaluate((btn: any) => {
      let el = btn.parentElement;
      // Walk up to find a data-tip attribute (PremiumTooltip sets this)
      for (let i = 0; i < 5 && el; i++) {
        const tip = el.getAttribute('data-tip');
        if (tip) return tip;
        el = el.parentElement;
      }
      return '(no tooltip found within 5 ancestors)';
    });
    console.log(`tooltip: "${tooltipText}"`);

    // Get the surrounding context (parent's parent's outerHTML, truncated)
    const context = await radioButtons.nth(i).evaluate((btn: any) => {
      let el = btn;
      for (let i = 0; i < 4; i++) el = el.parentElement;
      return el?.outerHTML?.slice(0, 500) ?? '(no context)';
    });
    console.log(`context (4-ancestor outerHTML, truncated):\n${context}`);

    // Bounding box to see where it is on the page
    const box = await radioButtons.nth(i).boundingBox();
    console.log(`position: x=${box?.x}, y=${box?.y}, w=${box?.width}, h=${box?.height}`);
    console.log('');
  }

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
