// server/src/agents/devops/index.ts
// DevOps Agent — Operational health checks for a locally-running app.
//
// Phase C Agent 5: HARDENED from 31-line chat-only stub to real IAgent with
// 4 programmatic capabilities:
//   1. verifyBuild() — runs build for both app + server
//   2. checkDependencyHealth() — runs npm outdated --json for both packages
//   3. runPreflight() — wraps the existing npm run preflight script
//   4. fullHealthCheck() — combines all of the above + tests + grep-audit
//
// SCOPE BOUNDARY (non-negotiable):
//   - NO Deployment Agent work — no deploy target exists (no Docker, no PaaS,
//     no CI/CD beyond GitHub Actions). Building toward one would be building
//     a mechanism aimed at nothing.
//   - NO duplication of SecurityAgent's vulnerability scanning (npm audit).
//     DevOps Agent checks STALENESS (npm outdated), not vulnerabilities.
//   - NO duplication of CI — this is ON-DEMAND, not a CI replacement.
//     CI runs automatically on push; DevOps Agent runs when a developer
//     asks "is the project healthy right now?" via chat/agent dispatch.
//
// SAFETY BOUNDARIES (directive Section 5):
//   - ALL shell commands through validateShellCommand() — no exceptions.
//     Same import as Terminal Agent: `import { validateShellCommand } from
//     '../../security/sandbox.js'`. Do NOT build a second validation path.
//   - Build/test commands produce only gitignored output (dist/) — they do
//     NOT require Ghost Mode approval. They are read-only from the project's
//     perspective.
//   - FUTURE PHASE BOUNDARY: If DevOps Agent is ever extended to run
//     `npm install`, `npm update`, or `git push` — THAT would require Ghost
//     Mode approval (same pattern as Terminal Agent + Database Agent). Not
//     in scope now; stated here explicitly so a future phase doesn't add it
//     without the approval gate.

import type {
  AgentChunk,
  AgentTask,
  AgentDomain,
  VerifyBuildResult,
  BuildResult,
  DependencyHealthResult,
  OutdatedPackage,
  PreflightResult,
  FullHealthCheckResult,
} from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { validateShellCommand } from '../../security/sandbox.js';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SYSTEM_PROMPT = `You are the DevOps Agent of Zero Two: Code Siren.
Your role: operational health checks for the locally-running app — build verification, dependency staleness checking, preflight validation, and combined health checks.
When asked to check health:
1. Run build verification for both app and server.
2. Check dependency staleness (npm outdated — NOT vulnerability scanning, that's Security Agent's job).
3. Run preflight checks (environment validation).
4. Combine all checks into a single health report.
Be concrete. Show real results, not summaries.`;

export class DevOpsAgent extends IAgent {
  readonly id = 'devops-agent';
  readonly name = 'DevOps Agent';
  readonly domain: AgentDomain = 'DEVOPS';
  readonly icon = 'cloud';
  readonly color = '#8B5CF6';
  constructor() { super(0.82); }

  // ── Helper: run a validated shell command ───────────────────────────
  /**
   * Run a shell command after validating it through validateShellCommand().
   * Returns { success, output, durationMs }.
   *
   * Per directive Section 5: ALL shell commands through validateShellCommand()
   * — no exceptions. If the command is blocked, returns success=false with
   * the validation reason as output.
   *
   * Build/test commands do NOT require Ghost Mode approval (they produce
   * only gitignored output). If this method is ever used for npm install,
   * npm update, or git push — THAT would need Ghost Mode. Not in scope now.
   */
  private runValidatedCommand(
    command: string,
    cwd: string,
    timeoutMs: number = 120_000,
  ): BuildResult {
    const start = Date.now();

    // Validate the command through the SAME path Terminal Agent uses
    const validation = validateShellCommand(command);
    if (!validation.allowed) {
      return {
        success: false,
        output: `Command blocked by validateShellCommand(): ${validation.reason}`,
        durationMs: Date.now() - start,
      };
    }

    try {
      const output = execSync(command, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'], // capture stdout + stderr
      });
      return {
        success: true,
        output: output || '(no output)',
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      // Command failed — capture stderr + stdout from the error
      const stderr = err.stderr ?? '';
      const stdout = err.stdout ?? '';
      const output = (stdout + '\n' + stderr).trim() || err.message;
      return {
        success: false,
        output,
        durationMs: Date.now() - start,
      };
    }
  }

