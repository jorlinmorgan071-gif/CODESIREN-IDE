// server/src/security/sandbox.ts
// Security Sandbox — PDF Module 12.
//
// Per the confirmed caveat: "port the algorithm from the donor's SandboxedAgent
// / ContainerRunner, but the implementation must still satisfy what the original
// Code Siren PDF already specifies for Module 12 — Node isolated-vm/vm2, 32MB
// memory limit, 30s timeout. If the Rust crate's isolation model can be matched
// inside that Node-native approach, do that — don't import the crate just because
// it exists. Only fall back to a compiled Rust sidecar binary if a specific
// isolation guarantee genuinely can't be reproduced in Node."
//
// Implementation: isolated-vm (v6.1.2). This is a V8 isolate-based sandbox —
// each execution gets its own V8 heap with a hard memory limit, a watchdog
// timer for CPU/time limits, and NO access to the Node.js runtime (no require,
// no process, no fs, no network). This matches the donor's container isolation
// guarantees (no network, no host filesystem) without needing a Docker/Rust
// sidecar.
//
// Per Step 6 user condition: "build and trace the Security Sandbox as its own
// provable unit first — show it actually catching/blocking something (a timeout,
// a memory overrun, a disallowed call) before wiring the Operative Agent's
// browser actions through it."

import ivm from 'isolated-vm';
import { v4 as uuid } from 'uuid';
import { addStep, addToolResult, setOutcome, startTrace, completeTrace } from '../observability/traces.js';

// ── Types ────────────────────────────────────────────────────────────────

export type SandboxViolation =
  | 'timeout'
  | 'memory-overrun'
  | 'disallowed-call'
  | 'syntax-error'
  | 'runtime-error';

export interface SandboxResult {
  success: boolean;
  output?: unknown;
  violation?: SandboxViolation;
  errorMessage?: string;
  durationMs: number;
  memoryUsedBytes?: number;
}

export interface SandboxOpts {
  memoryLimitMB?: number;   // default 32 (PDF Module 12)
  timeoutMs?: number;       // default 30000 (PDF Module 12)
  filename?: string;        // for error stack traces
}

const DEFAULT_OPTS: Required<SandboxOpts> = {
  memoryLimitMB: 32,
  timeoutMs: 30_000,
  filename: 'sandbox.js',
};

// ── Sandbox ──────────────────────────────────────────────────────────────

/**
 * Execute untrusted JavaScript in an isolated V8 isolate.
 *
 * The isolate has:
 *   - A hard memory limit (default 32MB). Exceeding it throws a V8 OOM.
 *   - A watchdog timer (default 30s). Infinite loops are killed.
 *   - NO Node.js access: no require, no process, no fs, no network, no child_process.
 *   - A minimal context: a `log()` function for output, nothing else.
 *
 * The donor's container approach (Docker, --network none, mount allowlists)
 * provides the same guarantees at the process level. isolated-vm provides them
 * at the V8 isolate level — lighter weight, no Docker dependency, same isolation
 * for JS code execution. If a future step needs to run untrusted *Python* or
 * *native binaries* (not just JS), a Rust/Python sidecar under SidecarManager
 * is the fallback per the confirmed caveat.
 */
