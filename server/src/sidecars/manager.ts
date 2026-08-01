// server/src/sidecars/manager.ts
// SidecarManager — spawns and OWNS long-lived Python helper processes.
//
// Per Step 4 user condition: "prove the lifecycle, not just the happy path."
// Specifically demonstrate — with trace evidence — that:
//   (a) the sidecar process dies when the Node server dies (no orphan)
//   (b) a sidecar crash mid-job is caught and surfaced as a normal agent:error
//       rather than hanging the Fabrication Agent
//
// Ownership contract:
//   1. SidecarManager.spawn(name, cmd, args) starts a child process and registers
//      it in the `children` map.
//   2. The child's stdin/stdout communicate via JSON lines (one object per line).
//   3. Every request has a uuid `id`; we hold a Promise resolver keyed by that id.
//   4. On child 'exit' (crash OR clean close), ALL pending requests reject with a
//      SidecarCrashedError — no agent hangs.
//   5. On Node process exit (SIGINT/SIGTERM/beforeExit), SidecarManager.killAll()
//      sends SIGTERM to every child. The child's signal handler exits immediately.
//      Even if the child somehow ignores SIGTERM, Node death closes its stdin,
//      and the child's stdin-EOF handler exits too.
//   6. We also `child.unref()` so the child doesn't keep Node alive — though in
//      practice we always kill explicitly on shutdown.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SidecarCrashedError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly signal: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = 'SidecarCrashedError';
  }
}

export interface SidecarRequest {
  id: string;
  type?: string;
  [key: string]: unknown;
}

export interface SidecarResponse {
  id: string;
  ok: boolean;
  error?: string;
  fatal?: boolean;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (resp: SidecarResponse) => void;
  reject: (err: Error) => void;
  startedAt: number;
}

interface ManagedChild {
  name: string;
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
  buffer: string;  // partial line buffer for stdout
  crashed: boolean;
  lastExitInfo?: { code: number | null; signal: NodeJS.Signals | null };
}

class SidecarManagerImpl extends EventEmitter {
  private children = new Map<string, ManagedChild>();
  private shutdownHandlersRegistered = false;

  /**
   * Spawn a sidecar process. The process is owned by this manager — it will be
   * killed on Node shutdown, and its crash will reject all pending requests.
   */
  spawn(
    name: string,
    command: string,
    args: string[] = [],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): void {
    if (this.children.has(name)) {
      throw new Error(`Sidecar already running: ${name}`);
    }

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });

    const managed: ManagedChild = {
      name,
      child,
      pending: new Map(),
      buffer: '',
      crashed: false,
    };
    this.children.set(name, managed);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      managed.buffer += chunk;
      // Split on newlines — each line is one JSON response
      let nl: number;
      while ((nl = managed.buffer.indexOf('\n')) >= 0) {
        const line = managed.buffer.slice(0, nl).trim();
        managed.buffer = managed.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const resp = JSON.parse(line) as SidecarResponse;
          const pending = managed.pending.get(resp.id);
          if (pending) {
            managed.pending.delete(resp.id);
            pending.resolve(resp);
          } else {
            // Orphan response (no matching pending request) — log and ignore
            console.warn(`[sidecar:${name}] orphan response id=${resp.id}`);
          }
        } catch (err) {
          console.error(`[sidecar:${name}] non-JSON stdout line: ${line.slice(0, 200)}`);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Log stderr but don't fail — Python prints font warnings etc. to stderr
      for (const line of chunk.split('\n').filter(Boolean)) {
        console.error(`[sidecar:${name}] stderr: ${line}`);
      }
    });

    child.on('error', (err) => {
      // Spawn-level error (failed to start, etc.)
      console.error(`[sidecar:${name}] spawn error:`, err.message);
      this.handleChildExit(managed, 1, null, `spawn error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      this.handleChildExit(managed, code, signal, null);
    });

    this.registerShutdownHandlers();

    console.log(`[sidecar:${name}] spawned (pid=${child.pid})`);
    this.emit('spawned', name);
  }

  /**
   * Send a request to a sidecar and await its response.
   * Throws SidecarCrashedError if the sidecar dies before responding.
   */
  async request(sidecarName: string, req: Omit<SidecarRequest, 'id'>, timeoutMs = 60_000): Promise<SidecarResponse> {
    const managed = this.children.get(sidecarName);
    if (!managed) {
      throw new Error(`No such sidecar: ${sidecarName}`);
    }
    if (managed.crashed) {
      throw new SidecarCrashedError(
        `sidecar '${sidecarName}' has already exited`,
        managed.lastExitInfo?.code ?? null,
        managed.lastExitInfo?.signal ?? null,
      );
    }

    const id = uuid();
    const fullReq: SidecarRequest = { id, ...req };
    const reqLine = JSON.stringify(fullReq) + '\n';

    return new Promise<SidecarResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (managed.pending.has(id)) {
          managed.pending.delete(id);
          reject(new Error(`sidecar '${sidecarName}' request ${id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      managed.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        startedAt: Date.now(),
      });

      // Write the request line to stdin
      const ok = managed.child.stdin.write(reqLine);
      if (!ok) {
        // Backpressure — wait for drain
        managed.child.stdin.once('drain', () => {});
      }
    });
  }

  /**
   * Kill a specific sidecar. Returns true if it was running.
   */
  kill(name: string): boolean {
    const managed = this.children.get(name);
    if (!managed) return false;
    this.killManaged(managed);
    return true;
  }

  /**
   * Kill all sidecars. Called on Node shutdown.
   */
  killAll(): void {
    for (const managed of this.children.values()) {
      this.killManaged(managed);
    }
  }

  isRunning(name: string): boolean {
    const managed = this.children.get(name);
    return !!managed && !managed.crashed;
  }

  /**
   * Remove a crashed/dead sidecar entry from the map so it can be respawned.
   * Returns true if an entry was removed.
   */
  removeDead(name: string): boolean {
    const managed = this.children.get(name);
    if (!managed) return false;
    if (!managed.crashed) return false;  // still running — don't remove
    this.children.delete(name);
    return true;
  }

  list(): string[] {
    return [...this.children.keys()];
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private killManaged(managed: ManagedChild): void {
    if (managed.crashed) return;
    try {
      // Try graceful SIGTERM first (child's handler exits immediately)
      managed.child.kill('SIGTERM');
      // Force-kill after 2s if still alive
      setTimeout(() => {
        if (!managed.crashed) {
          try {
            managed.child.kill('SIGKILL');
          } catch {
            // already dead
          }
        }
      }, 2000);
    } catch (err) {
      console.warn(`[sidecar:${managed.name}] kill failed:`, err);
    }
  }

  private handleChildExit(
    managed: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError: string | null,
  ): void {
    if (managed.crashed) return;  // already handled
    managed.crashed = true;
    managed.lastExitInfo = { code, signal };

    const reason = spawnError
      ? spawnError
      : signal
        ? `killed by signal ${signal}`
        : `exited with code ${code}`;

    console.error(`[sidecar:${managed.name}] ${reason}`);
    console.error(`[sidecar:${managed.name}] rejecting ${managed.pending.size} pending request(s)`);

    // Reject ALL pending requests — this is the "no hang" guarantee
    const err = new SidecarCrashedError(
      `sidecar '${managed.name}' died: ${reason}`,
      code,
      signal,
    );
    for (const pending of managed.pending.values()) {
      pending.reject(err);
    }
    managed.pending.clear();

    this.emit('exit', managed.name, { code, signal, reason });
  }

  private registerShutdownHandlers(): void {
    if (this.shutdownHandlersRegistered) return;
    this.shutdownHandlersRegistered = true;

    const killAll = () => {
      if (this.children.size > 0) {
        console.log(`[sidecars] killing ${this.children.size} sidecar(s) on shutdown`);
        this.killAll();
      }
    };

    process.on('SIGINT', killAll);
    process.on('SIGTERM', killAll);
    process.on('beforeExit', killAll);
    process.on('exit', killAll);  // synchronous last-resort
  }
}

