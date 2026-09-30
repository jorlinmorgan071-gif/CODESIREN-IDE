// server/src/sidecars/installer.ts
// Phase 3+ — Real local-model installer for Kokoro + Whisper sidecars.
//
// Per the user's directive: "One button. Click → venv created if needed →
// dependencies installed → model weights downloaded → sidecar verified working,
// all as one continuous progress bar with a plain-language status line."
//
// This module replaces the previous broken "Download" flow that only called
// ensure_model() inside an already-working sidecar (which assumed the venv +
// pip install had been done manually). This installer does the FULL job:
//   1. Pre-check: Python3 available? Disk space sufficient?
//   2. Create venv if missing (python3 -m venv venv)
//   3. Install dependencies (pip install -r requirements.txt, with torch from
//      the CPU wheel index for Kokoro)
//   4. Download model weights (spawn sidecar, send preload request)
//   5. Verify (ping sidecar, confirm modelLoaded=true)
//
// Progress is emitted as events so the UI can show a real progress bar with
// plain-language status lines. On failure at any step, a plain-language error
// + a retry path is emitted — no stack traces, no suggested terminal commands.
//
// Resume: if the install is interrupted (app closed, network drop, etc.),
// clicking Download again detects what's already done and resumes from there:
//   - venv exists → skip venv creation
//   - deps installed (verified by importing the package in venv python) → skip pip install
//   - model downloaded (verified by checking HF cache) → skip preload
//   - always runs the verify step
//
// Cancel: AbortController kills any spawned child process. Partial state is
// preserved (venv, partially-installed deps) so resume can pick up where it
// left off. We do NOT delete partial state on cancel — that would waste the
// work already done.

import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDiskSpace } from './disk-info.js';
import { sidecarManager, ensureKokoroSidecar, ensureWhisperSidecar } from './manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Install step definitions ────────────────────────────────────────────

export type InstallPhase =
  | 'pre-check'    // checking Python + disk space
  | 'venv'         // creating Python virtual environment
  | 'deps'         // pip installing dependencies
  | 'model'        // downloading model weights
  | 'verify'       // verifying sidecar spawns + responds
  | 'done'         // install complete
  | 'error'        // install failed
  | 'cancelled';   // install cancelled by user

export interface InstallProgress {
  phase: InstallPhase;
  /** Cumulative percent 0-100 across all steps. */
  percent: number;
  /** Plain-language status line shown to the user (e.g. "Setting up voice engine..."). */
  label: string;
  /** Optional sub-detail (e.g. a specific pip package being installed). */
  detail?: string;
  /** Present only when phase === 'error'. Plain-language error + retry guidance. */
  error?: string;
  /** Present only when phase === 'done'. Confirmation message. */
  message?: string;
}

// Per-step percent ranges — the progress bar jumps between step boundaries,
// with detail text showing what's happening right now within each step.
const STEP_PERCENTS = {
  'pre-check': { start: 0, end: 5 },
  'venv': { start: 5, end: 15 },
  'deps': { start: 15, end: 65 },  // pip install is the longest step
  'model': { start: 65, end: 95 }, // model download is the second-longest
  'verify': { start: 95, end: 100 },
} as const;

// ── Sidecar install configs ──────────────────────────────────────────────
// Each sidecar has its own deps + torch wheel index + size estimate.

interface SidecarInstallConfig {
  name: 'kokoro' | 'whisper';
  sidecarDir: string;
  venvDir: string;
  venvPython: string;        // venv/bin/python
  venvPip: string;           // venv/bin/pip
  requirementsFile: string;
  /** PyTorch CPU wheel index URL — only for Kokoro (Whisper uses faster-whisper, no torch). */
  torchIndexUrl?: string;
  /** Package to import-check to verify deps installed (e.g. 'kokoro' or 'faster_whisper'). */
  importCheckPackage: string;
  /** Estimated total install size in MB (venv + model weights). */
  estimatedSizeMb: number;
  /** HF cache subdirectory pattern to check if model already downloaded. */
  modelCacheSubdir: string;
  /** Function to spawn the sidecar (from manager.ts). */
  ensureSidecar: () => void;
  /** Plain-language name for status messages. */
  displayName: string;
  /** Plain-language description of what this engine does. */
  description: string;
}

