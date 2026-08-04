// server/src/orchestration/run-tests.ts
// Phase A Section 3: real test execution capability.
//
// Uses spawn() (non-blocking) instead of execSync() — a full test suite run
// takes ~94s on server/, and execSync would block the Node event loop for
// that entire duration, freezing concurrent WS/HTTP traffic. spawn() lets
// the server stay responsive while tests run in a child process.
//
// Fixed command allowlist only (no arbitrary `npm run <script>`):
//   - server/: `npm test` (vitest run) or `npm run test:coverage`
//   - app/:    `npm test` (vitest run — script added in this section)
//
// Uses `--reporter=json` to get structured output (numTotalTests,
// numPassedTests, numFailedTests, success) — no regex parsing of text.
//
// No Ghost Mode approval gate — test execution is read-only from the
// project's perspective (only writes gitignored coverage/ + .traces/).
// Matches DevOps Agent's existing ungated build/test pattern.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateShellCommand } from '../security/sandbox.js';

export interface RunTestsParams {
  /** Target directory — must be 'server' or 'app'. */
  targetDir: 'server' | 'app';
  /** Whether to run with coverage. Only meaningful for server/ (app/ has no
   * coverage config). Ignored for app/. */
  coverage?: boolean;
  /** Timeout in ms. Default: 180_000 (3 min — 2x the measured 94s suite). */
  timeoutMs?: number;
}

export interface RunTestsResult {
  /** Whether the test command ran successfully (exit 0 = all tests passed). */
  success: boolean;
  /** Total number of tests run. */
  totalTests: number;
  /** Number of passing tests. */
  passed: number;
  /** Number of failing tests. */
  failed: number;
  /** Number of skipped/pending tests. */
  pending: number;
  /** Raw stdout from the test runner (JSON reporter output, parsed). */
  rawOutput: string;
  /** Coverage summary if coverage was requested (per-file percentages). */
  coverageSummary?: CoverageSummary;
  /** Failure reason (set when success=false). */
  reason?: string;
  /** How long the test run took in ms. */
  durationMs: number;
}

export interface CoverageSummary {
  /** Total statements coverage % across all files. */
  statementsPct: number;
  /** Total branches coverage %. */
  branchesPct: number;
  /** Total functions coverage %. */
  functionsPct: number;
  /** Total lines coverage %. */
  linesPct: number;
}

// ── Allowlist ───────────────────────────────────────────────────────────
//
// Only these exact commands are allowed. No arbitrary `npm run <script>`.
// This prevents a malicious user from running `npm run reset` (which wipes
// the DB) or other destructive scripts via the test-execution path.

function buildTestCommand(targetDir: 'server' | 'app', coverage: boolean): string {
  if (targetDir === 'server') {
    // --exclude tests/unit/run-tests.test.ts: prevents infinite recursion
    // (this test file spawns `npm test` which would re-run itself).
    // The exclusion is harmless for real usage (users running the full suite
    // via the agent won't have this test file in their project — it's only
    // in Code Siren's own repo during development).
    const exclude = '--exclude tests/unit/run-tests.test.ts';
    return coverage
      ? `npm run test:coverage -- --reporter=json ${exclude}`
      : `npm test -- --reporter=json ${exclude}`;
  }
  // app/: npm test (vitest run) — coverage not supported (no config)
  return 'npm test -- --reporter=json';
}

/**
 * Run the test suite for the target directory using spawn() (non-blocking).
 *
 * The returned Promise resolves when the child process exits. stdout is
 * buffered + parsed as JSON (vitest's --reporter=json format). stderr is
 * captured for error reporting.
 *
 * The Node event loop is NOT blocked during the run — concurrent HTTP/WS
 * traffic continues to be served. This is the key difference from execSync.
 */
export function runTests(
  projectRoot: string,
  params: RunTestsParams,
): Promise<RunTestsResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const targetCwd = join(projectRoot, params.targetDir);
    const coverage = params.coverage ?? false;
    const timeoutMs = params.timeoutMs ?? 180_000;

    // ── Pre-check 1: validateShellCommand ─────────────────────────────
    const cmd = buildTestCommand(params.targetDir, coverage);
    const validation = validateShellCommand(cmd);
    if (!validation.allowed) {
      resolve({
        success: false,
        totalTests: 0, passed: 0, failed: 0, pending: 0,
        rawOutput: '',
        reason: `blocked by validateShellCommand: ${validation.reason}`,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // ── Pre-check 2: target must be a real npm project ────────────────
    if (!existsSync(join(targetCwd, 'package.json'))) {
      resolve({
        success: false,
        totalTests: 0, passed: 0, failed: 0, pending: 0,
        rawOutput: '',
        reason: `target directory has no package.json: ${targetCwd}`,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // ── Spawn the test process ────────────────────────────────────────
    // Use `sh -c` to run the command (npm needs a shell to find the binary).
    // stdio: ['pipe', 'pipe', 'pipe'] — capture stdout + stderr.
    const child = spawn('sh', ['-c', cmd], {
      cwd: targetCwd,
      env: { ...process.env, CI: 'true' },  // CI=true makes vitest non-interactive
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    // Buffer stdout (the JSON reporter output)
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    // Buffer stderr (vitest writes progress + errors here)
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Timeout — kill the process if it runs too long
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill('SIGTERM');
      // Give it 2s to clean up, then SIGKILL
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
    }, timeoutMs);

    // Process exited
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (timedOut) {
        resolve({
          success: false,
          totalTests: 0, passed: 0, failed: 0, pending: 0,
          rawOutput: stdout,
          reason: `timed out after ${timeoutMs}ms`,
          durationMs,
        });
        return;
      }

      // Parse the JSON reporter output
      const parsed = parseVitestJson(stdout);
      if (!parsed) {
        // JSON parse failed — the test runner may have crashed before producing
        // valid output. stderr has the real error.
        resolve({
          success: false,
          totalTests: 0, passed: 0, failed: 0, pending: 0,
          rawOutput: stdout,
          reason: `failed to parse vitest JSON output: ${stderr.slice(0, 200)}`,
          durationMs,
        });
        return;
      }

      // If coverage was requested, parse the coverage summary from the
      // coverage-final.json file. We read it AFTER the process exits so it's
      // fully written.
      let coverageSummary: CoverageSummary | undefined;
      if (coverage && params.targetDir === 'server') {
        coverageSummary = parseCoverageSummary(join(targetCwd, 'coverage', 'coverage-final.json'));
      }

      resolve({
        success: parsed.success && exitCode === 0,
        totalTests: parsed.numTotalTests,
        passed: parsed.numPassedTests,
        failed: parsed.numFailedTests,
        pending: parsed.numPendingTests,
        rawOutput: stdout,
        coverageSummary,
        durationMs,
      });
    });

    // Process failed to spawn (e.g., sh not found)
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        totalTests: 0, passed: 0, failed: 0, pending: 0,
        rawOutput: '',
        reason: `spawn failed: ${err.message}`,
        durationMs: Date.now() - startTime,
      });
    });

    // Suppress unused-variable warning for `killed`
    void killed;
  });
}

