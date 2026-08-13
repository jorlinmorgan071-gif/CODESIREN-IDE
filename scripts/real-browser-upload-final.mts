// scripts/real-browser-upload-final.mts
//
// Step 4 final test — drives the ACTUAL UI flow with Morgan's VRM file:
// 1. Load /face, open picker, click Upload
// 2. Set file input to Morgan's VRM (upload/2446869014792586009.vrm)
// 3. Wait for analysis to complete (up to 40s — large file)
// 4. Click Confirm button
// 5. Wait for POST /api/avatar/custom response
// 6. Verify: HTTP 201, avatar appears in GET /api/avatar/manifest
// 7. Capture all console output + the actual multipart request

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';
const VRM_FILE = '/home/z/my-project/upload/2446869014792586009.vrm';

async function main() {
  console.log('═'.repeat(72));
  console.log('Real Browser Upload — Final Step 4 Test');
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

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const consoleLogs: string[] = [];
  page.on('console', (msg: any) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err: any) => consoleLogs.push(`[PAGE-ERROR] ${err.message}`));

  // Capture the upload request + response
  let uploadRequest: any = null;
  let uploadResponse: any = null;

  page.on('response', async (res: any) => {
    if (res.url().includes('/api/avatar/custom') && res.request().method() === 'POST') {
      uploadRequest = {
        url: res.url(),
        method: res.request().method(),
      };
      try {
        const body = await res.text();
        uploadResponse = { status: res.status(), body: body.slice(0, 500) };
      } catch {
        uploadResponse = { status: res.status(), body: '(could not read)' };
      }
    }
  });

  console.log('Loading /face...');
  await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  console.log('Opening picker + Upload button...');
  await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  await page.locator('button:has(svg.lucide-upload)').first().click({ timeout: 5000 });
  await page.waitForTimeout(2000);

  console.log(`Setting file: ${VRM_FILE}`);
  await page.locator('input[type="file"]').first().setInputFiles(VRM_FILE);
  console.log('  ✓ File set — waiting for analysis (up to 40s)...');

  // Poll for the Confirm button to appear (analysis complete)
  let confirmClicked = false;
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(5000);
    const hasConfirm = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const b of buttons) {
        const text = b.textContent?.toLowerCase() ?? '';
        if (text.includes('confirm') || text.includes('upload') || text.includes('save')) {
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (hasConfirm) {
      console.log(`  ✓ Confirm button found at ${(i+1)*5}s — clicking...`);
      // Click the Confirm button
      const confirmBtn = page.locator('button').filter({ hasText: /confirm|upload|save/i }).first();
      try {
        await confirmBtn.click({ timeout: 5000 });
        confirmClicked = true;
        console.log('  ✓ Confirm clicked');
      } catch {
        // Try clicking by text
        await page.click('text=/confirm|upload|save/i', { timeout: 5000 }).catch(() => {});
        confirmClicked = true;
        console.log('  ✓ Clicked via text');
      }
      break;
    } else {
      console.log(`  [${(i+1)*5}s] No Confirm button yet...`);
    }
  }

  if (!confirmClicked) {
    console.log('  ✗ Confirm button never appeared — analysis may have failed');
  }

  // Wait for upload response
  console.log('Waiting 15s for upload response...');
  await page.waitForTimeout(15000);

  // Check manifest
  console.log('\n── Checking manifest for the uploaded avatar ──');
  const manifestCheck = await page.evaluate(async () => {
    const token = localStorage.getItem('cs_token') ?? '';
    const res = await fetch('http://localhost:3001/api/avatar/manifest', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    const customs = data.avatars?.filter((a: any) => a.isCustom) ?? [];
    return { total: data.avatars?.length ?? 0, customs: customs.length, customIds: customs.map((c: any) => c.id) };
  }).catch(() => ({ total: 0, customs: 0, customIds: [], error: 'evaluate failed' }));

  // Canvas state
  const canvasState = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { w: c?.width ?? 0, h: c?.height ?? 0 };
  }).catch(() => ({ w: 0, h: 0 }));

  // Report
  console.log('\n' + '═'.repeat(72));
  console.log('UPLOAD REQUEST/RESPONSE');
  console.log('═'.repeat(72));
  console.log(`Request: ${uploadRequest ? uploadRequest.method + ' ' + uploadRequest.url : 'NOT CAPTURED'}`);
  console.log(`Response: ${uploadResponse ? `HTTP ${uploadResponse.status}` : 'NOT CAPTURED'}`);
  if (uploadResponse) {
    console.log(`Body: ${uploadResponse.body}`);
  }

  console.log('\n' + '═'.repeat(72));
  console.log('MANIFEST CHECK');
  console.log('═'.repeat(72));
  console.log(`Total avatars: ${manifestCheck.total}`);
  console.log(`Custom avatars: ${manifestCheck.customs}`);
  console.log(`Custom IDs: ${JSON.stringify(manifestCheck.customIds)}`);

  console.log('\n' + '═'.repeat(72));
  console.log('CANVAS STATE');
  console.log('═'.repeat(72));
  console.log(`Canvas: ${canvasState.w}x${canvasState.h}`);

  console.log('\n' + '═'.repeat(72));
  console.log('RELEVANT CONSOLE LOGS');
  console.log('═'.repeat(72));
  const relevant = consoleLogs.filter(l =>
    l.includes('avatar') || l.includes('upload') || l.includes('error') ||
    l.includes('Error') || l.includes('face') || l.includes('R3F') ||
    l.includes('Context Lost') || l.includes('custom') || l.includes('201') ||
    l.includes('vrm') || l.includes('VRM')
  );
  for (const l of relevant.slice(-20)) {
    console.log(`  ${l}`);
  }
  if (relevant.length === 0) console.log('  (none)');

  // Summary
  console.log('\n' + '═'.repeat(72));
  console.log('SUMMARY');
  console.log('═'.repeat(72));
  const uploadOk = uploadResponse?.status === 201;
  const inManifest = manifestCheck.customs > 0;
  const canvasAlive = canvasState.w > 0 && canvasState.h > 0;
  console.log(`  Upload returned 201: ${uploadOk ? '✅' : '❌'}`);
  console.log(`  Avatar in manifest: ${inManifest ? '✅' : '❌'}`);
  console.log(`  Canvas alive: ${canvasAlive ? '✅' : '❌'}`);
  console.log(`  WebGL Context Lost: ${consoleLogs.some(l => l.includes('Context Lost')) ? '❌ YES' : '✅ NO'}`);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