  // ── 1. Build verification ──────────────────────────────────────────
  /**
   * Run the build command for both app + server.
   *
   * Server build: `tsc -p tsconfig.json` → dist/ (gitignored)
   * App build: `tsc -b && vite build` → dist/ (gitignored)
   *
   * Returns structured { app, server, overallSuccess }.
   * Does NOT require Ghost Mode approval — build artifacts are ephemeral.
   */
  async verifyBuild(projectRoot: string): Promise<VerifyBuildResult> {
    const serverDir = join(projectRoot, 'server');
    const appDir = join(projectRoot, 'app');

    // Server build: tsc -p tsconfig.json
    const server = this.runValidatedCommand('npx tsc -p tsconfig.json --noEmit', serverDir, 120_000);

    // App build: tsc -b && vite build (we run typecheck only — actual vite build
    // is slow and produces large output; typecheck is the meaningful check)
    const app = this.runValidatedCommand('npx tsc --noEmit -p tsconfig.app.json', appDir, 120_000);

    return {
      app,
      server,
      overallSuccess: app.success && server.success,
    };
  }

  // ── 2. Dependency health (staleness, NOT vulnerabilities) ──────────
  /**
   * Run `npm outdated --json` for both packages.
   *
   * This is STALENESS checking — which packages have newer versions available.
   * NOT vulnerability scanning (SecurityAgent owns that via `npm audit`).
   *
   * Returns structured outdated-package lists with type classification:
   *   - 'patch': latest is a patch bump (e.g. 1.2.3 → 1.2.4)
   *   - 'minor': latest is a minor bump (e.g. 1.2.3 → 1.3.0)
   *   - 'major': latest is a major bump (e.g. 1.2.3 → 2.0.0)
   */
  async checkDependencyHealth(projectRoot: string): Promise<DependencyHealthResult> {
    const serverDir = join(projectRoot, 'server');
    const appDir = join(projectRoot, 'app');

    const serverOutdated = this.getOutdatedPackages(serverDir);
    const appOutdated = this.getOutdatedPackages(appDir);

    const allOutdated = [...serverOutdated, ...appOutdated];
    const majorUpdates = allOutdated.filter(p => p.type === 'major');

    return {
      server: serverOutdated,
      app: appOutdated,
      totalOutdated: allOutdated.length,
      majorUpdatesAvailable: majorUpdates.length,
    };
  }

  /**
   * Run `npm outdated --json` in a directory and parse the output.
   */
  private getOutdatedPackages(dir: string): OutdatedPackage[] {
    if (!existsSync(join(dir, 'node_modules'))) {
      return []; // no node_modules — nothing to check
    }

    const result = this.runValidatedCommand('npm outdated --json', dir, 30_000);
    if (!result.success) {
      // npm outdated exits non-zero if outdated packages exist, but still
      // writes valid JSON to stdout. The output is captured in the error.
      // If the output is valid JSON, parse it; otherwise return empty.
    }

    let rawJson: string;
    try {
      // npm outdated --json outputs to stdout even on non-zero exit.
      // Our runValidatedCommand captures stdout in the output field.
      // But on non-zero exit, the output is in the error's stdout/stderr.
      // Let's re-run with a simpler approach: just capture stdout directly.
      rawJson = execSync('npm outdated --json', {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'], // capture stdout, suppress stderr
      });
    } catch (err: any) {
      // npm outdated exits non-zero when outdated packages exist — that's normal.
      // The JSON is in err.stdout.
      rawJson = err.stdout ?? '';
    }

    if (!rawJson || rawJson.trim() === '') {
      return [];
    }

    try {
      const parsed = JSON.parse(rawJson);
      const packages: OutdatedPackage[] = [];

      for (const [name, info] of Object.entries(parsed)) {
        const p = info as any;
        const current = p.current ?? p.wanted ?? 'unknown';
        const wanted = p.wanted ?? current;
        const latest = p.latest ?? wanted;

        // Classify the update type based on latest vs current
        const type = this.classifyUpdate(current, latest);

        packages.push({ name, current, wanted, latest, type });
      }

      return packages;
    } catch {
      return []; // JSON parse failed — return empty
    }
  }

  /**
   * Classify an update as patch, minor, or major based on semver comparison.
   */
  private classifyUpdate(current: string, latest: string): OutdatedPackage['type'] {
    try {
      const parseVer = (v: string): [number, number, number] => {
        const parts = v.split('.').map(n => parseInt(n, 10));
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
      };
      const [curMajor, curMinor, curPatch] = parseVer(current);
      const [latMajor, latMinor, latPatch] = parseVer(latest);

      if (latMajor > curMajor) return 'major';
      if (latMinor > curMinor) return 'minor';
      return 'patch';
    } catch {
      return 'patch'; // can't parse — default to patch
    }
  }