// ── Parsers ─────────────────────────────────────────────────────────────

interface VitestJsonResult {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  success: boolean;
}

function parseVitestJson(stdout: string): VitestJsonResult | null {
  try {
    // vitest --reporter=json writes a single JSON object to stdout.
    // When combined with --coverage, the coverage text table is appended
    // AFTER the JSON. We need to extract just the JSON object.
    //
    // Strategy: find the first `{`, then scan forward tracking brace depth
    // to find the matching `}`. Parse that substring.
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    let jsonEnd = -1;
    for (let i = jsonStart; i < stdout.length; i++) {
      const ch = stdout[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { jsonEnd = i; break; }
      }
    }
    if (jsonEnd < 0) return null;

    const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonStr);
    return {
      numTotalTests: parsed.numTotalTests ?? 0,
      numPassedTests: parsed.numPassedTests ?? 0,
      numFailedTests: parsed.numFailedTests ?? 0,
      numPendingTests: parsed.numPendingTests ?? 0,
      success: parsed.success ?? false,
    };
  } catch {
    return null;
  }
}

/**
 * Parse the Istanbul-format coverage-final.json to extract total coverage
 * percentages. Sums statement/branch/function/line hits across all files.
 */
function parseCoverageSummary(coveragePath: string): CoverageSummary | undefined {
  if (!existsSync(coveragePath)) return undefined;
  try {
    // readFileSync is fine here — the file is already written + closed by the
    // child process (we're in the close handler). Size is ~100KB.
    const raw = require('node:fs').readFileSync(coveragePath, 'utf8');
    const data = JSON.parse(raw);

    let totalStatements = 0;
    let coveredStatements = 0;
    let totalBranches = 0;
    let coveredBranches = 0;
    let totalFunctions = 0;
    let coveredFunctions = 0;
    let totalLines = 0;
    let coveredLines = 0;

    for (const file of Object.values<any>(data)) {
      // statementMap: { id: { start, end } } — s: { id: hitCount }
      const sMap = file.s ?? {};
      const sCount = Object.keys(sMap).length;
      const sCovered = Object.values(sMap).filter((h: any) => h > 0).length;
      totalStatements += sCount;
      coveredStatements += sCovered;

      // branchMap: { id: { locations: [...] } } — b: { id: [hitCount, ...] }
      const bMap = file.b ?? {};
      for (const hits of Object.values(bMap) as number[][]) {
        for (const h of hits) {
          totalBranches++;
          if (h > 0) coveredBranches++;
        }
      }

      // fnMap: { id: { name, decl } } — f: { id: hitCount }
      const fMap = file.f ?? {};
      const fCount = Object.keys(fMap).length;
      const fCovered = Object.values(fMap).filter((h: any) => h > 0).length;
      totalFunctions += fCount;
      coveredFunctions += fCovered;

      // Lines: derived from statementMap (each statement covers a line range)
      // Istanbul doesn't have a separate lineMap — we approximate by counting
      // unique lines that have at least one covered statement.
      const statementMap = file.statementMap ?? {};
      const lineHits = new Map<number, boolean>();
      for (const [id, hits] of Object.entries(sMap)) {
        const stmt = statementMap[id];
        if (!stmt) continue;
        for (let line = stmt.start.line; line <= stmt.end.line; line++) {
          totalLines++;
          if ((hits as number) > 0) coveredLines++;
        }
      }
    }

    return {
      statementsPct: totalStatements > 0 ? Math.round((coveredStatements / totalStatements) * 1000) / 10 : 0,
      branchesPct: totalBranches > 0 ? Math.round((coveredBranches / totalBranches) * 1000) / 10 : 0,
      functionsPct: totalFunctions > 0 ? Math.round((coveredFunctions / totalFunctions) * 1000) / 10 : 0,
      linesPct: totalLines > 0 ? Math.round((coveredLines / totalLines) * 1000) / 10 : 0,
    };
  } catch {
    return undefined;
  }
}

// ── Test exports ────────────────────────────────────────────────────────

export const __test__ = {
  runTests,
  buildTestCommand,
  parseVitestJson,
  parseCoverageSummary,
};
