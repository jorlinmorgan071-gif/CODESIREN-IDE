// scripts/real-browser-upload-test.mts
//
// Real browser upload test — drives the actual FaceView UI, picks a real VRM
// file from Morgan's upload/ directory, clicks through the real dialog, and
// captures the ACTUAL outgoing multipart request (Content-Disposition header,
// filename, field names) to compare with what the server expects.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';
const VRM_FILE = '/home/z/my-project/upload/2446869014792586009.vrm';

async function main() {
  console.log('═'.repeat(72));
  console.log('Real Browser Upload Test — capture outgoing multipart');
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
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Capture ALL console logs
  const consoleLogs: string[] = [];
  page.on('console', (msg: any) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err: any) => consoleLogs.push(`[PAGE-ERROR] ${err.message}`));

  // Capture the actual outgoing request to /api/avatar/custom
  let capturedRequest: any = null;
  let capturedRequestBody: string | null = null;

  page.on('request', (req: any) => {
    if (req.url().includes('/api/avatar/custom') && req.method() === 'POST') {
      capturedRequest = {
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
      };
      // Try to get the post data
      try {
        const postData = req.postData();
        if (postData) {
          // postData for multipart is usually the raw body — capture first 2000 chars
          capturedRequestBody = postData.slice(0, 2000);
        }
      } catch {}
    }
  });

  // Capture the response
  let capturedResponse: any = null;
  page.on('response', async (res: any) => {
    if (res.url().includes('/api/avatar/custom') && res.request().method() === 'POST') {
      try {
        const body = await res.text();
        capturedResponse = {
          status: res.status(),
          body: body.slice(0, 500),
        };
      } catch {
        capturedResponse = { status: res.status(), body: '(could not read body)' };
      }
    }
  });

  console.log('Loading /face...');
  await page.goto(`${APP_URL}/face`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // Open picker + click Upload
  console.log('Opening avatar picker...');
  await page.locator('button:has(svg.lucide-user)').first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);

  console.log('Clicking Upload button...');
  await page.locator('button:has(svg.lucide-upload)').first().click({ timeout: 5000 });
  await page.waitForTimeout(2000);

  // Set the file input — use Morgan's actual VRM file
  console.log(`Setting file input to: ${VRM_FILE}`);
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(VRM_FILE);
  console.log('  ✓ File set');

  // Wait for analysis to complete
  console.log('Waiting 30s for analysis...');
  await page.waitForTimeout(30000);

  // Check what stage we're in
  const stageText = await page.evaluate(() => {
    const body = document.body.innerText;
    if (body.includes('Confirm')) return 'review (Confirm visible)';
    if (body.includes('Analyzing') || body.includes('analyzing')) return 'analyzing';
    if (body.includes('Uploading')) return 'uploading';
    if (body.includes('Error') || body.includes('error')) return 'error';
    if (body.includes('Success')) return 'success';
    return 'unknown';
  }).catch(() => 'evaluate-failed');
  console.log(`  Stage: ${stageText}`);

  // If we're in review stage, click Confirm
  if (stageText.includes('review') || stageText.includes('Confirm')) {
    console.log('Clicking Confirm button...');
    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Upload"), button:has-text("confirm")').first();
    try {
      await confirmBtn.click({ timeout: 5000 });
      console.log('  ✓ Confirm clicked');
    } catch {
      console.log('  ✗ Could not find Confirm button');
    }

    // Wait for upload to complete
    console.log('Waiting 15s for upload...');
    await page.waitForTimeout(15000);
  }

  // Report captured request
  console.log('\n' + '═'.repeat(72));
  console.log('CAPTURED OUTGOING REQUEST');
  console.log('═'.repeat(72));
  if (capturedRequest) {
    console.log(`URL: ${capturedRequest.url}`);
    console.log(`Method: ${capturedRequest.method}`);
    console.log(`Content-Type: ${capturedRequest.headers['content-type'] ?? '(not set)'}`);
    console.log(`Authorization: ${capturedRequest.headers['authorization'] ? 'present' : 'MISSING'}`);
    if (capturedRequestBody) {
      console.log(`\nRequest body (first 2000 chars):`);
      console.log(capturedRequestBody);
    } else {
      console.log('\nRequest body: (could not capture — multipart bodies are not always available via postData)');
    }
  } else {
    console.log('NO REQUEST to /api/avatar/custom was captured!');
    console.log('The upload may not have fired, or the dialog crashed before sending.');
  }

  console.log('\n' + '═'.repeat(72));
  console.log('CAPTURED RESPONSE');
  console.log('═'.repeat(72));
  if (capturedResponse) {
    console.log(`Status: ${capturedResponse.status}`);
    console.log(`Body: ${capturedResponse.body}`);
  } else {
    console.log('NO RESPONSE captured');
  }

  // Check canvas state
  const canvasState = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { w: c?.width ?? 0, h: c?.height ?? 0 };
  }).catch(() => ({ w: 0, h: 0 }));
  console.log(`\nCanvas: ${canvasState.w}x${canvasState.h}`);

  // Print relevant console logs
  console.log('\n' + '═'.repeat(72));
  console.log('RELEVANT CONSOLE LOGS');
  console.log('═'.repeat(72));
  const relevant = consoleLogs.filter(l =>
    l.includes('UPLOAD-DEBUG') || l.includes('avatar') || l.includes('upload') ||
    l.includes('error') || l.includes('Error') || l.includes('face') ||
    l.includes('R3F') || l.includes('Context Lost') || l.includes('vrm') ||
    l.includes('VRM') || l.includes('reject') || l.includes('Reject') ||
    l.includes('analyz') || l.includes('Analyz')
  );
  for (const l of relevant.slice(-30)) {
    console.log(`  ${l}`);
  }
  if (relevant.length === 0) {
    console.log('  (no relevant logs)');
  }

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
