// scripts/editor-actions-proof.mts
//
// Phase B: Editor Actions — Real in-editor integration proof.
//
// Playwright test that verifies the ACTUAL in-editor behavior:
//   1. Select code, trigger Refactor, confirm diff preview renders with real content
//   2. Click Accept — confirm editor content actually changed (read model value before/after)
//   3. Fresh selection, trigger Refactor, click Reject — confirm editor content unchanged
//   4. After Accept, press Ctrl+Z — confirm editor reverts in one undo step
//
// The test starts both the server + vite dev server, launches headless Chromium
// with fake media stream, navigates to the Home route, waits for the editor to
// load, then interacts with Monaco directly via page.evaluate().

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SERVER_DIR = join(PROJECT_ROOT, 'server');
const APP_DIR = join(PROJECT_ROOT, 'app');
const SERVER_URL = 'http://localhost:3001';
const APP_URL = 'http://localhost:3000';

interface TestResult {
  name: string;
  passed: boolean;
  evidence: Record<string, unknown>;
  error?: string;
}

const results: TestResult[] = [];

function log(msg: string) { console.log(msg); }

async function waitForServer(url: string, label: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) { log(`  [setup] ${label} ready`); return; }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} not ready`);
}

async function waitForApp(url: string, label: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url)).ok) { log(`  [setup] ${label} ready`); return; } } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} not ready`);
}

