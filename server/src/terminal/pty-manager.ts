// server/src/terminal/pty-manager.ts
// Real PTY session manager — spawns node-pty processes for interactive terminals.
//
// SECURITY MODEL:
//   The terminal is a REAL shell — keystrokes go to the PTY raw, with no
//   server-side filtering. This is by design: the terminal is a user-facing
//   shell, like opening a terminal in VS Code. The user is authenticated
//   and operates in their own workspace.
//
//   AI AGENTS that need to run shell commands do NOT use this PTY. They use
//   the workflow-runner's runShellCommand() which enforces
//   validateShellCommand() + the approval gate. The terminal is for the
//   human user; the agent path is separate and gated.
//
// ENVIRONMENT:
//   The shell is spawned with an allowlisted env only (PATH, HOME, TERM, LANG).
//   No JWT_SECRET, no API keys, no server-internal secrets leak to the shell.
//
// TERMINAL_ENABLED:
//   - Development: default ON
//   - Production: default OFF — must explicitly set TERMINAL_ENABLED=true
//   If disabled, createSession() throws and the WS handler returns an error.

import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';

export interface PtySession {
  id: string;
  userId: string;
  cwd: string;
  process: pty.IPty;
  lastActivity: number;
  buffer: string;
}

const MAX_BUFFER_LINES = 1000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** Allowlisted environment variables for the shell.
 *  Only these are passed to the PTY — no JWT_SECRET, no API keys. */
function buildShellEnv(cwd: string): Record<string, string> {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',
    SHELL: process.env.SHELL || '/bin/bash',
    PWD: cwd,
  };
}

class PtyManager extends EventEmitter {
  private sessions = new Map<string, PtySession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private enabled: boolean;

  constructor() {
    super();
    this.enabled = config.TERMINAL_ENABLED;
    if (this.enabled && config.isProd) {
      console.warn('[terminal] WARNING: Terminal is enabled in production mode. This allows authenticated users to run arbitrary shell commands. Ensure this is intentional.');
    }
    this.cleanupInterval = setInterval(() => this.cleanupStale(), 5 * 60 * 1000);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  createSession(userId: string, cwd: string = process.cwd()): string {
    if (!this.enabled) {
      throw new Error('Terminal is disabled (TERMINAL_ENABLED=false).');
    }

    const id = uuid();
    const shell = process.env.SHELL || '/bin/bash';
    const args = shell.endsWith('zsh') ? ['-l'] : [];

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: buildShellEnv(cwd),
    });

    const session: PtySession = {
      id,
      userId,
      cwd,
      process: ptyProcess,
      lastActivity: Date.now(),
      buffer: '',
    };

    ptyProcess.onData((data: string) => {
      session.lastActivity = Date.now();
      session.buffer += data;
      const lines = session.buffer.split('\n');
      if (lines.length > MAX_BUFFER_LINES) {
        session.buffer = lines.slice(-MAX_BUFFER_LINES).join('\n');
      }
      this.emit('output', id, userId, data);
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      this.emit('exit', id, userId, exitCode);
      this.sessions.delete(id);
    });

    this.sessions.set(id, session);
    return id;
  }

  /**
   * Forward raw keystrokes to the PTY. No server-side filtering — the
   * terminal is a real shell for the authenticated human user.
   *
   * AI agents that need to run commands use runShellCommand() in
   * workflow-runner.ts, which enforces validateShellCommand() + the
   * approval gate. This path is NOT used by agents.
   */
  writeInput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastActivity = Date.now();
    session.process.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      session.process.resize(cols, rows);
    } catch {
      // ignore resize errors
    }
  }

  getBuffer(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    return session?.buffer ?? '';
  }

  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      session.process.kill();
    } catch {
      // already dead
    }
    this.sessions.delete(sessionId);
  }

  killUserSessions(userId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) {
        this.killSession(id);
      }
    }
  }

  getSession(sessionId: string, userId: string): PtySession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return undefined;
    return session;
  }

  private cleanupStale(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        this.killSession(id);
      }
    }
  }
}

export const ptyManager = new PtyManager();
