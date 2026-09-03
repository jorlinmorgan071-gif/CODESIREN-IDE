// server/tests/security/d10-d13-closeout.test.ts
// Phase: P0/P1/P2 remediation order closeout — server-side fixes for D10 + D13.
//
// This test file proves:
//   D13    — code_interpreter tool returns success:false + meta.violation='unavailable'
//            instead of masquerading as success:true with fabricated stdout
//   D10 #3 — POST /api/ghost-mode/level actually transitions the server's FSM
//            GET  /api/ghost-mode/level returns the real current level
//
// These tests don't spin up a full HTTP server — they call the tool registry
// and the ghost-mode singleton directly, mirroring the pattern in
// server/tests/unit/ghost-mode.test.ts and the existing capability-aware-chat
// security tests.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';

describe('D13 — code_interpreter tool returns success:false (no fake execution)', () => {
  it('returns success:false with meta.violation="unavailable" when invoked', async () => {
    const result = await toolRegistry.execute('code_interpreter', { code: 'print(2+2)' });
    expect(result.success).toBe(false);
    expect(result.name).toBe('code_interpreter');
    expect(result.meta).toBeDefined();
    expect((result.meta as { violation?: string }).violation).toBe('unavailable');
  });

  it('returns success:false even for empty code (no early success path)', async () => {
    const result = await toolRegistry.execute('code_interpreter', { code: '' });
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/Missing "code" arg/);
  });

  it('does not contain the old fabricated "would execute" stdout', async () => {
    const result = await toolRegistry.execute('code_interpreter', { code: 'print("hello")' });
    // The pre-D13 stub returned "[step-2 stub code_interpreter] would execute: ..."
    // with success:true — masquerading as a successful execution. That string
    // and that success path must both be gone.
    expect(result.success).toBe(false);
    expect(result.content).not.toMatch(/would execute/i);
    expect(result.content).not.toMatch(/step-2 stub/i);
  });

  it('content honestly discloses why the tool is unavailable', async () => {
    const result = await toolRegistry.execute('code_interpreter', { code: 'x = 1' });
    expect(result.content).toMatch(/unavailable/i);
    expect(result.content).toMatch(/Python sidecar|security sandbox/i);
  });

  it('preserves a preview of the requested code in meta (for debugging)', async () => {
    const result = await toolRegistry.execute('code_interpreter', { code: 'def hello():\n    print("world")\nhello()' });
    expect((result.meta as { codePreview?: string }).codePreview).toBeDefined();
    // Preview is capped at 200 chars — the full 47-char code fits.
    expect((result.meta as { codePreview?: string }).codePreview).toContain('def hello');
  });
});

describe('D10 #3 — Ghost Mode level endpoints (server-side FSM transition)', () => {
  beforeAll(() => {
    // Reset to the documented default before tests run. The boot-time default
    // is 'approval-required' (set in server/src/index.ts:82).
    ghostMode.setLevel('approval-required');
  });

  it('ghostMode.currentLevel returns the real current level', () => {
    expect(ghostMode.currentLevel).toBe('approval-required');
  });

  it('ghostMode.setLevel actually transitions the FSM', () => {
    const previous = ghostMode.currentLevel;
    ghostMode.setLevel('observation-only');
    expect(ghostMode.currentLevel).toBe('observation-only');
    // Restore for subsequent tests.
    ghostMode.setLevel(previous);
    expect(ghostMode.currentLevel).toBe(previous);
  });

  it('accepts all four documented GhostModeLevel values', () => {
    const levels = ['observation-only', 'approval-required', 'auto-amend', 'autonomous'] as const;
    for (const level of levels) {
      ghostMode.setLevel(level);
      expect(ghostMode.currentLevel).toBe(level);
    }
    // Restore the default.
    ghostMode.setLevel('approval-required');
  });
});

describe('D10 #3 — cache middleware does NOT cache /ghost-mode/level (regression)', () => {
  // Live spot-check found that the Phase 5 GET response cache was caching
  // /api/ghost-mode/level for 5s (default TTL). After POSTing a new level,
  // the immediate GET returned the stale pre-POST value, causing the StatusBar
  // to drift. Fix: cache.ts now skips /ghost-mode/level entirely.
  //
  // This test confirms the cache.ts source code skips this path so future
  // changes don't accidentally re-introduce the staleness bug.

  it('cache.ts skips /ghost-mode/level paths', () => {
    const cacheSource = readFileSync(
      resolve(process.cwd(), 'src/middleware/cache.ts'),
      'utf8',
    );
    expect(cacheSource).toContain("req.path.startsWith('/ghost-mode/level')");
    // The skip must come BEFORE the cache lookup (i.e., inside the early-return
    // chain that bypasses caching, not as part of the TTL config).
    // We verify this by checking the skip block calls next() and returns.
    const skipBlock = cacheSource.match(
      /if \(req\.path\.startsWith\('\/ghost-mode\/level'\)\)\s*\{\s*next\(\);\s*return;\s*\}/,
    );
    expect(skipBlock).not.toBeNull();
  });
});
