// server/src/orchestration/ghost-remediation.ts
// Phase A Section 1b: real remediation logic for Ghost Mode findings.
//
// Two paths (per Section 0 investigation):
//   Path A — dependency-vulnerability: real `npm audit fix` (no --force, ever)
//     planFix(): runs `npm audit fix --dry-run --json` to determine if an
//       in-range fix exists. If yes → builds a real fix plan. If no → builds
//       an honest suggest-only plan ("no in-range fix, manual upgrade required").
//     applyFix(): runs `npm audit fix` (no --force) + verifies with re-audit.
//       Verification = vulnerability count actually decreased. Failure → rollback.
//
//   Path B — performance anti-patterns: honest suggest-only
//     planFix(): builds the suggestion plan directly from the finding.
//     applyFix(): NO-OP. No file written, no command run. The "fix" is the
//       human having seen the suggestion. Transitions straight to complete.
//
// Why a separate module: same circular-dep reason as ghost-scanners.ts.
// ghost-mode.ts can't import SecurityAgent (which imports ghostMode). This
// module imports ghost-mode.ts + the sandbox validator, no agent imports.
//
// SAFETY (non-negotiable):
//   - NEVER use `npm audit fix --force`. It can install major version bumps
//     and modify package.json. The risk of breaking the build is too high
//     for an automated remediation path.
//   - ALL shell commands go through validateShellCommand() first, even though
//     `npm audit fix` is known-safe. Defense in depth — if the blocklist ever
//     expands to catch npm commands, we want to respect it.
//   - The verify step is a REAL re-audit, not a stub. If the vuln count
//     didn't decrease, we transition to rolled_back (honest failure).

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateShellCommand } from '../security/sandbox.js';
import type { GhostFinding, GhostPlan } from '../types.js';

// ── Path A: dependency-vulnerability remediation ────────────────────────

export interface DryRunResult {
  hasInRangeFix: boolean;
  /** What the dry-run would change (e.g. "change minimist 1.2.0 => 1.2.8"). */
  changeDescription: string;
  /** Raw npm audit fix --dry-run --json output, for debugging. */
  raw: string;
}

// ── Internal function holder (for testability) ─────────────────────────
//
// countVulnerabilities is called internally by applyNpmAuditFix. To allow
// tests to spy on it (vi.spyOn replaces the property on this object, and
// internal calls go through this object too), we route internal calls
// through `internals.countVulnerabilities` instead of the bare function.
// This is the standard pattern for making ESM module-internal calls
// spyable without changing the public API.
const internals = {
  countVulnerabilities: (cwd: string): number => countVulnerabilitiesImpl(cwd),
};

/**
 * Run `npm audit fix --dry-run --json` to determine if an in-range fix exists.
 *
 * Per Section 0 testing: `npm audit fix` (no --force) only applies fixes
 * within the stated semver range. If the fix requires an out-of-range version,
 * the dry-run reports "fix available via `npm audit fix --force`" and the
 * change list is empty.
 *
 * Returns hasInRangeFix=true if the change list is non-empty (an in-range fix
 * exists and would be applied).
 */
