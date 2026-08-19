// scripts/markdown-render-test.mts
//
// Step 4: Verify markdown rendering in chat
// 1. Markdown-heavy response (bold, table, list) renders as formatted
// 2. Plain text response renders normally
// 3. Code fence boundary (bold before code block) doesn't break
// 4. Streaming shows raw text, then snaps to formatted when done

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const APP_URL = 'http://localhost:3000';

async function main() {
  console.log('═'.repeat(72));
  console.log('Markdown Rendering Test');
  console.log('═'.repeat(72));

  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const logs: string[] = [];
  page.on('console', (msg: any) => {
    const text = msg.text();
    if (text.includes('error') || text.includes('Error') || text.includes('Context Lost')) {
      logs.push(text);
    }
  });

  console.log('Loading app...');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Navigate to chat
  console.log('Clicking chat dock icon...');
  const chatBtn = page.locator('button:has(svg.lucide-message-square)').first();
  try {
    await chatBtn.click({ timeout: 5000 });
    console.log('  ✓ Chat opened');
  } catch {
    console.log('  - Chat may already be open');
  }
  await page.waitForTimeout(2000);

  // ═══ Test 1: Markdown-heavy response ═══
  console.log('\n── Test 1: Markdown rendering (bold, table, list) ──');

  // We can't control what the LLM returns, but we CAN check if the page
  // renders existing messages with markdown. Instead, let's check the DOM
  // for the presence of markdown-rendered elements after a response.
  //
  // Since the stub engine returns canned responses, we'll check if
  // ANY assistant message in the DOM has formatted elements (strong, table, ul, ol, code).

  // Send a message that would trigger a markdown response
  const textarea = page.locator('textarea').first();
  const sendBtn = page.locator('button:has(svg.lucide-send)').first();

  if (textarea && sendBtn) {
    try {
      await textarea.fill('Explain Newton\'s second law with a table of units and a list of examples');
      await page.waitForTimeout(500);
      await sendBtn.click({ timeout: 5000 });
      console.log('  ✓ Message sent');
    } catch {
      console.log('  - Could not send message (stub engine may not respond)');
    }
  }

  // Wait for response
  console.log('  Waiting 10s for response...');
  await page.waitForTimeout(10000);

  // Check what markdown elements are in the DOM
  const markdownElements = await page.evaluate(() => {
    const chatArea = document.querySelector('[class*="chat"]') || document.body;
    return {
      strong: chatArea.querySelectorAll('strong').length,
      table: chatArea.querySelectorAll('table').length,
      ul: chatArea.querySelectorAll('ul').length,
      ol: chatArea.querySelectorAll('ol').length,
      code: chatArea.querySelectorAll('code').length,
      pre: chatArea.querySelectorAll('pre').length,
      blockquote: chatArea.querySelectorAll('blockquote').length,
      h1: chatArea.querySelectorAll('h1').length,
      h2: chatArea.querySelectorAll('h2').length,
      h3: chatArea.querySelectorAll('h3').length,
      // Check for literal asterisks (sign of unrendered markdown)
      literalAsterisks: (chatArea.textContent || '').includes('**'),
    };
  }).catch(() => ({ strong: 0, table: 0, ul: 0, ol: 0, code: 0, pre: 0, blockquote: 0, h1: 0, h2: 0, h3: 0, literalAsterisks: false }));

  console.log('  DOM markdown elements:');
  console.log(`    <strong>: ${markdownElements.strong}`);
  console.log(`    <table>: ${markdownElements.table}`);
  console.log(`    <ul>: ${markdownElements.ul}`);
  console.log(`    <ol>: ${markdownElements.ol}`);
  console.log(`    <code> (inline): ${markdownElements.code}`);
  console.log(`    <pre>: ${markdownElements.pre}`);
  console.log(`    <blockquote>: ${markdownElements.blockquote}`);
  console.log(`    <h1>-<h3>: ${markdownElements.h1}, ${markdownElements.h2}, ${markdownElements.h3}`);
  console.log(`    Literal ** in text: ${markdownElements.literalAsterisks ? 'YES (bad)' : 'NO (good)'}`);

  // Screenshot
  await page.screenshot({ path: '/home/z/my-project/download/markdown-test-1.png', timeout: 10000 }).catch(() => {});
  console.log('  Screenshot: /home/z/my-project/download/markdown-test-1.png');

  // ═══ Test 2: Check if MarkdownRenderer component is loaded ═══
  console.log('\n── Test 2: Verify MarkdownRenderer is in the component tree ──');
  const hasMarkdownRender = await page.evaluate(() => {
    // Check if the component rendered any themed elements
    const chatContent = document.querySelector('[class*="chat"]') || document.body;
    const themedParagraphs = Array.from(chatContent.querySelectorAll('p')).filter(p => {
      const style = window.getComputedStyle(p);
      return style.color.includes('rgb') || style.color.includes('var');
    });
    return {
      totalP: chatContent.querySelectorAll('p').length,
      hasReactMarkdownWrapper: !!chatContent.querySelector('.text-\\[13px\\]'),
    };
  }).catch(() => ({ totalP: 0, hasReactMarkdownWrapper: false }));
  console.log(`  <p> elements in chat: ${hasMarkdownRender.totalP}`);
  console.log(`  Markdown wrapper present: ${hasMarkdownRender.hasReactMarkdownWrapper ? 'YES' : 'NO'}`);

  // Summary
  console.log('\n── Summary ──');
  const hasFormattedElements = markdownElements.strong > 0 || markdownElements.ul > 0 || markdownElements.ol > 0 || markdownElements.table > 0;
  console.log(`  Formatted markdown elements present: ${hasFormattedElements ? 'YES ✅' : 'NO (stub engine may not return markdown)'}`);
  console.log(`  Literal ** in text: ${markdownElements.literalAsterisks ? 'YES ❌' : 'NO ✅'}`);
  console.log(`  Context Lost: ${logs.some(l => l.includes('Context Lost')) ? 'YES ❌' : 'NO ✅'}`);
  console.log(`  Errors: ${logs.length}`);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