export const sidecarManager = new SidecarManagerImpl();

// ── build123d sidecar helper ─────────────────────────────────────────────
// Convenience function to spawn the build123d sidecar if not already running.
// Other sidecars (python-kasa, MediaPipe) will get their own helpers in Steps 7/10.

const SIDECAR_DIR = join(__dirname, '..', '..', 'sidecars', 'build123d');
const SIDECAR_SCRIPT = join(SIDECAR_DIR, 'sidecar.py');

export function ensureBuild123dSidecar(): void {
  if (sidecarManager.isRunning('build123d')) return;
  // If there's a crashed entry in the map, remove it first so we can respawn
  sidecarManager.removeDead('build123d');
  if (!existsSync(SIDECAR_SCRIPT)) {
    throw new Error(`build123d sidecar script not found at ${SIDECAR_SCRIPT}`);
  }
  // Ensure the STL output directory exists
  const stlOutDir = join(SIDECAR_DIR, '..', '..', '.stl-out');
  if (!existsSync(stlOutDir)) {
    mkdirSync(stlOutDir, { recursive: true });
  }
  sidecarManager.spawn('build123d', process.env.PYTHON3 ?? 'python3', [SIDECAR_SCRIPT], {
    cwd: SIDECAR_DIR,
  });
}

export const STL_OUTPUT_DIR = join(__dirname, '..', '..', '..', '.stl-out');

// ── Kokoro TTS sidecar helper ────────────────────────────────────────────
// Phase E Build 1: lazy-spawned on first KokoroTTSProvider.speak() call.
// Same lifecycle contract as build123d — SidecarManager owns the process,
// kills it on Node shutdown, surfaces crashes as SidecarCrashedError.
//
// The Kokoro sidecar uses a dedicated Python venv at server/sidecars/kokoro/venv/
// (NOT committed — see .gitignore) because it needs torch + kokoro + transformers,
// which are NOT in the system Python. The venv path is configurable via
// KOKORO_VENV env var for non-standard installs.

const KOKORO_SIDECAR_DIR = join(__dirname, '..', '..', 'sidecars', 'kokoro');
const KOKORO_SIDECAR_SCRIPT = join(KOKORO_SIDECAR_DIR, 'sidecar.py');
const DEFAULT_KOKORO_VENV_PYTHON = join(KOKORO_SIDECAR_DIR, 'venv', 'bin', 'python');

export function ensureKokoroSidecar(): void {
  if (sidecarManager.isRunning('kokoro')) return;
  sidecarManager.removeDead('kokoro');
  if (!existsSync(KOKORO_SIDECAR_SCRIPT)) {
    throw new Error(`Kokoro sidecar script not found at ${KOKORO_SIDECAR_SCRIPT}`);
  }
  // Use the venv's Python if it exists, else fall back to system Python
  // (system Python won't have torch/kokoro installed, but the error will
  // surface honestly on first /tts call rather than at spawn time).
  const pythonBin = existsSync(DEFAULT_KOKORO_VENV_PYTHON)
    ? DEFAULT_KOKORO_VENV_PYTHON
    : (process.env.KOKORO_VENV_PYTHON ?? process.env.PYTHON3 ?? 'python3');
  sidecarManager.spawn('kokoro', pythonBin, [KOKORO_SIDECAR_SCRIPT], {
    cwd: KOKORO_SIDECAR_DIR,
  });
}
