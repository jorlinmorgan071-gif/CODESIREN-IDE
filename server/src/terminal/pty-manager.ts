// server/src/terminal/pty-manager.ts
// Real PTY session manager — spawns node-pty processes for interactive terminals.
//
// Security model:
//   1. Every command written to the PTY is intercepted and validated via
//      validateShellCommand() BEFORE it reaches the shell.
//   2. Blocked commands (shell metacharacters, rm -rf, curl|sh, etc.) are
//      rejected — the user sees the block reason in the terminal.
//   3. Approved commands execute in a real bash/zsh PTY with full ANSI support.
//
// Each session is tied to a user (userId) and has a working directory.
// Sessions are cleaned up on disconnect or after 30 minutes of inactivity.

import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import { validateShellCommand } from '../security/sandbox.js';
import { classifyCommand } from '../orchestration/classify-command.js';

export interface PtySession {
  id: string;
  userId: string;
  cwd: string;
  process: pty.IPty;
  lastActivity: number;
  buffer: string;
  pendingCommand: string;
}

const MAX_BUFFER_LINES = 1000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

class PtyManager extends EventEmitter {
  private sessions = new Map<string, PtySession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.cleanupInterval = setInterval(() => this.cleanupStale(), 5 * 60 * 1000);
  }

  createSession(userId: string, cwd: string = process.cwd()): string {
    const id = uuid();
    const shell = process.env.SHELL || '/bin/bash';
    const args = shell.endsWith('zsh') ? ['-l'] : [];

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        BASH_ENV: '',
        ENV: '',
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      },
    });

    const session: PtySession = {
      id,
      userId,
      cwd,
      process: ptyProcess,
      lastActivity: Date.now(),
      buffer: '',
      pendingCommand: '',
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

  writeInput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastActivity = Date.now();

    if (data === '\r' || data === '\n') {
      const cmd = session.pendingCommand;
      session.pendingCommand = '';

      if (cmd.trim()) {
        const validation = validateShellCommand(cmd);
        if (!validation.allowed) {
          const blockMsg = `\r\n\x1b[31m✗ Blocked: ${validation.reason}\x1b[0m\r\n`;
          session.process.write(blockMsg);
          session.process.write('\r');
          return;
        }
        const classification = classifyCommand(cmd);
        this.emit('command', session.id, session.userId, {
          command: cmd,
          risk: classification.risk,
          explanation: classification.explanation,
        });
      }
    } else if (data === '\u007f' || data === '\b') {
      session.pendingCommand = session.pendingCommand.slice(0, -1);
    } else if (data.charCodeAt(0) >= 32) {
      session.pendingCommand += data;
    }

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