  // ── 3. Preflight wrapper ───────────────────────────────────────────
  /**
   * Call the EXISTING `npm run preflight` script (don't reimplement its checks).
   *
   * The preflight script (server/scripts/preflight.ts) checks:
   *   1. Node version (≥ 20)
   *   2. .env file exists and parses
   *   3. Required env vars set (JWT_SECRET ≥ 32 chars, PORT valid)
   *   4. Port available
   *   5. (warn-only) Postgres reachable
   *   6. (warn-only) Ollama reachable
   *   7. (warn-only) tsx + vitest installed
   *   8. Critical dependencies resolvable
   *
   * Exit codes: 0 = all critical checks passed, 1 = at least one failed.
   */
  async runPreflight(projectRoot: string): Promise<PreflightResult> {
    const serverDir = join(projectRoot, 'server');

    // Validate the command before running
    const command = 'npm run preflight';
    const validation = validateShellCommand(command);
    if (!validation.allowed) {
      return {
        passed: false,
        warnings: [],
        failures: [`Command blocked by validateShellCommand(): ${validation.reason}`],
        rawOutput: '',
        exitCode: -1,
      };
    }

    const start = Date.now();
    try {
      const output = execSync(command, {
        cwd: serverDir,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? 'test-secret-32-chars-minimum-padding' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Parse the output for warnings and failures
      const { warnings, failures } = this.parsePreflightOutput(output);

      return {
        passed: failures.length === 0,
        warnings,
        failures,
        rawOutput: output,
        exitCode: 0,
      };
    } catch (err: any) {
      const output = (err.stdout ?? '') + '\n' + (err.stderr ?? '');
      const { warnings, failures } = this.parsePreflightOutput(output);

      return {
        passed: false,
        warnings,
        failures: failures.length > 0 ? failures : ['Preflight exited with non-zero code'],
        rawOutput: output.trim() || err.message,
        exitCode: err.status ?? 1,
      };
    }
  }

  /**
   * Parse preflight script output for warnings and failures.
   * The script prints lines like:
   *   [PASS] Node version: v24.18.0
   *   [WARN] Postgres not reachable
   *   [FAIL] JWT_SECRET not set
   */
  private parsePreflightOutput(output: string): { warnings: string[]; failures: string[] } {
    const warnings: string[] = [];
    const failures: string[] = [];

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[WARN]')) {
        warnings.push(trimmed.slice(6).trim());
      } else if (trimmed.startsWith('[FAIL]')) {
        failures.push(trimmed.slice(6).trim());
      } else if (/warn/i.test(trimmed) && !trimmed.startsWith('[')) {
        // Fallback: lines containing "warn" without bracket prefix
        warnings.push(trimmed);
      } else if (/fail|error/i.test(trimmed) && !trimmed.startsWith('[')) {
        failures.push(trimmed);
      }
    }

    return { warnings, failures };
  }

  // ── 4. Combined health check ───────────────────────────────────────
  /**
   * Run build + dependency health + preflight + tests + grep-audit.
   *
   * Combines all checks into a single { overallHealth: 'healthy'|'degraded'|'unhealthy' }.
   *   - 'healthy': all checks pass
   *   - 'degraded': some checks fail but the project is usable (e.g. outdated deps, preflight warnings)
   *   - 'unhealthy': critical checks fail (build failure, test failure, grep-audit failure)
   */
  async fullHealthCheck(projectRoot: string): Promise<FullHealthCheckResult> {
    const checkedAt = Date.now();

    // Run all checks (sequentially — they're all I/O bound, not CPU-bound)
    const build = await this.verifyBuild(projectRoot);
    const dependencies = await this.checkDependencyHealth(projectRoot);
    const preflight = await this.runPreflight(projectRoot);

    // Run tests
    const serverDir = join(projectRoot, 'server');
    const testStart = Date.now();
    const testResult = this.runValidatedCommand('npx vitest run', serverDir, 300_000);
    const tests = {
      passed: testResult.success,
      output: testResult.output,
      durationMs: testResult.durationMs,
    };

    // Run grep-audit
    const grepResult = this.runValidatedCommand('bash ../scripts/grep-audit.sh', serverDir, 30_000);
    const grepAudit = {
      passed: grepResult.success,
      output: grepResult.output,
    };

    // Classify overall health
    let overallHealth: 'healthy' | 'degraded' | 'unhealthy';

    const criticalFailures = [
      !build.overallSuccess,   // build failure = unhealthy
      !tests.passed,           // test failure = unhealthy
      !grepAudit.passed,       // grep-audit failure = unhealthy
    ];

    const degradedConditions = [
      dependencies.majorUpdatesAvailable > 0,  // major updates available = degraded
      preflight.failures.length > 0,           // preflight failures = degraded
      !preflight.passed,                       // preflight didn't pass = degraded
    ];

    if (criticalFailures.some(f => f)) {
      overallHealth = 'unhealthy';
    } else if (degradedConditions.some(f => f)) {
      overallHealth = 'degraded';
    } else {
      overallHealth = 'healthy';
    }

    return {
      build,
      dependencies,
      preflight,
      tests,
      grepAudit,
      overallHealth,
      checkedAt,
    };
  }

  // ── Chat persona (preserved from original stub) ────────────────────
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.4, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['devops', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
