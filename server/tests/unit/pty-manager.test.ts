// tests for the PTY terminal manager.
// Verifies:
//   1. createSession returns a session ID
//   2. writeInput executes safe commands (e.g. 'echo hello')
//   3. writeInput BLOCKS dangerous commands (e.g. 'rm -rf /')
//   4. writeInput BLOCKS shell metacharacters (e.g. 'echo hello | cat')
//   5. killSession cleans up the process
//   6. getSession enforces user ownership (user A can't access user B's session)

import { describe, it, expect, afterEach } from 'vitest';
import { ptyManager } from '../../src/terminal/pty-manager.js';

describe('PTY Terminal Manager', () => {
  const createdSessions: string[] = [];

  afterEach(() => {
    for (const id of createdSessions) {
      ptyManager.killSession(id);
    }
    createdSessions.length = 0;
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

  it('writeInput produces output for safe commands', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    // Write a safe command + Enter
    ptyManager.writeInput(id, 'echo hello-world');
    ptyManager.writeInput(id, '\r');

    // Wait for the shell to process
    await new Promise((r) => setTimeout(r, 500));

    ptyManager.off('output', handler);
    expect(output).toContain('hello-world');
  });

  it('writeInput BLOCKS dangerous commands (rm -rf)', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    // Write a dangerous command + Enter
    ptyManager.writeInput(id, 'rm -rf /');
    ptyManager.writeInput(id, '\r');

    await new Promise((r) => setTimeout(r, 300));

    ptyManager.off('output', handler);
    expect(output).toContain('Blocked');
    expect(output).not.toContain('cannot remove'); // the command didn't actually run
  });

  it('writeInput BLOCKS shell metacharacters (pipe)', async () => {
    const id = ptyManager.createSession('user-test');
    createdSessions.push(id);

    let output = '';
    const handler = (sessionId: string, _userId: string, data: string) => {
      if (sessionId === id) output += data;
    };
    ptyManager.on('output', handler);

    // Write a command with a pipe (shell metacharacter)
    ptyManager.writeInput(id, 'echo hello | cat');
    ptyManager.writeInput(id, '\r');

    await new Promise((r) => setTimeout(r, 300));

    ptyManager.off('output', handler);
    expect(output).toContain('Blocked');
  });

  it('killSession removes the session', () => {
    const id = ptyManager.createSession('user-test');
    ptyManager.killSession(id);

    const session = ptyManager.getSession(id, 'user-test');
    expect(session).toBeUndefined();
  });

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