export async function executeInSandbox(
  code: string,
  opts: SandboxOpts = {},
): Promise<SandboxResult> {
  const config = { ...DEFAULT_OPTS, ...opts };
  const start = Date.now();

  // Create a fresh isolate for each execution — no state leaks between runs
  const isolate = new ivm.Isolate({ memoryLimit: config.memoryLimitMB });
  let context: ivm.Context;
  try {
    context = await isolate.createContext();
  } catch (err: any) {
    isolate.dispose();
    return {
      success: false,
      violation: 'runtime-error',
      errorMessage: `Failed to create isolate context: ${err.message}`,
      durationMs: Date.now() - start,
    };
  }

  // Set up the jail: a `log()` function that pushes to an array we can read back.
  // isolated-vm v6 API: create a function via new ivm.Callback and set it on
  // the global object. The callback runs in the host context, not the isolate.
  const logs: unknown[] = [];
  const logCallback = new ivm.Callback((...args: unknown[]) => {
    logs.push(args.length === 1 ? args[0] : args);
  });
  try {
    await context.global.set('log', logCallback);
  } catch (err: any) {
    isolate.dispose();
    return {
      success: false,
      violation: 'runtime-error',
      errorMessage: `Failed to set up sandbox context: ${err.message}`,
      durationMs: Date.now() - start,
    };
  }

  // Compile the code with a filename for error reporting
  let script: ivm.Script;
  try {
    script = await isolate.compileScript(code, { filename: config.filename });
  } catch (err: any) {
    isolate.dispose();
    return {
      success: false,
      violation: 'syntax-error',
      errorMessage: `Syntax error: ${err.message}`,
      durationMs: Date.now() - start,
    };
  }

  // Execute with a timeout. isolated-vm's run() respects the isolate's
  // watchdog timer — but we also set an outer Promise race as a belt-and-suspenders
  // guard in case the watchdog doesn't fire (e.g. the isolate is stuck in
  // native code).
  let result: ivm.Copy<unknown>;
  try {
    const execPromise = script.run(context, {
      timeout: config.timeoutMs,  // isolated-vm timeout is in milliseconds
      copy: true,  // copy the result across the isolate boundary
    });
    result = await Promise.race([
      execPromise,
      new Promise<ivm.Copy<unknown>>((_, reject) =>
        setTimeout(() => reject(new Error('__SANDBOX_TIMEOUT__')), config.timeoutMs + 1000),
      ),
    ]);
  } catch (err: any) {
    const durationMs = Date.now() - start;
    isolate.dispose();

    // Classify the violation
    const msg = err.message ?? String(err);
    let violation: SandboxViolation = 'runtime-error';
    if (msg.includes('__SANDBOX_TIMEOUT__') || msg.includes('timed out') || msg.includes('execution timed out')) {
      violation = 'timeout';
    } else if (msg.includes('memory') || msg.includes('heap') || msg.includes('Allocator reached') || msg.includes('out of memory') || msg.includes('Invalid string length') || msg.includes('Maximum call stack')) {
      violation = 'memory-overrun';
    } else if (msg.includes('is not defined') || msg.includes('require') || msg.includes('process') || msg.includes('global')) {
      violation = 'disallowed-call';
    }

    return {
      success: false,
      violation,
      errorMessage: msg,
      durationMs,
      memoryUsedBytes: getHeapUsed(isolate),
    };
  }

  const durationMs = Date.now() - start;
  const memoryUsedBytes = getHeapUsed(isolate);
  isolate.dispose();

  // The result is copied across — extract the value
  let output: unknown;
  try {
    output = result;
  } catch {
    output = '(unserializable result)';
  }

  return {
    success: true,
    output: logs.length > 0 ? logs : output,
    durationMs,
    memoryUsedBytes,
  };
}

function getHeapUsed(isolate: ivm.Isolate): number | undefined {
  try {
    const stats = isolate.getHeapStatisticsSync();
    return stats.used_heap_size;
  } catch {
    return undefined;
  }
}

// ── Action validation (for the Operative Agent's browser actions) ────────
// The sandbox also validates browser actions before they're dispatched.
// This is the "Security Sandbox validation" the directive Step 6 refers to:
// "Playwright automation routed through the *existing* Security Sandbox
// validation". Browser actions are checked against an allowlist of action
// types and (optionally) URL allowlists before being executed.

export type BrowserActionType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'scroll'
  | 'screenshot'
  | 'wait'
  | 'evaluate';

