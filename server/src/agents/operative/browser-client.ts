// server/src/agents/operative/browser-client.ts
// BrowserClient interface + StubBrowserClient impl.
//
// Same pattern as Step 5's PrinterClient: the interface is the contract, the
// stub is injected by default, real Playwright impl is deployment-time.
//
// Per Step 6 user condition: the Security Sandbox must be proven BEFORE the
// Operative Agent routes through it. The sandbox catches disallowed calls,
// timeouts, and memory overruns. The Operative Agent's 'evaluate' actions
// (arbitrary JS in the browser page) go through the sandbox for pre-validation.
// The other browser actions (navigate, click, type) are validated by
// validateBrowserAction() in security/sandbox.ts (URL allowlists etc.).

import { validateBrowserAction, executeInSandbox, type BrowserAction, type SandboxOpts } from '../../security/sandbox.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface BrowserActionResult {
  action: BrowserAction;
  allowed: boolean;
  success: boolean;
  result?: unknown;
  violation?: string;
  reason?: string;
  durationMs: number;
}

// ── BrowserClient interface ──────────────────────────────────────────────

export interface BrowserClient {
  readonly implementation: string;  // 'stub' | 'playwright'

  /**
   * Execute a browser action. ALL actions go through the Security Sandbox
   * validation first (validateBrowserAction). If the action is blocked,
   * it returns { allowed: false, reason } without touching the browser.
   *
   * For 'evaluate' actions, the code runs in the sandbox BEFORE being
   * sent to the browser — disallowed calls (require, process, fs) are
   * caught there.
   */
  execute(action: BrowserAction, sandboxOpts?: SandboxOpts): Promise<BrowserActionResult>;

  /** Take a screenshot of the current page. */
  screenshot(): Promise<{ success: boolean; data?: string; error?: string }>;
}

// ── StubBrowserClient ────────────────────────────────────────────────────

export class StubBrowserClient implements BrowserClient {
  readonly implementation = 'stub';

  private currentPage = 'about:blank';
  private pageContent: Record<string, string> = {
    'about:blank': '<html><body></body></html>',
    'https://example.com': '<html><body><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p></body></html>',
    'https://httpbin.org/html': '<html><body><h1>Herman Melville - Moby-Dick</h1><p>Call me Ishmael.</p></body></html>',
  };

  async execute(action: BrowserAction, sandboxOpts?: SandboxOpts): Promise<BrowserActionResult> {
    const start = Date.now();

    // 1. Security Sandbox validation — ALL actions go through this first.
    //    This is the "Security Sandbox validation" the directive Step 6 refers to.
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

    // 2. Action is allowed — execute it (stub: simulate the browser)
    let result: unknown;
    try {
      switch (action.type) {
        case 'navigate':
          this.currentPage = action.url ?? 'about:blank';
          result = { url: this.currentPage, title: this.currentPage };
          break;
        case 'click':
          result = { clicked: action.selector ?? `(${action.x},${action.y})` };
          break;
        case 'type':
          result = { typed: action.text ?? '', into: action.selector ?? 'body' };
          break;
        case 'scroll':
          result = { scrolled: true };
          break;
        case 'screenshot':
          result = { taken: true };
          break;
        case 'wait':
          await new Promise((r) => setTimeout(r, Math.min(action.duration ?? 1000, 5000)));
          result = { waited: action.duration ?? 1000 };
          break;
        case 'evaluate':
          // For 'evaluate', the code was already run through the sandbox by
          // validateBrowserAction. Here we just return the sandbox output.
          // In a real browser, this code would run in the page's JS context.
          result = { evaluated: true, note: 'code pre-validated by sandbox' };
          break;
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
    }
  }

  async screenshot(): Promise<{ success: boolean; data?: string; error?: string }> {
    return { success: true, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
  }
}

// ── Dependency injection ─────────────────────────────────────────────────

let activeBrowserClient: BrowserClient = new StubBrowserClient();

export function getBrowserClient(): BrowserClient {
  return activeBrowserClient;
}

export function setBrowserClient(client: BrowserClient): void {
  activeBrowserClient = client;
  console.log(`[browser-client] active implementation: ${client.implementation}`);
}