async function main() {
  log('═'.repeat(72));
  log('Phase B: Editor Actions — Real In-Editor Integration Proof');
  log('═'.repeat(72));
  log('');

  // Kill stale processes
  try {
    const { execSync } = await import('node:child_process');
    execSync('lsof -ti:3000 -ti:3001 2>/dev/null | xargs -r kill -9 2>/dev/null || true', { stdio: 'ignore' });
  } catch {}
  await new Promise(r => setTimeout(r, 1000));

  // Ensure .env
  const envPath = join(SERVER_DIR, '.env');
  if (!existsSync(envPath)) {
    copyFileSync(join(SERVER_DIR, '.env.example'), envPath);
  }

  // Start servers
  log('Starting server + app...');
  const serverProc = spawn('npm', ['start'], { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'development' } });
  const appProc = spawn('npm', ['run', 'dev'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });

  let browser: any = null;
  let page: any = null;

  try {
    await waitForServer(SERVER_URL, 'server', 30000);
    await waitForApp(APP_URL, 'app', 30000);
    log('');

    // Launch browser
    browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', (msg: any) => { if (msg.type() === 'error') log(`  [browser:error] ${msg.text().slice(0, 120)}`); });

    // Load Home + wait for editor
    log('Loading Home route...');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000); // wait for auto-register + Monaco load

    // Wait for Monaco editor to be present
    await page.waitForSelector('.monaco-editor', { timeout: 15000 });
    log('Monaco editor found');

    // Type some code into the editor so we have something to refactor
    log('Typing test code into editor...');
    // Use the monaco-editor-react's exposed editor via the DOM data attribute.
    // @monaco-editor/react stores the editor instance on the container element.
    await page.evaluate(() => {
      // Try multiple ways to find the editor instance
      const container = document.querySelector('.monaco-editor');
      if (!container) { console.log('[test] no .monaco-editor container'); return; }

      // Method 1: monaco-editor-react stores editor on a ref — check __proto__
      // Method 2: Use the global monaco API
      const w = window as any;
      if (w.monaco?.editor?.getEditors) {
        const editors = w.monaco.editor.getEditors();
        if (editors.length > 0) {
          const editor = editors[0];
          const model = editor.getModel();
          if (model) {
            model.setValue('function add(a, b) {\n  return a + b;\n}\n');
            console.log('[test] code set via getEditors()');
            return;
          }
        }
      }

      // Method 3: Try via the model URI
      if (w.monaco?.editor?.getModels) {
        const models = w.monaco.editor.getModels();
        if (models.length > 0) {
          models[0].setValue('function add(a, b) {\n  return a + b;\n}\n');
          console.log('[test] code set via getModels()');
          return;
        }
      }
      console.log('[test] could not find editor/model');
    });
    await page.waitForTimeout(500);

    // ── Helper: get current editor content ──
    const getEditorContent = async (): Promise<string> => {
      return await page.evaluate(() => {
        const w = window as any;
        // Method 1: getEditors()
        if (w.monaco?.editor?.getEditors) {
          const editors = w.monaco.editor.getEditors();
          if (editors.length > 0) return editors[0].getModel()?.getValue() ?? '(no model)';
        }
        // Method 2: getModels()
        if (w.monaco?.editor?.getModels) {
          const models = w.monaco.editor.getModels();
          if (models.length > 0) return models[0].getValue();
        }
        return '(editor not found)';
      });
    };

    // ── Helper: select all text in the editor ──
    const selectAll = async (): Promise<void> => {
      await page.evaluate(() => {
        const w = window as any;
        if (w.monaco?.editor?.getEditors) {
          const editors = w.monaco.editor.getEditors();
          if (editors.length > 0) {
            const editor = editors[0];
            editor.setSelection(editor.getModel().getFullModelRange());
          }
        }
      });
      await page.waitForTimeout(200);
    };

    // ── Helper: open InlineAI panel ──
    const openInlineAI = async (): Promise<void> => {
      // The FAB has title="Toggle Inline AI (Ariadne)"
      await page.click('[title="Toggle Inline AI (Ariadne)"]');
      await page.waitForTimeout(500);
    };

    // ── Helper: close InlineAI panel ──
    const closeInlineAI = async (): Promise<void> => {
      // Close via the X button in the panel header, or toggle the FAB
      const closeBtn = await page.$('[title="Toggle Inline AI (Ariadne)"]');
      if (closeBtn) {
        await closeBtn.click();
        await page.waitForTimeout(300);
      }
    };

    let panelWasOpened = false;

    // ── Helper: close InlineAI panel via the X button ──
    const closePanelViaX = async (): Promise<void> => {
      // The X button is in the panel header — it has an svg child
      // Find it by looking for a button inside the panel that contains an X icon
      const xBtn = await page.$('.fixed button:has(svg):has-text("")');
      if (xBtn) {
        try { await xBtn.click(); } catch {}
      }
      // Also try the FAB as fallback
      await page.waitForTimeout(300);
    };

    // ── Helper: trigger an InlineAI action ──
    const triggerAction = async (actionId: string): Promise<void> => {
      if (panelWasOpened) {
        // Close the panel — try X button first, then FAB
        await closePanelViaX();
        await page.waitForTimeout(500);
        // Ensure panel is closed by toggling FAB if needed
        const panelVisible = await page.$('.inline-action-btn');
        if (panelVisible) {
          // Panel still open — click FAB to close
          await page.click('[title="Toggle Inline AI (Ariadne)"]');
          await page.waitForTimeout(500);
        }
      }
      // Open the panel
      await page.click('[title="Toggle Inline AI (Ariadne)"]');
      panelWasOpened = true;
      await page.waitForTimeout(1000);

      // Click the specific action button
      const btn = await page.$(`button.inline-action-btn:has-text("${actionId}")`);
      if (btn) {
        await btn.click();
        log(`  triggered "${actionId}"`);
      } else {
        const fallback = await page.$(`button:has-text("${actionId}")`);
        if (fallback) {
          await fallback.click();
          log(`  triggered "${actionId}" (fallback)`);
        } else {
          log(`  WARNING: "${actionId}" button not found`);
        }
      }
    };

    // ── Helper: wait for diff preview to appear ──
    const waitForDiffPreview = async (timeout = 15000): Promise<boolean> => {
      try {
        await page.waitForSelector('text=ORIGINAL', { timeout });
        await page.waitForSelector('text=RESULT', { timeout: 2000 });
        return true;
      } catch {
        return false;
      }
    };

    // ── Helper: get diff preview content ──
    const getDiffPreviewContent = async (): Promise<{ original: string; result: string }> => {
      return await page.evaluate(() => {
        const panels = document.querySelectorAll('pre');
        let original = '';
        let result = '';
        if (panels.length >= 2) {
          original = panels[0]?.textContent ?? '';
          result = panels[1]?.textContent ?? '';
        }
        return { original, result };
      });
    };

    // ════════════════════════════════════════════════════════════════════
    // SCENARIO 1: Diff preview renders with real content
    // ════════════════════════════════════════════════════════════════════
    log('\n── SCENARIO 1: Diff preview renders with real content ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        const beforeContent = await getEditorContent();
        evidence['editor content before'] = beforeContent;

        // Select all code
        await selectAll();
        evidence['selection made'] = true;

        // Trigger Refactor
        await triggerAction('Refactor');

        // Wait for diff preview
        const diffVisible = await waitForDiffPreview();
        evidence['diff preview visible'] = diffVisible;

        if (diffVisible) {
          const diff = await getDiffPreviewContent();
          evidence['original (from diff)'] = diff.original.slice(0, 200);
          evidence['result (from diff)'] = diff.result.slice(0, 200);
          log(`  diff preview visible: ${diffVisible}`);
          log(`  original: "${diff.original.slice(0, 60)}..."`);
          log(`  result: "${diff.result.slice(0, 60)}..."`);
        }

        const passed = diffVisible;
        results.push({ name: 'SCENARIO 1: Diff preview renders', passed, evidence });

        // Close the panel for next test
        if (diffVisible) {
          const rejectBtn = await page.$('button:has-text("Reject")');
          if (rejectBtn) await rejectBtn.click();
          await page.waitForTimeout(500);
        }
        await closeInlineAI();
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'SCENARIO 1: Diff preview renders', passed: false, evidence, error: err.message });
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // SCENARIO 2: Accept changes editor content
    // ════════════════════════════════════════════════════════════════════
    log('\n── SCENARIO 2: Accept changes editor content ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        // Reset editor content
        await page.evaluate(() => {
          const editor = (window as any).monaco?.editor?.getEditors?.()?.[0];
          if (editor) editor.getModel()?.setValue('function add(a, b) {\n  return a + b;\n}\n');
        });
        await page.waitForTimeout(300);

        const beforeContent = await getEditorContent();
        evidence['editor content before accept'] = beforeContent;

        await selectAll();
        await triggerAction('Refactor');
        const diffVisible = await waitForDiffPreview();
        evidence['diff appeared'] = diffVisible;

        if (diffVisible) {
          // Click Accept
          const acceptBtn = await page.$('button:has-text("Accept")');
          if (acceptBtn) {
            await acceptBtn.click();
            log('  clicked Accept');
          }
          await page.waitForTimeout(1000);

          const afterContent = await getEditorContent();
          evidence['editor content after accept'] = afterContent;
          evidence['content changed'] = beforeContent !== afterContent;
          log(`  before: "${beforeContent.slice(0, 60)}..."`);
          log(`  after: "${afterContent.slice(0, 60)}..."`);
          log(`  content changed: ${beforeContent !== afterContent}`);
        }

        const passed = diffVisible && evidence['content changed'] === true;
        results.push({ name: 'SCENARIO 2: Accept changes content', passed, evidence });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'SCENARIO 2: Accept changes content', passed: false, evidence, error: err.message });
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // SCENARIO 3: Reject leaves editor unchanged
    // ════════════════════════════════════════════════════════════════════
    log('\n── SCENARIO 3: Reject leaves editor unchanged ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        // Reset editor content
        await page.evaluate(() => {
          const editor = (window as any).monaco?.editor?.getEditors?.()?.[0];
          if (editor) editor.getModel()?.setValue('function multiply(x, y) {\n  return x * y;\n}\n');
        });
        await page.waitForTimeout(300);

        const beforeContent = await getEditorContent();
        evidence['editor content before reject'] = beforeContent;

        await selectAll();
        await triggerAction('Refactor');
        const diffVisible = await waitForDiffPreview();
        evidence['diff appeared'] = diffVisible;

        if (diffVisible) {
          // Click Reject
          const rejectBtn = await page.$('button:has-text("Reject")');
          if (rejectBtn) {
            await rejectBtn.click();
            log('  clicked Reject');
          }
          await page.waitForTimeout(1000);

          const afterContent = await getEditorContent();
          evidence['editor content after reject'] = afterContent;
          evidence['content unchanged'] = beforeContent === afterContent;
          log(`  before: "${beforeContent.slice(0, 60)}..."`);
          log(`  after: "${afterContent.slice(0, 60)}..."`);
          log(`  content unchanged: ${beforeContent === afterContent}`);
        }

        const passed = diffVisible && evidence['content unchanged'] === true;
        results.push({ name: 'SCENARIO 3: Reject leaves unchanged', passed, evidence });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'SCENARIO 3: Reject leaves unchanged', passed: false, evidence, error: err.message });
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // SCENARIO 4: Ctrl+Z reverts after Accept (one undo step)
    // ════════════════════════════════════════════════════════════════════
    log('\n── SCENARIO 4: Ctrl+Z reverts after Accept ──');
    {
      const evidence: Record<string, unknown> = {};
      try {
        // Reset editor content
        const originalCode = 'function divide(a, b) {\n  return a / b;\n}\n';
        await page.evaluate((code: string) => {
          const editor = (window as any).monaco?.editor?.getEditors?.()?.[0];
          if (editor) editor.getModel()?.setValue(code);
        }, originalCode);
        await page.waitForTimeout(300);

        const beforeContent = await getEditorContent();
        evidence['editor content before refactor'] = beforeContent;

        await selectAll();
        await triggerAction('Refactor');
        const diffVisible = await waitForDiffPreview();
        evidence['diff appeared'] = diffVisible;

        if (diffVisible) {
          // Accept
          const acceptBtn = await page.$('button:has-text("Accept")');
          if (acceptBtn) await acceptBtn.click();
          await page.waitForTimeout(1000);

          const afterAccept = await getEditorContent();
          evidence['after accept'] = afterAccept;
          evidence['accept changed content'] = beforeContent !== afterAccept;

          // Press Ctrl+Z (undo) — focus the editor first
          await page.click('.monaco-editor');
          await page.waitForTimeout(200);
          await page.keyboard.down('Control');
          await page.keyboard.press('KeyZ');
          await page.keyboard.up('Control');
          await page.waitForTimeout(500);

          const afterUndo = await getEditorContent();
          evidence['after Ctrl+Z'] = afterUndo;
          evidence['undo reverted to original'] = afterUndo === beforeContent;
          log(`  before refactor: "${beforeContent.slice(0, 60)}..."`);
          log(`  after accept: "${afterAccept.slice(0, 60)}..."`);
          log(`  after Ctrl+Z: "${afterUndo.slice(0, 60)}..."`);
          log(`  reverted to original: ${afterUndo === beforeContent}`);
        }

        const passed = diffVisible && evidence['accept changed content'] === true && evidence['undo reverted to original'] === true;
        results.push({ name: 'SCENARIO 4: Ctrl+Z reverts in one step', passed, evidence });
      } catch (err: any) {
        evidence['error'] = err.message;
        results.push({ name: 'SCENARIO 4: Ctrl+Z reverts in one step', passed: false, evidence, error: err.message });
      }
    }

  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    log('\nCleaning up...');
    try { serverProc.kill('SIGTERM'); } catch {}
    try { appProc.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 1000));
    try { serverProc.kill('SIGKILL'); } catch {}
    try { appProc.kill('SIGKILL'); } catch {}
  }

  // Report
  log('\n' + '═'.repeat(72));
  log('RESULTS');
  log('═'.repeat(72));
  let passCount = 0;
  for (const r of results) {
    log(`\n${r.passed ? '✓ PASS' : '✗ FAIL'} — ${r.name}`);
    if (r.error) log(`  Error: ${r.error}`);
    log('  Evidence:');
    for (const [k, v] of Object.entries(r.evidence)) {
      log(`    ${k}: ${JSON.stringify(v)}`);
    }
    if (r.passed) passCount++;
  }
  log(`\n${'─'.repeat(72)}`);
  log(`Total: ${passCount}/${results.length} passed`);
  log('═'.repeat(72));
  process.exit(passCount === results.length ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