export interface BrowserAction {
  type: BrowserActionType;
  url?: string;         // for 'navigate'
  selector?: string;    // for 'click', 'type'
  text?: string;        // for 'type'
  x?: number;           // for 'click' (coordinate-based)
  y?: number;
  code?: string;        // for 'evaluate' — RUNS IN THE SANDBOX
  duration?: number;    // for 'wait' (ms)
}

export interface ActionValidationResult {
  allowed: boolean;
  reason?: string;
  violation?: SandboxViolation;
}

// URL schemes that are always blocked
const BLOCKED_URL_SCHEMES = ['file:', 'data:', 'javascript:', 'about:'];

// Domains that are blocked by default (can be overridden per-deployment)
const BLOCKED_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',  // cloud metadata endpoint
  'metadata.google.internal',
];

/**
 * Validate a browser action before it's dispatched.
 * Returns { allowed: false, reason } if the action is blocked.
 *
 * For 'evaluate' actions, the code is run through the sandbox (executeInSandbox)
 * — disallowed calls are caught there.
 *
 * For 'navigate' actions, the URL is checked against blocked schemes + domains.
 */
export async function validateBrowserAction(
  action: BrowserAction,
  opts: SandboxOpts = {},
): Promise<ActionValidationResult> {
  // 1. Validate action type
  const validTypes: BrowserActionType[] = ['navigate', 'click', 'type', 'scroll', 'screenshot', 'wait', 'evaluate'];
  if (!validTypes.includes(action.type)) {
    return { allowed: false, reason: `Unknown action type: ${action.type}` };
  }

  // 2. For 'evaluate' actions, run the code through the sandbox to catch
  //    disallowed calls BEFORE it would reach a real browser.
  if (action.type === 'evaluate' && action.code) {
    const result = await executeInSandbox(action.code, opts);
    if (!result.success && result.violation) {
      return {
        allowed: false,
        reason: `Sandbox blocked 'evaluate' code: ${result.violation} — ${result.errorMessage}`,
        violation: result.violation,
      };
    }
    // If the sandbox ran the code successfully, it's safe (no require/process/fs access).
    // In a real browser, this code would run in the page's JS context — the sandbox
    // pre-validates it to catch obvious escapes.
  }

  // 3. For 'navigate' actions, check the URL
  if (action.type === 'navigate' && action.url) {
    for (const scheme of BLOCKED_URL_SCHEMES) {
      if (action.url.startsWith(scheme)) {
        return { allowed: false, reason: `Blocked URL scheme: ${scheme}` };
      }
    }
    try {
      const parsed = new URL(action.url);
      for (const domain of BLOCKED_DOMAINS) {
        if (parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)) {
          return { allowed: false, reason: `Blocked domain: ${parsed.hostname} (matches ${domain})` };
        }
      }
    } catch {
      return { allowed: false, reason: `Invalid URL: ${action.url}` };
    }
  }

  return { allowed: true };
}

// ── Shell command validation (for the Terminal Agent) ────────────────────
// Per Fix 2: validateShellCommand() reuses the existing SandboxViolation
// classification shape — no parallel system. Blocklist per PDF Module 12.

export interface ShellCommandValidationResult {
  allowed: boolean;
  reason?: string;
  violation?: SandboxViolation;
}