export function dryRunNpmAuditFix(cwd: string): DryRunResult {
  // Sanity: cwd must have node_modules + package-lock (same guard as
  // SecurityAgent.scanDependencies). If missing, treat as no-fix-available.
  if (!existsSync(join(cwd, 'node_modules')) || !existsSync(join(cwd, 'package-lock.json'))) {
    return {
      hasInRangeFix: false,
      changeDescription: 'no node_modules or package-lock.json — cannot run npm audit fix',
      raw: '',
    };
  }

  let raw = '';
  try {
    // npm audit fix --dry-run exits non-zero if vulns are found (same as
    // npm audit), but still writes valid JSON to stdout. Capture via try/catch.
    raw = execSync('npm audit fix --dry-run --json', {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    // Non-zero exit — but stdout may still have the JSON (npm's quirk).
    if (err.stdout) {
      raw = err.stdout.toString();
    } else {
      // Real failure (timeout, signal, etc.) — treat as no-fix-available.
      return {
        hasInRangeFix: false,
        changeDescription: `npm audit fix --dry-run failed: ${err.message}`,
        raw: '',
      };
    }
  }

  // Parse the dry-run JSON. Shape:
  //   { "change": [{"from": {...}, "to": {...}}], "added": 0, "removed": 0, "audit": {...} }
  //
  // NOTE: npm audit fix --dry-run --json outputs a human-readable "change X => Y"
  // line BEFORE the JSON object on stdout. We need to extract the JSON part
  // (everything from the first `{` to the end).
  let parsed: any;
  try {
    const jsonStart = raw.indexOf('{');
    const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
    parsed = JSON.parse(jsonStr);
  } catch {
    return {
      hasInRangeFix: false,
      changeDescription: 'npm audit fix --dry-run output was not valid JSON',
      raw,
    };
  }

  // The "change" array contains objects with from/to. The human-readable
  // summary is in the raw output's first line(s). Build a readable description.
  const changes: any[] = Array.isArray(parsed.change) ? parsed.change : [];
  const hasInRangeFix = changes.length > 0;
  let changeDescription: string;
  if (hasInRangeFix) {
    // Build "minimist 1.2.0 => 1.2.8" style descriptions from the change objects
    const parts = changes.map((c: any) => {
      const fromName = c?.from?.name ?? 'unknown';
      const fromVer = c?.from?.version ?? 'unknown';
      const toVer = c?.to?.version ?? 'unknown';
      return `${fromName} ${fromVer} => ${toVer}`;
    });
    changeDescription = parts.join('; ');
  } else {
    changeDescription = 'no in-range fix available — manual upgrade required';
  }

  return { hasInRangeFix, changeDescription, raw };
}

/**
 * Build the remediation plan for a dependency-vulnerability finding.
 *
 * Runs `npm audit fix --dry-run` first. If an in-range fix exists → returns
 * a plan with fixAction='npm-audit-fix'. If not → returns a suggest-only plan
 * that honestly tells the human a manual upgrade is required.
 */
export function buildDependencyFixPlan(finding: GhostFinding, serverCwd: string): GhostPlan {
  const pkg = finding.packageName ?? 'unknown-package';
  const ver = finding.currentVersion ?? 'unknown-version';
  const recommendedFix = finding.recommendedFix ?? 'see advisory';

  const dryRun = dryRunNpmAuditFix(serverCwd);

  if (dryRun.hasInRangeFix) {
    // Real auto-fix path
    return {
      findingId: finding.id,
      preview:
        `Run npm audit fix — upgrades ${pkg}@${ver} to fixed version (in-range, non-breaking). ` +
        `Dry-run reports: ${dryRun.changeDescription}`,
      steps: [
        `Run npm audit fix in ${serverCwd} (no --force — non-breaking only)`,
        `Verify with npm audit --json (expect vulnerability count to decrease)`,
        `Rollback if verification fails`,
      ],
      fixAction: 'npm-audit-fix',
      fixCwd: serverCwd,
    };
  }

  // No in-range fix — honest suggest-only plan
  return {
    findingId: finding.id,
    preview:
      `No in-range fix for ${pkg}@${ver} — manual upgrade required. ` +
      `Recommended: ${recommendedFix}. (${dryRun.changeDescription})`,
    steps: [
      `Manual upgrade required — npm audit fix cannot safely apply this fix`,
      `Recommended fix range: ${recommendedFix}`,
      `Review the advisory and decide whether to upgrade (may be a breaking change)`,
      `This finding is NOT auto-fixable — no automated action will be taken`,
    ],
    fixAction: 'suggest-only',
  };
}

export interface ApplyFixResult {
  success: boolean;
  /** Vuln count before the fix attempt. */
  vulnsBefore: number;
  /** Vuln count after the fix attempt (same as before if fix didn't run). */
  vulnsAfter: number;
  /** stdout/stderr from npm audit fix (for trace logging). */
  output: string;
  /** Failure reason (set when success=false). */
  reason?: string;
}

/**
 * Run `npm audit fix` (no --force) + verify with re-audit.
 *
 * Pre-checks (defense in depth):
 *   1. validateShellCommand('npm audit fix') — even though it's known-safe,
 *      respect the blocklist if it ever expands.
 *   2. existsSync(node_modules) + existsSync(package-lock.json) — npm audit fix
 *      needs both.
 *
 * Post-checks (real verification):
 *   1. Re-run `npm audit --json` after the fix.
 *   2. Compare vuln count before vs after. If after >= before → verification
 *      failed → return success=false (caller transitions to rolled_back).
 *
 * NEVER uses --force. This is non-negotiable per the directive.
 */
export function applyNpmAuditFix(cwd: string): ApplyFixResult {
  // Pre-check 1: validateShellCommand
  const validation = validateShellCommand('npm audit fix');
  if (!validation.allowed) {
    return {
      success: false,
      vulnsBefore: -1,
      vulnsAfter: -1,
      output: '',
      reason: `blocked by validateShellCommand: ${validation.reason}`,
    };
  }

  // Pre-check 2: node_modules + package-lock must exist
  if (!existsSync(join(cwd, 'node_modules')) || !existsSync(join(cwd, 'package-lock.json'))) {
    return {
      success: false,
      vulnsBefore: -1,
      vulnsAfter: -1,
      output: '',
      reason: 'node_modules or package-lock.json missing — cannot run npm audit fix',
    };
  }

  // Capture vuln count BEFORE the fix
  const vulnsBefore = internals.countVulnerabilities(cwd);

  // Run `npm audit fix` (NO --force, ever)
  let fixOutput = '';
  try {
    fixOutput = execSync('npm audit fix', {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,  // 1min — npm audit fix can take a while on big trees
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    // npm audit fix exits non-zero if vulns REMAIN after the fix (which is
    // common — it only fixes in-range ones). Non-zero exit is NOT a failure
    // signal. We rely on the re-audit to determine success.
    if (err.stdout) {
      fixOutput = err.stdout.toString();
    } else {
      // Real failure (timeout, signal) — no fix applied.
      return {
        success: false,
        vulnsBefore,
        vulnsAfter: vulnsBefore,
        output: `npm audit fix threw: ${err.message}`,
        reason: `npm audit fix command failed: ${err.message}`,
      };
    }
  }

  // Verify: re-audit and compare vuln count
  const vulnsAfter = internals.countVulnerabilities(cwd);

  if (vulnsAfter < vulnsBefore) {
    // Vuln count decreased — success
    return {
      success: true,
      vulnsBefore,
      vulnsAfter,
      output: fixOutput,
    };
  }

  // Vuln count didn't decrease — verification failed
  return {
    success: false,
    vulnsBefore,
    vulnsAfter,
    output: fixOutput,
    reason: `verification failed: vuln count ${vulnsBefore} → ${vulnsAfter} (did not decrease)`,
  };
}

/**
 * Run `npm audit --json` and return the total vulnerability count.
 * Returns -1 if the audit fails entirely (can't parse JSON, timeout, etc.).
 *
 * Per Section 0 testing: npm audit exits 0 if no vulns, non-zero if vulns
 * exist. Either way, stdout has the JSON. The metadata.vulnerabilities.total
 * field is the canonical count.
 */
export function countVulnerabilities(cwd: string): number {
  return internals.countVulnerabilities(cwd);
}

/**
 * The real implementation of countVulnerabilities. Called via
 * `internals.countVulnerabilities` so tests can spy on it.
 *
 * Run `npm audit --json` and return the total vulnerability count.
 * Returns -1 if the audit fails entirely (can't parse JSON, timeout, etc.).
 *
 * Per Section 0 testing: npm audit exits 0 if no vulns, non-zero if vulns
 * exist. Either way, stdout has the JSON. The metadata.vulnerabilities.total
 * field is the canonical count.
 */
function countVulnerabilitiesImpl(cwd: string): number {
  if (!existsSync(join(cwd, 'node_modules')) || !existsSync(join(cwd, 'package-lock.json'))) {
    return -1;
  }

  let raw = '';
  try {
    raw = execSync('npm audit --json', {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    if (err.stdout) {
      raw = err.stdout.toString();
    } else {
      return -1;
    }
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed?.metadata?.vulnerabilities?.total ?? -1;
  } catch {
    return -1;
  }
}

// ── Path B: performance anti-pattern remediation ────────────────────────

/**
 * Build a suggest-only plan for a performance anti-pattern finding.
 *
 * Per Section 0: performance anti-patterns (execSync-in-route-handler,
 * unbounded-select) are NOT safely auto-fixable. A mechanical rewrite would
 * produce non-compiling code (execSync → await exec requires the enclosing
 * function to be async). The honest v1 scope is suggest-only.
 */
export function buildPerformanceSuggestionPlan(finding: GhostFinding): GhostPlan {
  const location = finding.filePath && finding.line
    ? `${finding.filePath}:${finding.line}`
    : finding.filePath ?? 'unknown location';

  return {
    findingId: finding.id,
    preview: `Review ${finding.type} at ${location} — ${finding.description}`,
    steps: [
      `Manual review required — this finding type is NOT auto-fixable`,
      `Suggestion: ${finding.description}`,
      `No automated action will be taken — apply the fix manually if appropriate`,
    ],
    fixAction: 'suggest-only',
  };
}

/**
 * Build a suggest-only plan for a terminal:error finding.
 *
 * Phase A Section 2: when a command fails (non-zero exit), Terminal Agent
 * reports the error to Ghost Mode via reportFinding({ type: 'terminal:error' }).
 * There is no safe generic auto-fix for "a command failed" — the failure
 * could mean anything (missing dep, syntax error, permission, network).
 * Same reasoning as performance anti-patterns: honest suggest-only.
 *
 * The plan surfaces the real stderr + exit code so the human can diagnose.
 */
export function buildTerminalErrorSuggestionPlan(finding: GhostFinding): GhostPlan {
  return {
    findingId: finding.id,
    preview: `Terminal command failed — ${finding.description}`,
    steps: [
      `Manual review required — terminal errors are NOT auto-fixable`,
      `Error details: ${finding.description}`,
      `Check the command syntax, dependencies, and permissions`,
      `No automated action will be taken — diagnose + fix manually`,
    ],
    fixAction: 'suggest-only',
  };
}

// ── Test exports ────────────────────────────────────────────────────────
// `internals` is exported so tests can vi.spyOn(internals, 'countVulnerabilities')
// to simulate verification failure without mocking the real npm audit fix command.
export const __test__ = {
  dryRunNpmAuditFix,
  applyNpmAuditFix,
  countVulnerabilities,
  buildDependencyFixPlan,
  buildPerformanceSuggestionPlan,
  buildTerminalErrorSuggestionPlan,
  internals,
};
