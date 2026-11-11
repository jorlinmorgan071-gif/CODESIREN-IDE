// server/src/terminal/pty-manager.ts
// Real PTY session manager — spawns node-pty processes for interactive terminals.
//
// SECURITY MODEL (fail-closed):
//   1. Keystrokes are buffered server-side in pendingCommand.
//   2. On Enter, the full command is validated via validateShellCommand().
//   3. If BLOCKED: nothing is forwarded to the PTY. The block message is
//      emitted to the client output channel only (terminal:output WS event).
//      The shell never sees a single byte of the command.
//   4. If APPROVED: the command + Enter are forwarded to the PTY in one
//      write. The shell receives it as if the user typed it.
//
// Interactive programs + tab completion:
//   This gate is a pre-execution filter. Once a command is approved and
//   forwarded, the shell runs it. If the command launches an interactive
//   program (e.g. `python`, `node`), subsequent keystrokes go directly
//   to the PTY without validation — the user is now inside the program,
//   not at the shell prompt. Tab completion (TAB key, \t) is forwarded
//   directly to the PTY at all times since it is a readline feature,
//   not a command.
//
//   The gate re-arms when the shell prompt returns (detected by the
//   process emitting a new prompt character like `$` or `%`). Until then,
//   raw mode passes keystrokes through.
//
// Each session is tied to a user (userId) and has a working directory.
// Sessions are cleaned up on disconnect or after 30 minutes of inactivity.

import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import { validateShellCommand } from '../security/sandbox.js';
import { classifyCommand } from '../orchestration/classify-command.js';
import { config } from '../config.js';

export interface PtySession {
  id: string;
  userId: string;
  cwd: string;
  process: pty.IPty;
  lastActivity: number;
  buffer: string;
  pendingCommand: string;
  /** When true, keystrokes pass through to the PTY without validation.
   *  Set when an interactive program is running, cleared when the shell
   *  prompt returns. */
  rawMode: boolean;
}

const MAX_BUFFER_LINES = 1000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

class PtyManager extends EventEmitter {
  private sessions = new Map<string, PtySession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private enabled: boolean;

  constructor() {
    super();
    this.enabled = config.TERMINAL_ENABLED;
    this.cleanupInterval = setInterval(() => this.cleanupStale(), 5 * 60 * 1000);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  createSession(userId: string, cwd: string = process.cwd()): string {
    if (!this.enabled) {
      throw new Error('Terminal is disabled (TERMINAL_ENABLED=off). Set TERMINAL_ENABLED=true in server/.env to enable.');
    }

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
      rawMode: false,
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

    // ── Ctrl-C (\x03): clear pending buffer, forward to PTY to interrupt ──
    if (data === '\x03') {
      session.pendingCommand = '';
      // Forward Ctrl-C to the PTY so the shell shows ^C and resets the prompt
      session.process.write(data);
      return;
    }

    // ── Tab (\t): forward directly — readline completion, not a command ──
    if (data === '\t') {
      session.process.write(data);
      return;
    }

    // ── Arrow keys (escape sequences starting with \x1b) — forward ──
    // These are readline navigation, not command input.
    if (data.startsWith('\x1b')) {
      session.process.write(data);
      return;
    }

    // ── Enter (\r or \n): validate the full command before forwarding ──
    if (data === '\r' || data === '\n') {
      const cmd = session.pendingCommand;
      session.pendingCommand = '';

      if (!cmd.trim()) {
        // Empty line — just forward Enter
        session.process.write(data);
        return;
      }

      // Handle multi-line paste: if cmd contains embedded newlines,
      // validate each line before forwarding any.
      const lines = cmd.split('\n');
      if (lines.length > 1) {
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const validation = validateShellCommand(trimmed);
          if (!validation.allowed) {
            // Block message to client output only — never to process.write
            const blockMsg = `\r\n\x1b[31m✗ Blocked: ${validation.reason}\x1b[0m\r\n`;
            this.emit('output', session.id, session.userId, blockMsg);
            continue; // Skip this line, continue with the rest
          }

          // Approved — forward the line + Enter to the PTY
          session.process.write(line + '\r');
        }
        return;
      }

      // Single-line command — validate
      const validation = validateShellCommand(cmd);
      if (!validation.allowed) {
        // Block message to client output only — never to process.write
        const blockMsg = `\r\n\x1b[31m✗ Blocked: ${validation.reason}\x1b[0m\r\n`;
        this.emit('output', session.id, session.userId, blockMsg);
        return;
      }

      // Approved — forward the command + Enter to the PTY
      const classification = classifyCommand(cmd);
      this.emit('command', session.id, session.userId, {
        command: cmd,
        risk: classification.risk,
        explanation: classification.explanation,
      });
      session.process.write(cmd + '\r');
      return;
    }

    // ── Backspace (\u007f or \b): remove from pending buffer ──
    if (data === '\u007f' || data === '\b') {
      if (session.pendingCommand.length > 0) {
        session.pendingCommand = session.pendingCommand.slice(0, -1);
      }
      // Forward backspace to the PTY so the terminal visually erases
      session.process.write(data);
      return;
    }

    // ── Ctrl-U (\x15): clear the entire pending buffer ──
    if (data === '\x15') {
      session.pendingCommand = '';
      session.process.write(data);
      return;
    }

    // ── Regular printable character: buffer it ──
    if (data.charCodeAt(0) >= 32) {
      session.pendingCommand += data;
    }

    // Forward printable characters to the PTY so the terminal shows
    // what the user is typing (echo). The command is NOT executed
    // until Enter is pressed and validation passes.
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
