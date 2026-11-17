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
//
// LAZY node-pty LOAD (resilience):
//   node-pty is a native C++ addon. It is NOT imported at module top-level —
//   this file (and therefore ws/server.ts and the whole server bootstrap) can
//   load even if the node-pty binary is missing or failed to compile. The
//   addon is loaded on first use via createRequire, and the result is cached.
//   If the load fails, isEnabled() reports false, disabledReason() returns a
//   clear message, and createSession() throws — but the rest of the server
//   (Express routes, WS auth, agents, voice) keeps working. The WS terminal
//   handler emits a 'terminal:disabled' event so the client can show why.

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
// Type-only import: the ambient declaration in src/types/node-pty.d.ts
// provides the shapes. No runtime module load happens at import time.
import type { IPty, IPtyForkOptions } from 'node-pty';

type PtyModule = typeof import('node-pty');

interface PtyLoaderResult {
  module: PtyModule | null;
  /** The error message if the native module failed to load, else null. */
  error: string | null;
}

/**
 * Build the default lazy loader for the node-pty native module.
 * The load is attempted at most once; the result (success or failure) is
 * cached so repeated isEnabled()/createSession() calls don't re-throw.
 */
function createDefaultPtyLoader(): () => PtyLoaderResult {
  let cached: PtyLoaderResult | null = null;
  return (): PtyLoaderResult => {
    if (cached) return cached;
    try {
      const req = createRequire(import.meta.url);
      const mod = req('node-pty') as PtyModule;
      if (!mod || typeof mod.spawn !== 'function') {
        cached = { module: null, error: 'node-pty loaded but spawn() is missing (corrupt install)' };
      } else {
        cached = { module: mod, error: null };
      }
    } catch (err) {
      cached = {
        module: null,
        error: (err as Error).message || 'node-pty native module failed to load',
      };
    }
    return cached;
  };
}

// The active loader. Tests swap this via __setPtyLoaderForTest to simulate
// node-pty being absent without uninstalling the package.
let ptyLoader: () => PtyLoaderResult = createDefaultPtyLoader();

/**
 * @internal Test-only hook: replace the node-pty loader. Pass `null` to
 * restore the default lazy loader. Used by the boot test to prove the
 * server keeps running when the native module is missing.
 */
export function __setPtyLoaderForTest(loader: (() => PtyLoaderResult) | null): void {
  ptyLoader = loader ?? createDefaultPtyLoader();
}

export interface PtySession {
  id: string;
  userId: string;
  cwd: string;
  process: IPty;
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

  /**
   * True only when the terminal is BOTH enabled by config AND backed by a
   * loadable node-pty native module. The WS gate reads this to decide
   * whether to accept terminal:create at all.
   */
  isEnabled(): boolean {
    if (!this.enabled) return false;
    return ptyLoader().module !== null;
  }

  /**
   * Returns a human-readable reason the terminal is unavailable, or null
   * when it is ready to use. Distinguishes "disabled by config" from
   * "node-pty native module missing/broken" so the client can show the
   * right message instead of a generic error.
   */
  disabledReason(): string | null {
    if (!this.enabled) {
      return 'Terminal is disabled (TERMINAL_ENABLED=false). Set TERMINAL_ENABLED=true on the server to enable it.';
    }
    const result = ptyLoader();
    if (result.module === null) {
      return `Terminal is unavailable: the node-pty native module could not be loaded (${result.error}). Rebuild the server image with python3/make/g++ present in the builder stage, or run without the terminal.`;
    }
    return null;
  }

  createSession(userId: string, cwd: string = process.cwd()): string {
    if (!this.enabled) {
      throw new Error('Terminal is disabled (TERMINAL_ENABLED=false).');
    }
    const mod = ptyLoader().module;
    if (!mod) {
      throw new Error(
        `Terminal unavailable: node-pty native module not loaded (${ptyLoader().error}). ` +
        'Rebuild with build tools present (python3, make, g++) or disable the terminal.',
      );
    }

    const id = uuid();
    const shell = process.env.SHELL || '/bin/bash';
    const args = shell.endsWith('zsh') ? ['-l'] : [];

    const options: IPtyForkOptions = {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: buildShellEnv(cwd),
    };
    const ptyProcess: IPty = mod.spawn(shell, args, options);

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
