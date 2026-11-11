// tests for the PTY terminal manager.
//
// SECURITY GATE TESTS:
//   1. Sentinel file: a blocked command must leave the file untouched.
//   2. Multi-line paste with embedded newline: blocked line doesn't run.
//   3. An allowed command still runs (echo produces output).
//   4. Ctrl-C clears the pending buffer.
//   5. getSession enforces user ownership.
//   6. createSession returns unique IDs.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ptyManager } from '../../src/terminal/pty-manager.js';

const SENTINEL_FILE = join(tmpdir(), `pty-test-sentinel-${Date.now()}.txt`);

describe('PTY Terminal Manager — Security Gate', () => {
  const createdSessions: string[] = [];

  beforeEach(() => {
    // Create a fresh sentinel file before each test
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
    expect(session!.id).toBe(id);
    expect(session!.userId).toBe('user-a');
  });

  it('getSession returns undefined for a different user (ownership check)', () => {
    const id = ptyManager.createSession('user-a');
    createdSessions.push(id);

    const session = ptyManager.getSession(id, 'user-b');
    expect(session).toBeUndefined();
  });

  // ── TEST 1: Sentinel file — blocked command must NOT run ────────────
  it('BLOCKED command (rm -rf /) does NOT delete the sentinel file', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    // rm -rf / is explicitly in BLOCKED_SHELL_PATTERNS
    ptyManager.writeInput(id, 'rm -rf /');
    ptyManager.writeInput(id, '\r');

    // Wait for any shell processing
    await new Promise((r) => setTimeout(r, 500));

    // The sentinel file must still exist with its original content
    expect(existsSync(SENTINEL_FILE)).toBe(true);
    expect(readFileSync(SENTINEL_FILE, 'utf-8')).toBe('SENTINEL_INITIAL_CONTENT');
  });

  // ── TEST 2: Blocked command with dangerous pattern ──────────────────
  it('BLOCKED command (rm -rf /) does not reach the shell', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    ptyManager.writeInput(id, 'rm -rf /');
    ptyManager.writeInput(id, '\r');

    await new Promise((r) => setTimeout(r, 300));

    ptyManager.off('output', handler);
    // Block message should appear in client output
    expect(output).toContain('Blocked');
    // The shell should NOT show 'cannot remove' or 'Operation not permitted'
    expect(output).not.toContain('cannot remove');
    expect(output).not.toContain('Operation not permitted');
  });

  // ── TEST 3: Multi-line paste with embedded newline ───────────────────
  it('multi-line paste: blocked line does not run, allowed line does', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    // Simulate a paste: "echo ok\nrm -rf /" typed as one pending command
    // with an embedded newline
    ptyManager.writeInput(id, 'echo ok');
    ptyManager.writeInput(id, '\n');  // embedded newline (part of paste)
    ptyManager.writeInput(id, 'rm -rf /');
    ptyManager.writeInput(id, '\r');  // Enter to submit

    await new Promise((r) => setTimeout(r, 500));

    ptyManager.off('output', handler);

    // "echo ok" should produce "ok" in output
    expect(output).toContain('ok');
    // The rm -rf / command should be blocked
    expect(output).toContain('Blocked');
    // Sentinel file must still exist
    expect(existsSync(SENTINEL_FILE)).toBe(true);
    expect(readFileSync(SENTINEL_FILE, 'utf-8')).toBe('SENTINEL_INITIAL_CONTENT');
  });

  // ── TEST 4: Allowed command still runs ──────────────────────────────
  it('ALLOWED command (echo) produces output', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    ptyManager.writeInput(id, 'echo hello-world');
    ptyManager.writeInput(id, '\r');

    await new Promise((r) => setTimeout(r, 500));

    ptyManager.off('output', handler);
    expect(output).toContain('hello-world');
  });

  // ── TEST 5: Ctrl-C clears the pending buffer ────────────────────────
  it('Ctrl-C clears the pending command buffer', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    // Type a dangerous command but DON'T press Enter
    ptyManager.writeInput(id, 'rm -rf /');
    // Press Ctrl-C instead of Enter
    ptyManager.writeInput(id, '\x03');
    // Now type a safe command + Enter
    ptyManager.writeInput(id, 'echo safe-command');
    ptyManager.writeInput(id, '\r');

    await new Promise((r) => setTimeout(r, 500));

    ptyManager.off('output', handler);

    // The safe command should have run
    expect(output).toContain('safe-command');
    // The dangerous command should NOT have been executed (no "Blocked"
    // message because it was never submitted)
    expect(output).not.toContain('cannot remove');
  });

  // ── TEST 6: Shell metacharacters blocked ────────────────────────────
  it('BLOCKS shell metacharacters (pipe)', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    ptyManager.writeInput(id, 'echo hello | cat');
    ptyManager.writeInput(id, '\r');

    await new Promise((r) => setTimeout(r, 300));

    ptyManager.off('output', handler);
    expect(output).toContain('Blocked');
  });

  // ── TEST 7: killSession removes the session ─────────────────────────
  it('killSession removes the session', () => {
    const id = ptyManager.createSession('user-test');
    ptyManager.killSession(id);

    const session = ptyManager.getSession(id, 'user-test');
    expect(session).toBeUndefined();
  });

  // ── TEST 8: command events for safe commands ────────────────────────
  it('emits command events for safe commands', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let commandEvent: { command: string; risk: string } | null = null;
    const handler = (_sessionId: string, _userId: string, info: { command: string; risk: string }) => {
      commandEvent = info;
    };
    ptyManager.on('command', handler);

    ptyManager.writeInput(id, 'ls -la');
    ptyManager.writeInput(id, '\r');

    await new Promise((r) => setTimeout(r, 300));

    ptyManager.off('command', handler);
    expect(commandEvent).not.toBeNull();
    expect(commandEvent!.command).toBe('ls -la');
  });
});
