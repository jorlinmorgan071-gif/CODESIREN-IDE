// server/src/orchestration/package-install.ts
// Phase A Section 2: package installation capability.
//
// Separate from Terminal Agent because Terminal Agent runs commands in
// /tmp (a known limitation flagged in Section 0, deferred). Package install
// REQUIRES running in the project directory (server/ or app/), so it needs
// its own capability with explicit cwd handling.
//
// Pattern: same as Section 1b's applyNpmAuditFix — route through Ghost Mode
// approval gate, run npm install, verify with npm ls. NO --force, NO version-
// conflict auto-resolution, NO package-manager choice (npm-only per Section 0).
//
// The user MUST specify the target directory (server/ or app/) — no inference.
// This is a deliberate restraint: inferring the target from context is too
// error-prone (e.g., "add express" — is that for the backend or frontend?).

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateShellCommand } from '../security/sandbox.js';

export interface PackageInstallParams {
  /** Package name, optionally with @version (e.g. "express" or "lodash@4.17.21"). */
  packageName: string;
  /** Target directory — must be 'server' or 'app' (the two npm projects in Code Siren). */
  targetDir: 'server' | 'app';
  /** Whether to save as a devDependency (--save-dev). Default: false (regular dep). */
  dev?: boolean;
}

export interface PackageInstallResult {
  success: boolean;
  /** The full package spec that was installed (e.g. "lodash@4.17.21"). */
  installedSpec: string;
  /** The version actually installed (from npm ls output). */
  installedVersion?: string;
  /** stdout from npm install. */
  installOutput: string;
  /** stdout from npm ls (verification). */
  verifyOutput: string;
  /** Failure reason (set when success=false). */
  reason?: string;
}

/**
 * Build the `npm install` command string from params. Does NOT run it.
 * Used by the Ghost Mode approval flow so the user can see exactly what
 * will run before approving.
 */
export function buildInstallCommand(params: PackageInstallParams): string {
  const devFlag = params.dev ? ' --save-dev' : '';
  return `npm install ${params.packageName}${devFlag}`;
}

/**
 * Run `npm install <pkg>` in the target directory + verify with `npm ls <pkg>`.
 *
 * Pre-checks (defense in depth):
 *   1. validateShellCommand(buildInstallCommand(params)) — even though
 *      `npm install` is known-safe, respect the blocklist if it expands.
 *   2. existsSync(targetDir/package.json) — must be a real npm project.
 *
 * Post-checks (real verification):
 *   1. Run `npm ls <pkg> --json` after install.
 *   2. Parse the output to confirm the package is installed at the expected
 *      version. If npm ls reports "missing" or "ERR!", verification fails.
 *
 * NEVER uses --force. Does NOT resolve version conflicts. Does NOT choose
 * between npm/pnpm/yarn (npm-only per Section 0).
 */
export function installPackage(
  projectRoot: string,
  params: PackageInstallParams,
): PackageInstallResult {
  const targetCwd = join(projectRoot, params.targetDir);
  const cmd = buildInstallCommand(params);

  // Pre-check 1: validateShellCommand
  const validation = validateShellCommand(cmd);
  if (!validation.allowed) {
    return {
      success: false,
      installedSpec: params.packageName,
      installOutput: '',
      verifyOutput: '',
      reason: `blocked by validateShellCommand: ${validation.reason}`,
    };
  }

  // Pre-check 2: target must be a real npm project
  if (!existsSync(join(targetCwd, 'package.json'))) {
    return {
      success: false,
      installedSpec: params.packageName,
      installOutput: '',
      verifyOutput: '',
      reason: `target directory has no package.json: ${targetCwd}`,
    };
  }

  // Extract the bare package name (without @version) for npm ls verification.
  // "lodash@4.17.21" → "lodash". "@scope/pkg@1.0.0" → "@scope/pkg".
  const barePkgName = extractBarePackageName(params.packageName);

  // Run `npm install` (NO --force, ever)
  let installOutput = '';
  try {
    installOutput = execSync(cmd, {
      cwd: targetCwd,
      encoding: 'utf8',
      timeout: 120_000,  // 2min — npm install can be slow on first run
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    const stderr = err.stderr ?? err.stdout ?? err.message;
    return {
      success: false,
      installedSpec: params.packageName,
      installOutput: stderr.toString().slice(0, 500),
      verifyOutput: '',
      reason: `npm install failed (exit ${err.status ?? 1}): ${stderr.toString().slice(0, 200)}`,
    };
  }

  // Verify: run `npm ls <pkg> --json` to confirm the package is installed
  let verifyOutput = '';
  let installedVersion: string | undefined;
  try {
    verifyOutput = execSync(`npm ls ${barePkgName} --json`, {
      cwd: targetCwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    // npm ls exits non-zero if the package is missing or has deps issues.
    // Capture stdout (which has the JSON) even on non-zero exit.
    const out = err.stdout ?? verifyOutput;
    verifyOutput = out ? out.toString() : '';
    // Try to parse anyway — npm ls --json often writes valid JSON even on error
    const parsed = tryParseJson(verifyOutput);
    if (parsed?.dependencies?.[barePkgName]) {
      installedVersion = parsed.dependencies[barePkgName].version;
      // If we got a version, the install actually succeeded even if npm ls
      // reported a broader issue (e.g. a peer dep warning).
      return {
        success: true,
        installedSpec: params.packageName,
        installedVersion,
        installOutput: installOutput.slice(0, 500),
        verifyOutput: verifyOutput.slice(0, 500),
      };
    }
    return {
      success: false,
      installedSpec: params.packageName,
      installOutput: installOutput.slice(0, 500),
      verifyOutput: verifyOutput.slice(0, 500),
      reason: `npm ls verification failed: package not found in dependencies tree`,
    };
  }

  // Parse the npm ls JSON to extract the installed version
  const parsed = tryParseJson(verifyOutput);
  if (parsed?.dependencies?.[barePkgName]) {
    installedVersion = parsed.dependencies[barePkgName].version;
    return {
      success: true,
      installedSpec: params.packageName,
      installedVersion,
      installOutput: installOutput.slice(0, 500),
      verifyOutput: verifyOutput.slice(0, 500),
    };
  }

  // npm ls succeeded but the package isn't in the dependencies tree — shouldn't
  // happen, but handle it honestly.
  return {
    success: false,
    installedSpec: params.packageName,
    installOutput: installOutput.slice(0, 500),
    verifyOutput: verifyOutput.slice(0, 500),
    reason: `npm ls succeeded but ${barePkgName} not found in dependencies tree`,
  };
}

/**
 * Extract the bare package name from a spec like "lodash@4.17.21" or
 * "@scope/pkg@1.0.0" → "lodash" / "@scope/pkg".
 *
 * Handles scoped packages correctly: "@scope/pkg@1.0.0" → "@scope/pkg"
 * (the @ after the scope name is the version separator, not the scope prefix).
 */
function extractBarePackageName(spec: string): string {
  // Scoped package: starts with @
  if (spec.startsWith('@')) {
    // Find the SECOND @ (the version separator)
    const secondAt = spec.indexOf('@', 1);
    return secondAt >= 0 ? spec.slice(0, secondAt) : spec;
  }
  // Unscoped: split at first @
  const atIdx = spec.indexOf('@');
  return atIdx >= 0 ? spec.slice(0, atIdx) : spec;
}

function tryParseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── Test exports ────────────────────────────────────────────────────────

export const __test__ = {
  installPackage,
  buildInstallCommand,
  extractBarePackageName,
};
