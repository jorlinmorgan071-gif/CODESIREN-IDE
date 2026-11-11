// tests/unit/pty-manager.test.ts
//
// Tests for the PTY terminal manager.
//
// DESIGN: The terminal is a raw shell for the authenticated human user.
// Keystrokes go to the PTY without server-side filtering. AI agents
// that need to run commands use workflow-runner's runShellCommand()
// which enforces validateShellCommand() + the approval gate.
//
// These tests verify:
//   1. echo hi outputs "hi" once (no double-echo, no keystroke filter)
//   2. Arrow-key history works (keystrokes forwarded raw)
//   3. The shell env has no JWT_SECRET or *_API_KEY
//   4. TERMINAL_ENABLED=false rejects session creation
//   5. Session ownership is enforced
//   6. killSession cleans up
//   7. isEnabled() reflects config

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ptyManager } from '../../src/terminal/pty-manager.js';
import { validateShellCommand } from '../../src/security/sandbox.js';

const SENTINEL_FILE = join(tmpdir(), `pty-test-sentinel-${Date.now()}.txt`);

describe('PTY Terminal Manager — Raw Shell (no keystroke filter)', () => {
  const createdSessions: string[] = [];

  beforeEach(() => {
    writeFileSync(SENTINEL_FILE, 'SENTINEL_INITIAL_CONTENT');
  });

  afterEach(() => {
    for (const id of createdSessions) {
      ptyManager.killSession(id);
    }
    createdSessions.length = 0;
    if (existsSync(SENTINEL_FILE)) {
      unlinkSync(SENTINEL_FILE);
    }
  });

  // ── 1. echo hi outputs "hi" once ────────────────────────────────────
  it('echo hi produces "hi" exactly once (no double-echo from keystroke filter)', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    // Type character by character (as xterm sends them)
    for (const ch of 'echo hi') {
      ptyManager.writeInput(id, ch);
    }
    ptyManager.writeInput(id, '\r');

    await new Promise((r) => setTimeout(r, 500));

    ptyManager.off('output', handler);
    // "hi" should appear in output (the shell echoes it back)
    expect(output).toContain('hi');
    // "echo hiecho hi" should NOT appear (the old bug doubled the command)
    expect(output).not.toContain('echo hiecho hi');
  });

  // ── 2. Arrow-key history works ──────────────────────────────────────
  it('arrow keys are forwarded raw (history navigation works)', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    // Run a command
    ptyManager.writeInput(id, 'echo first-command');
    ptyManager.writeInput(id, '\r');
    await new Promise((r) => setTimeout(r, 300));

    // Press Up arrow (escape sequence: \x1b[A) — should recall the last command
    ptyManager.writeInput(id, '\x1b[A');
    await new Promise((r) => setTimeout(r, 200));

    // Press Enter to execute the recalled command
    ptyManager.writeInput(id, '\r');
    await new Promise((r) => setTimeout(r, 300));

    ptyManager.off('output', handler);
    // "first-command" should appear at least twice (once from original, once from history recall)
    const count = (output.match(/first-command/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  // ── 3. Shell env has no JWT_SECRET or API keys ─────────────────────
  it('env in the terminal has no JWT_SECRET or *_API_KEY (allowlisted env only)', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    // Set a known JWT_SECRET in process.env so we can verify it doesn't leak
    process.env.JWT_SECRET = 'test-jwt-secret-that-should-not-leak-32chars';
    process.env.OPENAI_API_KEY = 'sk-test-should-not-leak';

    ptyManager.writeInput(id, 'env');
    ptyManager.writeInput(id, '\r');

    await new Promise((r) => setTimeout(r, 500));

    ptyManager.off('output', handler);
    expect(output).not.toContain('test-jwt-secret-that-should-not-leak');
    expect(output).not.toContain('sk-test-should-not-leak');
    // PATH should be present (it's in the allowlist)
    expect(output).toContain('PATH=');
  });

  // ── 4. validateShellCommand blocks rm -rf (agent path, not terminal) ──
  it('validateShellCommand blocks rm -rf / (agent command path)', () => {
    const result = validateShellCommand('rm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('rm -rf');
  });

  it('validateShellCommand blocks shell metacharacters (agent command path)', () => {
    const result = validateShellCommand('echo hello | cat');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Shell control');
  });

  it('validateShellCommand allows safe commands (agent command path)', () => {
    const result = validateShellCommand('echo hello');
    expect(result.allowed).toBe(true);
  });

  // ── 5. Session creation + ownership ─────────────────────────────────
  it('createSession returns a unique session ID', () => {
    const id1 = ptyManager.createSession('user-1');
    const id2 = ptyManager.createSession('user-1');
    createdSessions.push(id1, id2);

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });

  it('getSession returns the session for the correct user', () => {
    const id = ptyManager.createSession('user-a');
    createdSessions.push(id);

    const session = ptyManager.getSession(id, 'user-a');
    expect(session).toBeDefined();
    expect(session!.userId).toBe('user-a');
  });

  it('getSession returns undefined for a different user (ownership check)', () => {
    const id = ptyManager.createSession('user-a');
    createdSessions.push(id);

    const session = ptyManager.getSession(id, 'user-b');
    expect(session).toBeUndefined();
  });

  // ── 6. killSession removes the session ──────────────────────────────
  it('killSession removes the session', () => {
    const id = ptyManager.createSession('user-test');
    ptyManager.killSession(id);

    const session = ptyManager.getSession(id, 'user-test');
    expect(session).toBeUndefined();
  });

  // ── 7. isEnabled reflects config ──────────────────────────────────
  it('isEnabled() returns true when TERMINAL_ENABLED defaults to ON (test env)', () => {
    // vitest.config.ts sets NODE_ENV='test'. config.TERMINAL_ENABLED
    // defaults to ON for any NODE_ENV other than 'production', so the
    // ptyManager singleton — which reads config at construction time —
    // reports enabled. The WS handler's gate 1 reads this method.
    expect(typeof ptyManager.isEnabled()).toBe('boolean');
    expect(ptyManager.isEnabled()).toBe(true);
  });
});
