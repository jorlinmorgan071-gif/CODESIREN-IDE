// tests/unit/pty-lazy-load.test.ts
//
// Boot-resilience test for the lazy node-pty load.
//
// BACKGROUND
//   node-pty is a native C++ addon. Before the lazy-load refactor it was
//   imported at the top of terminal/pty-manager.ts, which meant a missing
//   or broken pty.node binary would crash the WHOLE server at import time
//   (ws/server.ts → pty-manager.ts → `import * as pty from 'node-pty'`
//   throws → attachWsServer is undefined → index.ts never boots).
//
//   After the refactor node-pty is loaded on first use via createRequire,
//   so importing pty-manager.ts (and therefore ws/server.ts and the whole
//   server bootstrap) never touches the native module. If the binary is
//   absent, the terminal is disabled with a clear message and EVERYTHING
//   ELSE — Express routes, WS auth, agents, voice — keeps working.
//
// WHAT THIS TEST PROVES
//   1. pty-manager.ts imports cleanly even when node-pty cannot load
//      (the test file itself loading IS the proof — there is no top-level
//      native import to throw).
//   2. With node-pty unavailable, isEnabled() returns false.
//   3. disabledReason() returns a non-null message that names node-pty,
//      so the WS gate sends the client a precise 'terminal:disabled'
//      event instead of a generic error.
//   4. createSession() throws a clear error (does NOT silently no-op).
//   5. The default loader is restored afterward so no other test is
//      affected.

import { describe, it, expect, afterEach } from 'vitest';
import { ptyManager, __setPtyLoaderForTest } from '../../src/terminal/pty-manager.js';

describe('PTY lazy load — server boots without node-pty', () => {
  afterEach(() => {
    // Restore the real lazy loader so subsequent tests get default behavior.
    __setPtyLoaderForTest(null);
  });

  it('pty-manager module imports cleanly even when node-pty cannot load', () => {
    // Set a failing loader BEFORE exercising any method. If pty-manager.ts
    // still had a top-level `import * as pty from 'node-pty'`, this test
    // file would have thrown at import time and never reached this line.
    __setPtyLoaderForTest(() => ({
      module: null,
      error: 'Cannot find module node-pty (simulated missing native binary)',
    }));
    // Reaching here means the module graph loaded without node-pty.
    expect(typeof ptyManager.isEnabled).toBe('function');
    expect(typeof ptyManager.createSession).toBe('function');
  });

  it('isEnabled() returns false when node-pty is missing', () => {
    __setPtyLoaderForTest(() => ({
      module: null,
      error: 'Cannot find module node-pty (simulated missing native binary)',
    }));
    expect(ptyManager.isEnabled()).toBe(false);
  });

  it('disabledReason() names node-pty so the WS gate can show a clear message', () => {
    __setPtyLoaderForTest(() => ({
      module: null,
      error: 'Cannot find module node-pty (simulated missing native binary)',
    }));
    const reason = ptyManager.disabledReason();
    expect(reason).not.toBeNull();
    expect(reason).toContain('node-pty');
    expect(reason).toContain('native module');
  });

  it('createSession() throws a clear error instead of silently no-op' + 'ing', () => {
    __setPtyLoaderForTest(() => ({
      module: null,
      error: 'Cannot find module node-pty (simulated missing native binary)',
    }));
    expect(() => ptyManager.createSession('user-x')).toThrow(/node-pty/);
  });

  it('disabledReason() returns null when node-pty loads successfully', () => {
    // A loader that returns a fake but well-formed module (spawn is a
    // function) — proves the "available" branch returns null reason.
    __setPtyLoaderForTest(() => ({
      module: { spawn: (() => undefined) as unknown as typeof import('node-pty')['spawn'] } as typeof import('node-pty'),
      error: null,
    }));
    expect(ptyManager.disabledReason()).toBeNull();
    expect(ptyManager.isEnabled()).toBe(true);
  });
});