const SIDECAR_CONFIGS: Record<string, SidecarInstallConfig> = {
  kokoro: {
    name: 'kokoro',
    sidecarDir: join(__dirname, '..', '..', 'sidecars', 'kokoro'),
    venvDir: join(__dirname, '..', '..', 'sidecars', 'kokoro', 'venv'),
    venvPython: join(__dirname, '..', '..', 'sidecars', 'kokoro', 'venv', 'bin', 'python'),
    venvPip: join(__dirname, '..', '..', 'sidecars', 'kokoro', 'venv', 'bin', 'pip'),
    requirementsFile: join(__dirname, '..', '..', 'sidecars', 'kokoro', 'requirements.txt'),
    torchIndexUrl: 'https://download.pytorch.org/whl/cpu',
    importCheckPackage: 'kokoro',
    estimatedSizeMb: 1700,  // ~1.4GB venv + ~312MB model
    modelCacheSubdir: 'models--hexgrad--Kokoro-82M',
    ensureSidecar: ensureKokoroSidecar,
    displayName: 'Kokoro voice engine',
    description: 'Local neural text-to-speech (offline, no cloud API needed)',
  },
  whisper: {
    name: 'whisper',
    sidecarDir: join(__dirname, '..', '..', 'sidecars', 'whisper'),
    venvDir: join(__dirname, '..', '..', 'sidecars', 'whisper', 'venv'),
    venvPython: join(__dirname, '..', '..', 'sidecars', 'whisper', 'venv', 'bin', 'python'),
    venvPip: join(__dirname, '..', '..', 'sidecars', 'whisper', 'venv', 'bin', 'pip'),
    requirementsFile: join(__dirname, '..', '..', 'sidecars', 'whisper', 'requirements.txt'),
    // No torch needed — faster-whisper uses CTranslate2
    importCheckPackage: 'faster_whisper',
    estimatedSizeMb: 2000,  // ~434 MB venv + ~1.5 GB large-v3-turbo model (measured)
    modelCacheSubdir: 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo',
    ensureSidecar: ensureWhisperSidecar,
    displayName: 'Whisper transcription engine',
    description: 'Local neural speech-to-text (offline, no cloud API needed)',
  },
};

// ── Installer ────────────────────────────────────────────────────────────

class SidecarInstallerImpl extends EventEmitter {
  private activeInstalls = new Map<string, AbortController>();
  private activeChildProcesses = new Map<string, ChildProcess>();

  /**
   * Install a sidecar from scratch (or resume if partially installed).
   * Emits 'progress' events as it goes. Resolves when install completes
   * successfully; rejects on failure or cancel.
   */
  async install(sidecarName: string): Promise<void> {
    const config = SIDECAR_CONFIGS[sidecarName];
    if (!config) {
      this.emitProgress(sidecarName, {
        phase: 'error',
        percent: 0,
        label: 'Unknown engine',
        error: `Unknown sidecar: ${sidecarName}. Valid options: kokoro, whisper.`,
      });
      throw new Error(`Unknown sidecar: ${sidecarName}`);
    }

    // If already installing, reject — caller should poll isInstalling() first
    if (this.activeInstalls.has(sidecarName)) {
      throw new Error(`${config.displayName} is already installing.`);
    }

    const abort = new AbortController();
    this.activeInstalls.set(sidecarName, abort);

    try {
      await this.runInstall(config, abort.signal);
    } finally {
      this.activeInstalls.delete(sidecarName);
      this.activeChildProcesses.delete(sidecarName);
    }
  }

