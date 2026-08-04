// server/src/agents/operative/playwright-client.ts
// Phase A Section 5: real Playwright browser client.
//
// Implements the BrowserClient interface using real Playwright (Chromium).
// Reuses the already-cached browser binaries (~/.cache/ms-playwright/) from
// the lip sync verification work — no new browser download needed.
//
// SECURITY (per Section 0):
//   - evaluate is REFUSED with a clear error message — NOT silently no-op'd.
//     The sandbox pre-validation only catches require/process/fs, but real
//     Playwright's page context has document.cookie, fetch, localStorage,
//     etc. that the sandbox can't see. Arbitrary JS execution in a real page
//     is a known security gap, deferred to v2 with proper browser-context
//     sandboxing.
//   - All other actions go through validateBrowserAction() first (same as
//     the stub) — URL/scheme/domain validation stays in the critical path.
//   - The Ghost Mode approval gate fires BEFORE execute() is called (in
//     OperativeAgent.runBrowse) — real Playwright doesn't change the gating.
//
// LIFECYCLE: a single browser instance is launched lazily on first use and
// reused across actions. A new page is created per execute() call (pages
// are cheap in Playwright). The browser is never closed during the process
// lifetime — it's cleaned up on process exit.

import { chromium, type Browser, type Page } from 'playwright';
import { validateBrowserAction, type BrowserAction, type SandboxOpts } from '../../security/sandbox.js';
import type { BrowserActionResult, BrowserClient } from './browser-client.js';

export class PlaywrightBrowserClient implements BrowserClient {
  readonly implementation = 'playwright';

  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;

  /**
   * Lazily launch a single browser instance. Reused across all actions.
   * Uses headless Chromium (already cached in ~/.cache/ms-playwright/).
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.launchPromise) return this.launchPromise;

    this.launchPromise = (async () => {
      console.log('[playwright-client] launching headless Chromium...');
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',              // required in container environments
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',   // avoids /dev/shm issues in containers
        ],
      });
      console.log('[playwright-client] browser launched');
      this.browser = browser;
      return browser;
    })();

    return this.launchPromise;
  }

  /**
   * Create a fresh page for each execute() call. Pages are cheap in Playwright
   * and this avoids state leakage between actions.
   */
  private async newPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    return context.newPage();
  }

  async execute(action: BrowserAction, sandboxOpts?: SandboxOpts): Promise<BrowserActionResult> {
    const start = Date.now();

    // 1. Security sandbox validation — SAME as the stub. URL/scheme/domain
    //    checks for navigate, type validation, etc.
    const validation = await validateBrowserAction(action, sandboxOpts);
    if (!validation.allowed) {
      return {
        action,
        allowed: false,
        success: false,
        violation: validation.violation,
        reason: validation.reason,
        durationMs: Date.now() - start,
      };
    }

    // 2. Explicit refusal for evaluate — per Section 0, this is the highest-
    //    risk action type. The sandbox pre-validation only catches require/
    //    process/fs, but real Playwright's page context has document.cookie,
    //    fetch, localStorage, etc. Arbitrary JS execution in a real page is
    //    a known security gap, deferred to v2.
    if (action.type === 'evaluate') {
      return {
        action,
        allowed: false,
        success: false,
        reason: 'evaluate is not enabled — arbitrary JS execution in a real page context is a known security gap, deferred to v2 with proper browser-context sandboxing',
        durationMs: Date.now() - start,
      };
    }

    // 3. Execute the action with real Playwright
    let page: Page;
    try {
      page = await this.newPage();
    } catch (err: any) {
      return {
        action,
        allowed: true,
        success: false,
        reason: `failed to launch page: ${err.message}`,
        durationMs: Date.now() - start,
      };
    }

    try {
      let result: unknown;
      const timeout = sandboxOpts?.timeoutMs ?? 30_000;

      switch (action.type) {
        case 'navigate': {
          await page.goto(action.url ?? 'about:blank', { timeout, waitUntil: 'domcontentloaded' });
          const title = await page.title();
          const url = page.url();
          result = { url, title };
          break;
        }

        case 'click': {
          if (action.selector) {
            await page.click(action.selector, { timeout });
            result = { clicked: action.selector };
          } else if (action.x !== undefined && action.y !== undefined) {
            await page.mouse.click(action.x, action.y);
            result = { clicked: `(${action.x},${action.y})` };
          } else {
            result = { clicked: 'no target specified' };
          }
          break;
        }

        case 'type': {
          const target = action.selector ?? 'body';
          await page.fill(target, action.text ?? '', { timeout });
          result = { typed: action.text ?? '', into: target };
          break;
        }

        case 'scroll': {
          // Use Playwright's keyboard to scroll (PageDown) instead of evaluate
          // to avoid the `window` reference issue in the TS compiler
          await page.keyboard.press('PageDown');
          result = { scrolled: true };
          break;
        }

        case 'screenshot': {
          const buf = await page.screenshot({ type: 'png' });
          result = { taken: true, size: buf.length, base64: buf.toString('base64').slice(0, 100) + '...' };
          break;
        }

        case 'wait': {
          const ms = Math.min(action.duration ?? 1000, 5000);
          await page.waitForTimeout(ms);
          result = { waited: ms };
          break;
        }

        case 'submit': {
          if (action.selector) {
            await page.$eval(action.selector, (form: any) => form.submit()).catch(() => {});
            result = { submitted: action.selector };
          } else {
            result = { submitted: 'no form selector specified' };
          }
          break;
        }

        case 'hover': {
          if (action.selector) {
            await page.hover(action.selector, { timeout });
            result = { hovered: action.selector };
          } else {
            result = { hovered: 'no selector' };
          }
          break;
        }

        case 'focus': {
          if (action.selector) {
            await page.focus(action.selector, { timeout });
            result = { focused: action.selector };
          } else {
            result = { focused: 'no selector' };
          }
          break;
        }

        case 'select': {
          if (action.selector) {
            const selectedValues = await page.selectOption(action.selector, action.value ?? '');
            result = { selected: selectedValues, selector: action.selector };
          } else {
            result = { selected: [], selector: 'none' };
          }
          break;
        }

        default:
          result = { unknown: action.type };
      }

      return {
        action,
        allowed: true,
        success: true,
        result,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        action,
        allowed: true,
        success: false,
        reason: err.message,
        durationMs: Date.now() - start,
      };
    } finally {
      // Close the page (but NOT the browser — the browser is reused)
      await page.close().catch(() => {});
    }
  }

  async screenshot(): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const page = await this.newPage();
      try {
        const buf = await page.screenshot({ type: 'png', fullPage: false });
        return { success: true, data: buf.toString('base64') };
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Close the browser instance. Called on process exit.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('[playwright-client] browser closed');
    }
  }
}