// Commands/patterns that are ALWAYS blocked — non-negotiable.
const BLOCKED_SHELL_PATTERNS: Array<{ pattern: RegExp; reason: string; violation: SandboxViolation }> = [
  // rm -rf / (or variants like rm -rf /*, rm -rf ~)
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force)\s+[/~*]/i, reason: 'rm -rf on root/home/wildcard — catastrophic deletion', violation: 'disallowed-call' },
  // curl | bash / wget | sh (remote code execution)
  { pattern: /(?:curl|wget)\s+.*\|\s*(?:bash|sh|zsh|python|perl|ruby)/i, reason: 'Remote code execution via curl/wget pipe to shell', violation: 'disallowed-call' },
  // sudo (privilege escalation)
  { pattern: /\bsudo\b/i, reason: 'sudo — privilege escalation not allowed', violation: 'disallowed-call' },
  // Redirect to /dev/sd* (disk wipe)
  { pattern: /\/dev\/sd[a-z]/i, reason: 'Write to raw disk device (/dev/sd*)', violation: 'disallowed-call' },
  // dd to disk
  { pattern: /\bdd\s+.*\b(of|=)\s*\/dev\//i, reason: 'dd to device — disk-level write', violation: 'disallowed-call' },
  // mkfs (format filesystem)
  { pattern: /\bmkfs\b/i, reason: 'mkfs — filesystem format', violation: 'disallowed-call' },
  // shutdown / reboot / halt
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: 'System power control command', violation: 'disallowed-call' },
  // chmod 777 on /
  { pattern: /\bchmod\s+777\s+\//i, reason: 'chmod 777 on root directory', violation: 'disallowed-call' },
  // :(){ :|:& };: (fork bomb)
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork bomb detected', violation: 'disallowed-call' },
  // > /dev/null 2>&1 on critical paths (obfuscation pattern)
  { pattern: /\brm\s+.*>\s*\/dev\/null/i, reason: 'rm with output suppression — suspicious', violation: 'disallowed-call' },
];

export function validateShellCommand(command: string): ShellCommandValidationResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'Empty command', violation: 'runtime-error' };
  }

  for (const { pattern, reason, violation } of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason, violation };
    }
  }

  return { allowed: true };
}

// ── Traced execution helper ──────────────────────────────────────────────
// Convenience function that runs executeInSandbox AND records the full
// execution as a trace — used by the /api/sandbox/execute route and by the
// Operative Agent when validating 'evaluate' actions.

export async function executeInSandboxTraced(
  code: string,
  opts: SandboxOpts = {},
): Promise<{ result: SandboxResult; traceId: string }> {
  const traceId = uuid();
  startTrace({
    taskId: traceId,
    agentId: 'security-sandbox',
    domain: 'SECURITY',
    executionMode: 'single-shot',
    input: code.slice(0, 500),
  });

  addStep(traceId, {
    kind: 'code-exec',
    label: `sandbox.execute (memoryLimit=${opts.memoryLimitMB ?? 32}MB, timeout=${opts.timeoutMs ?? 30000}ms)`,
    input: { codePreview: code.slice(0, 200), memoryLimitMB: opts.memoryLimitMB ?? 32, timeoutMs: opts.timeoutMs ?? 30000 },
    meta: { sandbox: 'isolated-vm' },
  });

  const result = await executeInSandbox(code, opts);

  addStep(traceId, {
    kind: result.success ? 'done' : 'error',
    label: result.success
      ? `sandbox.execute → ok (${result.durationMs}ms, ${result.memoryUsedBytes ?? '?'} bytes used)`
      : `sandbox.execute → BLOCKED: ${result.violation} (${result.durationMs}ms)`,
    output: {
      success: result.success,
      violation: result.violation,
      errorMessage: result.errorMessage?.slice(0, 300),
      output: result.output,
      memoryUsedBytes: result.memoryUsedBytes,
    },
    durationMs: result.durationMs,
    meta: {
      sandbox: 'isolated-vm',
      success: result.success,
      violation: result.violation,
    },
  });

  addToolResult(traceId, {
    name: 'security-sandbox',
    args: { codePreview: code.slice(0, 100), memoryLimitMB: opts.memoryLimitMB ?? 32, timeoutMs: opts.timeoutMs ?? 30000 },
    result: result.success ? 'allowed' : `blocked: ${result.violation}`,
    success: result.success,
  });

  if (!result.success) {
    setOutcome(traceId, 'error', `sandbox blocked: ${result.violation}`);
  }
  completeTrace(traceId, result.success ? '(sandbox allowed)' : `(sandbox blocked: ${result.violation})`);

  return { result, traceId };
}