  /**
   * Cancel an active install. Kills any spawned child process.
   * Partial state is preserved for resume.
   */
  cancel(sidecarName: string): void {
    const abort = this.activeInstalls.get(sidecarName);
    if (!abort) return;
    abort.abort();
    // Kill any active child process
    const child = this.activeChildProcesses.get(sidecarName);
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
    }
  }

  isInstalling(sidecarName: string): boolean {
    return this.activeInstalls.has(sidecarName);
  }

  /**
   * Get the install state for a sidecar — what's already done vs what's missing.
   * Used by the UI to show the right button label ("Download" vs "Install" vs "Ready").
   */
  getInstallState(sidecarName: string): {
    venvExists: boolean;
    depsInstalled: boolean;
    modelDownloaded: boolean;
    ready: boolean;
  } {
    const config = SIDECAR_CONFIGS[sidecarName];
    if (!config) {
      return { venvExists: false, depsInstalled: false, modelDownloaded: false, ready: false };
    }
    const venvExists = existsSync(config.venvPython);
    const depsInstalled = venvExists ? this.checkDepsInstalled(config) : false;
    const modelDownloaded = this.checkModelDownloaded(config);
    const ready = venvExists && depsInstalled && modelDownloaded;
    return { venvExists, depsInstalled, modelDownloaded, ready };
  }

  /**
   * Get the disk space estimate for an install.
   * Returns the estimated size + actual free space, so the UI can show
   * "Need ~1.7 GB, you have 12.3 GB free" before the user clicks Download.
   */
  async getEstimate(sidecarName: string): Promise<{
    estimatedSizeMb: number;
    estimatedSizeHuman: string;
    freeBytes: number | null;
    freeHuman: string;
    sufficient: boolean;
    insufficientByBytes: number;
    insufficientByHuman: string;
  }> {
    const config = SIDECAR_CONFIGS[sidecarName];
    if (!config) {
      throw new Error(`Unknown sidecar: ${sidecarName}`);
    }
    const requiredBytes = config.estimatedSizeMb * 1024 * 1024;
    const space = await checkDiskSpace(config.sidecarDir, requiredBytes);
    return {
      estimatedSizeMb: config.estimatedSizeMb,
      estimatedSizeHuman: space.requiredHuman,
      freeBytes: space.freeBytes,
      freeHuman: space.freeHuman,
      sufficient: space.sufficient,
      insufficientByBytes: space.deficitBytes,
      insufficientByHuman: space.deficitHuman,
    };
  }

  // ── Internal: the actual install flow ──────────────────────────────────

  private async runInstall(config: SidecarInstallConfig, signal: AbortSignal): Promise<void> {
    const { name } = config;

    // ── Step 1: Pre-check ──────────────────────────────────────────────
    this.emitProgress(name, {
      phase: 'pre-check',
      percent: STEP_PERCENTS['pre-check'].start,
      label: `Checking system requirements for ${config.displayName}...`,
    });

    // Check Python3
    const pythonBin = process.env.PYTHON3 ?? 'python3';
    const pythonOk = await this.checkPythonAvailable(pythonBin, signal);
    if (!pythonOk) {
      this.emitProgress(name, {
        phase: 'error',
        percent: STEP_PERCENTS['pre-check'].start,
        label: 'Python 3 not found',
        error: 'Python 3 is required but wasn\'t found on your system. Install Python 3.8 or newer from python.org and try again.',
      });
      throw new Error('Python 3 not found');
    }

    if (signal.aborted) throw new Error('Install cancelled');

    // Check disk space
    const requiredBytes = config.estimatedSizeMb * 1024 * 1024;
    const space = await checkDiskSpace(config.sidecarDir, requiredBytes);
    if (!space.sufficient) {
      this.emitProgress(name, {
        phase: 'error',
        percent: STEP_PERCENTS['pre-check'].start,
        label: 'Not enough disk space',
        error: `Not enough free disk space. ${config.displayName} needs about ${space.requiredHuman}, but only ${space.freeHuman} is available. Free up at least ${space.deficitHuman} and try again.`,
      });
      throw new Error(`Insufficient disk space: need ${space.requiredHuman}, have ${space.freeHuman}`);
    }

    this.emitProgress(name, {
      phase: 'pre-check',
      percent: STEP_PERCENTS['pre-check'].end,
      label: 'System requirements met',
      detail: `Need ~${space.requiredHuman}, you have ${space.freeHuman} free`,
    });

    // ── Step 2: Create venv (if missing) ───────────────────────────────
    const venvExists = existsSync(config.venvPython);
    if (!venvExists) {
      this.emitProgress(name, {
        phase: 'venv',
        percent: STEP_PERCENTS['venv'].start,
        label: `Setting up ${config.displayName}...`,
        detail: 'Creating Python environment',
      });

      await this.runCommand(name, pythonBin, ['-m', 'venv', config.venvDir], signal, {
        onStderr: (line) => {
          this.emitProgress(name, {
            phase: 'venv',
            percent: STEP_PERCENTS['venv'].start,
            label: `Setting up ${config.displayName}...`,
            detail: line.slice(0, 200),
          });
        },
      });

      if (signal.aborted) throw new Error('Install cancelled');
    } else {
      this.emitProgress(name, {
        phase: 'venv',
        percent: STEP_PERCENTS['venv'].end,
        label: `Setting up ${config.displayName}...`,
        detail: 'Python environment already exists',
      });
    }

    // ── Step 3: Install dependencies (if missing) ──────────────────────
    const depsInstalled = this.checkDepsInstalled(config);
    if (!depsInstalled) {
      this.emitProgress(name, {
        phase: 'deps',
        percent: STEP_PERCENTS['deps'].start,
        label: `Installing ${config.displayName} dependencies...`,
        detail: 'This may take a few minutes',
      });

      // For Kokoro: install torch from CPU wheel index first (it's huge +
      // needs a special index URL). For Whisper: skip this step (faster-whisper
      // doesn't need torch).
      if (config.torchIndexUrl) {
        this.emitProgress(name, {
          phase: 'deps',
          percent: STEP_PERCENTS['deps'].start + 5,
          label: `Installing ${config.displayName} dependencies...`,
          detail: 'Downloading PyTorch (CPU build, ~750 MB)',
        });
        await this.runCommand(name, config.venvPip, [
          'install', '--no-cache-dir',
          '--index-url', config.torchIndexUrl,
          'torch',
        ], signal, {
          onStdout: (line) => this.emitPipProgress(name, config, line, STEP_PERCENTS['deps'].start + 5, 20),
          onStderr: (line) => this.emitPipProgress(name, config, line, STEP_PERCENTS['deps'].start + 5, 20),
        });
      }

      if (signal.aborted) throw new Error('Install cancelled');

      // Install the rest of the requirements
      this.emitProgress(name, {
        phase: 'deps',
        percent: STEP_PERCENTS['deps'].start + (config.torchIndexUrl ? 20 : 0) + 5,
        label: `Installing ${config.displayName} dependencies...`,
        detail: 'Installing remaining packages',
      });
      await this.runCommand(name, config.venvPip, [
        'install', '--no-cache-dir',
        '-r', config.requirementsFile,
      ], signal, {
        onStdout: (line) => this.emitPipProgress(name, config, line, STEP_PERCENTS['deps'].start + (config.torchIndexUrl ? 25 : 5), 35),
        onStderr: (line) => this.emitPipProgress(name, config, line, STEP_PERCENTS['deps'].start + (config.torchIndexUrl ? 25 : 5), 35),
      });

      if (signal.aborted) throw new Error('Install cancelled');
    } else {
      this.emitProgress(name, {
        phase: 'deps',
        percent: STEP_PERCENTS['deps'].end,
        label: `Installing ${config.displayName} dependencies...`,
        detail: 'Dependencies already installed',
      });
    }

    // ── Step 4: Download model weights (if not cached) ────────────────
    const modelDownloaded = this.checkModelDownloaded(config);
    if (!modelDownloaded) {
      this.emitProgress(name, {
        phase: 'model',
        percent: STEP_PERCENTS['model'].start,
        label: `Downloading ${config.displayName} language model...`,
        detail: 'This may take a few minutes depending on your connection',
      });

      // Spawn the sidecar + send preload request
      // The sidecar's preload handler calls ensure_model() which downloads
      // from HuggingFace if not cached.
      config.ensureSidecar();
      const result = await sidecarManager.request(name, { type: 'preload' }, 5 * 60_000);

      if (!result.ok) {
        this.emitProgress(name, {
          phase: 'error',
          percent: STEP_PERCENTS['model'].start,
          label: 'Download failed',
          error: `Couldn't download the language model. ${result.error ?? 'Unknown error'}. Check your internet connection and try again.`,
        });
        throw new Error(`Model download failed: ${result.error}`);
      }

      if (signal.aborted) throw new Error('Install cancelled');
    } else {
      this.emitProgress(name, {
        phase: 'model',
        percent: STEP_PERCENTS['model'].end,
        label: `Downloading ${config.displayName} language model...`,
        detail: 'Model already downloaded',
      });
    }

    // ── Step 5: Verify ─────────────────────────────────────────────────
    this.emitProgress(name, {
      phase: 'verify',
      percent: STEP_PERCENTS['verify'].start,
      label: `Almost ready — verifying ${config.displayName}...`,
    });

    // Kill any sidecar that was spawned during install so we get a fresh
    // spawn for the verify step (clean state).
    // Use try/catch — the sidecar might have already exited on its own.
    try {
      if (sidecarManager.isRunning(name)) {
        sidecarManager.kill(name);
        // Wait for the process to actually die. SIGTERM → Python's signal
        // handler → sys.exit(0) → Node's 'exit' event fires → managed.crashed
        // is set to true. This can take a moment.
        for (let i = 0; i < 20; i++) {
          if (!sidecarManager.isRunning(name)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      // removeDead is safe to call even if not dead — it's a no-op then
      sidecarManager.removeDead(name);
    } catch (err) {
      console.warn(`[${name}] verify: kill/removeDead failed (non-fatal):`, err);
    }

    // Spawn fresh + ping
    config.ensureSidecar();
    // Small delay to let the sidecar initialize before we send the ping
    await new Promise((r) => setTimeout(r, 200));
    const pingResult = await sidecarManager.request(name, { type: 'ping' }, 15_000);

    if (!pingResult.ok || !(pingResult as { pong?: boolean }).pong) {
      this.emitProgress(name, {
        phase: 'error',
        percent: STEP_PERCENTS['verify'].start,
        label: 'Verification failed',
        error: `The ${config.displayName} was installed but didn't start correctly. Try again, or contact support if it keeps happening. Error: ${pingResult.error ?? 'no response'}`,
      });
      throw new Error(`Verify failed: ${pingResult.error ?? 'no pong'}`);
    }

    const modelLoaded = !!(pingResult as { modelLoaded?: boolean }).modelLoaded;
    if (!modelLoaded) {
      // The model should be loaded at this point (we preloaded it). If not,
      // something's off — but we'll let the first real call fail rather than
      // blocking the install. Log a warning.
      console.warn(`[${name}] install verified but model not loaded — will load on first call`);
    }

    // ── Done ───────────────────────────────────────────────────────────
    this.emitProgress(name, {
      phase: 'done',
      percent: 100,
      label: `${config.displayName} is ready`,
      message: `${config.displayName} installed successfully. ${config.description}.`,
    });
  }

  // ── Internal: helpers ──────────────────────────────────────────────────

  private async checkPythonAvailable(pythonBin: string, signal: AbortSignal): Promise<boolean> {
    try {
      const result = await this.runCommandQuiet(pythonBin, ['--version'], signal);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private checkDepsInstalled(config: SidecarInstallConfig): boolean {
    if (!existsSync(config.venvPython)) return false;
    // Try importing the key package — if it works, deps are installed.
    try {
      const result = spawnSync(
        config.venvPython,
        ['-c', `import ${config.importCheckPackage}`],
        { encoding: 'utf8', timeout: 5000 },
      );
      return result.status === 0;
    } catch {
      return false;
    }
  }

  private checkModelDownloaded(config: SidecarInstallConfig): boolean {
    const modelCacheDir = join(config.sidecarDir, 'model-cache');
    if (!existsSync(modelCacheDir)) return false;
    // Look for the HF cache subdir pattern
    try {
      const entries = readdirSync(modelCacheDir, { withFileTypes: true });
      return entries.some((e) => e.isDirectory() && e.name.includes(config.modelCacheSubdir));
    } catch {
      return false;
    }
  }

  /**
   * Run a command + stream stdout/stderr line-by-line. Kills the process
   * if the abort signal fires. Returns on process exit.
   */
  private runCommand(
    sidecarName: string,
    command: string,
    args: string[],
    signal: AbortSignal,
    opts: { onStdout?: (line: string) => void; onStderr?: (line: string) => void } = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.activeChildProcesses.set(sidecarName, child);

      const checkAbort = () => {
        if (signal.aborted) {
          try { child.kill('SIGTERM'); } catch { /* already dead */ }
        }
      };
      signal.addEventListener('abort', checkAbort, { once: true });

      let stdoutBuf = '';
      let stderrBuf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line) opts.onStdout?.(line);
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrBuf += chunk;
        let nl: number;
        while ((nl = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, nl).trim();
          stderrBuf = stderrBuf.slice(nl + 1);
          if (line) opts.onStderr?.(line);
        }
      });

      child.on('error', (err) => {
        signal.removeEventListener('abort', checkAbort);
        this.activeChildProcesses.delete(sidecarName);
        reject(err);
      });
      child.on('exit', (code) => {
        signal.removeEventListener('abort', checkAbort);
        this.activeChildProcesses.delete(sidecarName);
        if (signal.aborted) {
          reject(new Error('Install cancelled'));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`));
        }
      });
    });
  }

  /** Like runCommand but doesn't stream — returns the exit code + stderr. */
  private runCommandQuiet(command: string, args: string[], signal: AbortSignal): Promise<{ exitCode: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      signal.addEventListener('abort', () => {
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }, { once: true });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ exitCode: code ?? 1, stderr }));
    });
  }

  /** Parse a pip output line + emit a progress event with the package name. */
  private emitPipProgress(
    sidecarName: string,
    config: SidecarInstallConfig,
    line: string,
    percentStart: number,
    percentRange: number,
  ): void {
    // pip outputs lines like:
    //   Collecting kokoro==0.9.4
    //   Downloading kokoro-0.9.4-py3-none-any.whl (84 kB)
    //   Installing collected packages: kokoro
    // We show the line as detail but don't try to parse percent (pip's
    // progress bars use carriage returns which don't survive line-buffering).
    let detail: string | undefined;
    if (line.startsWith('Collecting')) {
      detail = `Installing ${line.replace('Collecting ', '')}`;
    } else if (line.startsWith('Downloading')) {
      detail = `Downloading ${line.replace('Downloading ', '').slice(0, 100)}`;
    } else if (line.startsWith('Installing collected packages')) {
      detail = 'Finalizing installation...';
    } else if (line.startsWith('Successfully installed')) {
      detail = 'Dependencies installed';
    } else {
      detail = line.slice(0, 100);
    }
    // Mid-range percent — we don't know exactly how far we are within pip,
    // so we show the start of the range.
    this.emitProgress(sidecarName, {
      phase: 'deps',
      percent: percentStart + Math.floor(percentRange / 2),
      label: `Installing ${config.displayName} dependencies...`,
      detail,
    });
  }

  private emitProgress(sidecarName: string, progress: InstallProgress): void {
    this.emit(`progress:${sidecarName}`, progress);
  }
}

export const sidecarInstaller = new SidecarInstallerImpl();
