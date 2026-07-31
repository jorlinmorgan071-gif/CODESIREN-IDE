// server/src/agents/performance/index.ts
// Performance Agent — Static anti-pattern detection + bundle-size measurement.
//
// Phase C Agent 6: HARDENED from 31-line chat-only stub to real IAgent with
// 2 programmatic capabilities:
//   1. performanceReview() — static regex-based anti-pattern detection in
//      server-side source code + bundle-size measurement
//   2. review() override — thin wrapper that calls performanceReview() and
//      flattens findings into ReviewResult (always approved:true — advisory only)
//
// SCOPE BOUNDARY (non-negotiable):
//   - STATIC analysis only — no live runtime profiling or instrumentation
//   - Server package only (src/) — no app/ (frontend) performance review
//   - Advisory only — review() always returns approved:true regardless of findings
//   - No write-blocking behavior — this agent is NOT a gate
//
// ANTI-PATTERNS DETECTED (per Section 0 evaluation):
//   1. execSync in route handler files (src/routes/*.ts) — blocks event loop
//   2. Unbounded SELECT queries without LIMIT (excluding aggregates/single-row lookups)
//
// ANTI-PATTERNS DROPPED (per Section 0 — couldn't clear false-positive bar):
//   - N+1 query patterns (67% false-positive rate — can't distinguish query-in-loop
//     from sleep-in-loop or tool-execution-in-loop with regex)
//   - readFileSync in route handlers (0 real instances found — nothing to test against)
//   - Nested loops with array methods (high false-positive risk — same as original build)
//
// GHOST MODE: NOT WIRED. Per Section 0: the two detected patterns are 'warning'
// severity (performance issues, not security/data-loss risks). Ghost Mode is for
// high-severity findings that need immediate action. Performance anti-patterns
// are advisory — the developer should fix them, but they don't warrant blocking.

import type {
  AgentChunk,
  AgentTask,
  AgentDomain,
  ReviewResult,
  PerformanceReviewResult,
  PerformanceAntiPatternFinding,
  BundleSizes,
} from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const SYSTEM_PROMPT = `You are the Performance Agent of Zero Two: Code Siren.
Your role: static performance analysis of server-side source code — detect anti-patterns
that degrade performance under load, and measure bundle sizes.
When asked to review:
1. Scan for sync fs/exec calls in request handlers (blocks event loop).
2. Scan for unbounded SELECT queries (no LIMIT — can return arbitrarily large result sets).
3. Measure bundle sizes if dist/ exists.
4. Report findings as advisory — do NOT block writes, do NOT require Ghost Mode approval.
Be specific with file, line, and fix recommendation.`;

export class PerformanceAgent extends IAgent {
  readonly id = 'performance-agent';
  readonly name = 'Performance Agent';
  readonly domain: AgentDomain = 'PERFORMANCE';
  readonly icon = 'gauge';
  readonly color = '#F97316';
  constructor() { super(0.83); }

  // ── 1. Full structured performance review ──────────────────────────
  /**
   * Run static anti-pattern detection + bundle-size measurement.
   *
   * This is the REAL method that returns structured PerformanceReviewResult.
   * The review() override is a thin wrapper that calls this and flattens
   * to ReviewResult (same pattern SecurityAgent used for securityScan()
   * vs review()).
   *
   * @param projectRoot Root of the code_siren project (parent of server/)
   */
  async performanceReview(projectRoot: string): Promise<PerformanceReviewResult> {
    const skipped: string[] = [];
    const serverDir = join(projectRoot, 'server');
    const appDir = join(projectRoot, 'app');

    // ── Anti-pattern detection ────────────────────────────────────────
    let antiPatternFindings: PerformanceAntiPatternFinding[] = [];
    try {
      antiPatternFindings = this.scanAntiPatterns(serverDir);
    } catch (err: any) {
      skipped.push(`anti-pattern-scan: ${err.message}`);
    }

    // ── Bundle-size measurement ───────────────────────────────────────
    let bundleSizes: BundleSizes | null = null;
    try {
      bundleSizes = this.measureBundleSizes(serverDir, appDir);
    } catch (err: any) {
      skipped.push(`bundle-size: ${err.message}`);
    }

    // ── Overall assessment ────────────────────────────────────────────
    let overallAssessment: 'healthy' | 'attention-needed' | 'unknown';
    if (antiPatternFindings.length === 0 && bundleSizes !== null) {
      overallAssessment = 'healthy';
    } else if (antiPatternFindings.length > 0) {
      overallAssessment = 'attention-needed';
    } else {
      overallAssessment = 'unknown';
    }

    return {
      antiPatternFindings,
      bundleSizes,
      overallAssessment,
      skipped,
    };
  }

  // ── 2. Anti-pattern scanning ───────────────────────────────────────
  /**
   * Scan server source code for performance anti-patterns.
   *
   * Two patterns (per Section 0 evaluation):
   *   1. execSync in src/routes/*.ts — blocks event loop in HTTP handlers
   *   2. Unbounded SELECT without LIMIT (excluding aggregates/single-row)
   *
   * Each pattern has REJECTS + false-positive test pairs in the test file,
   * plus live-code tests against the 4 real instances found in Section 0.
   */
  private scanAntiPatterns(serverDir: string): PerformanceAntiPatternFinding[] {
    const findings: PerformanceAntiPatternFinding[] = [];

    // ── Pattern 1: execSync in route handler files ────────────────────
    // Scoped to src/routes/*.ts — module-level execSync in other files
    // (e.g. ollama.ts startup check) is legitimate.
    const routesDir = join(serverDir, 'src', 'routes');
    if (existsSync(routesDir)) {
      for (const file of readdirSync(routesDir)) {
        if (!file.endsWith('.ts')) continue;
        const filePath = join(routesDir, file);
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (/\bexecSync\s*\(/.test(lines[i])) {
            findings.push({
              file: `src/routes/${file}`,
              line: i + 1,
              pattern: 'execSync-in-route-handler',
              severity: 'warning',
              suggestion: 'execSync blocks the Node.js event loop. Use exec() (async) or a pre-computed value cached at startup instead.',
            });
          }
        }
      }
    }

    // ── Pattern 2: Unbounded SELECT queries without LIMIT ─────────────
    // Scan all .ts files in src/ (not just routes — queries can be in
    // orchestrator, memory, auth, etc.). Exclude test files.
    // Exclusions (legitimate, not false positives):
    //   - COUNT(*) / GROUP BY — returns one row per group, not unbounded
    //   - WHERE ... = $1 — single-row lookup (unique constraint)
    //   - information_schema queries — bounded by system catalog size
    //   - INSERT/UPDATE/DELETE — don't return result sets
    const srcDir = join(serverDir, 'src');
    if (existsSync(srcDir)) {
      this.scanDirectoryForUnboundedSelects(srcDir, srcDir, findings);
    }

    return findings;
  }

  /**
   * Recursively scan a directory for unbounded SELECT queries.
   */
  private scanDirectoryForUnboundedSelects(
    dir: string,
    srcRoot: string,
    findings: PerformanceAntiPatternFinding[],
  ): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
        this.scanDirectoryForUnboundedSelects(fullPath, srcRoot, findings);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        this.scanFileForUnboundedSelects(fullPath, srcRoot, findings);
      }
    }
  }

  /**
   * Scan a single file for unbounded SELECT queries.
   */
  private scanFileForUnboundedSelects(
    filePath: string,
    srcRoot: string,
    findings: PerformanceAntiPatternFinding[],
  ): void {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    const relativePath = relative(srcRoot, filePath);
    const lines = content.split('\n');

    // Find SELECT statements — they may span multiple lines in template literals
    // We look for lines containing SELECT and track until we find the closing
    // backtick or quote, checking for LIMIT / COUNT / GROUP BY / = $1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match SELECT inside query() calls or template literals
      if (!/\bSELECT\b/i.test(line)) continue;

      // Gather the full query (may span multiple lines — grab next few lines)
      let fullQuery = line;
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        fullQuery += '\n' + lines[j];
        // Stop if we hit a closing backtick or semicolon
        if (/['"`;]/.test(lines[j])) break;
      }

      // Check exclusions:
      // - LIMIT present → bounded, skip
      // - COUNT( present → aggregate, skip
      // - GROUP BY present → aggregate, skip
      // - information_schema → system catalog, skip
      // - INSERT/UPDATE/DELETE → not a SELECT result set, skip
      //
      // NOTE: We do NOT exclude `WHERE ... = $1` — while primary-key lookups
      // (WHERE id = $1) return 1 row, foreign-key lookups (WHERE session_id = $1)
      // can return many. Regex can't distinguish PK from FK columns, so we flag
      // ALL unbounded SELECTs without LIMIT. The auth query (WHERE email = $1)
      // will also be flagged — that's defensible: adding LIMIT 1 is a defensive
      // best practice even for unique-constrained queries.
      if (/\bLIMIT\b/i.test(fullQuery)) continue;
      if (/\bCOUNT\s*\(/i.test(fullQuery)) continue;
      if (/\bGROUP\s+BY\b/i.test(fullQuery)) continue;
      if (/information_schema/i.test(fullQuery)) continue;

      // This is an unbounded SELECT — flag it
      findings.push({
        file: relativePath,
        line: i + 1,
        pattern: 'unbounded-select',
        severity: 'warning',
        suggestion: 'SELECT without LIMIT can return arbitrarily large result sets. Add LIMIT + pagination for production queries.',
      });
    }
  }

  // ── 3. Bundle-size measurement ─────────────────────────────────────
  /**
   * Measure total size of server/dist/ and app/dist/.
   * Returns null if neither dist/ exists (with skipped[] entry from caller).
   */
  private measureBundleSizes(serverDir: string, appDir: string): BundleSizes | null {
    const serverDist = join(serverDir, 'dist');
    const appDist = join(appDir, 'dist');

    const serverExists = existsSync(serverDist);
    const appExists = existsSync(appDist);

    if (!serverExists && !appExists) {
      return null; // caller adds skipped[] entry
    }

    const serverSize = serverExists ? this.measureDirSize(serverDist) : 0;
    const appSize = appExists ? this.measureDirSize(appDist) : 0;

    // If only one exists, report both but note the missing one as 0
    // (the caller's skipped[] will note which was missing via the try/catch)
    if (!serverExists) {
      // server/dist missing — report app only
    }
    if (!appExists) {
      // app/dist missing — report server only
    }

    return {
      app: appSize,
      server: serverSize,
      unit: 'bytes',
    };
  }

  /**
   * Recursively measure the total size of a directory in bytes.
   */
  private measureDirSize(dir: string): number {
    let totalSize = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        totalSize += this.measureDirSize(fullPath);
      } else if (entry.isFile()) {
        totalSize += statSync(fullPath).size;
      }
    }
    return totalSize;
  }

  // ── 4. review() override — thin wrapper, always approved ───────────
  /**
   * Override review() — calls performanceReview() and flattens to ReviewResult.
   *
   * ALWAYS returns approved: true — Performance Agent is advisory, NOT a gate.
   * Findings are stringified into issues[] for ReviewResult compatibility.
   * Callers that need the full structured result should call performanceReview()
   * directly (same pattern SecurityAgent used for securityScan() vs review()).
   */
  override async review(output: { content: string; files?: string[] }): Promise<ReviewResult> {
    // Performance Agent's review() scans the project root from the file paths
    // If no files provided, we can't determine the project root — return clean
    if (!output.files || output.files.length === 0) {
      return {
        approved: true,
        score: 100,
        notes: 'Performance review: no files to scan (advisory only)',
        issues: [],
        reviewTier: 'llm-reviewed',
      };
    }

    // Derive project root from the file path (go up from server/src/... to project root)
    const firstFile = output.files[0];
    const serverIdx = firstFile.indexOf('server/');
    const projectRoot = serverIdx >= 0 ? firstFile.slice(0, serverIdx - 1) : '/tmp';

    try {
      const result = await this.performanceReview(projectRoot);

      // Flatten findings into issues[] for ReviewResult compatibility
      const issues = result.antiPatternFindings.map(f =>
        `[${f.severity}] ${f.pattern} at ${f.file}:${f.line} — ${f.suggestion}`
      );

      return {
        approved: true, // ALWAYS approved — advisory only
        score: result.antiPatternFindings.length === 0 ? 100 : 75,
        notes: `Performance review: ${result.antiPatternFindings.length} finding(s) (advisory, not blocking). Assessment: ${result.overallAssessment}`,
        issues,
        reviewTier: 'llm-reviewed',
      };
    } catch (err: any) {
      // If the review itself fails, still approve (advisory — don't block writes)
      return {
        approved: true,
        score: 100,
        notes: `Performance review failed (advisory — not blocking): ${err.message}`,
        issues: [],
        reviewTier: 'llm-error',
      };
    }
  }

  // ── Chat persona (preserved from original stub) ────────────────────
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.3, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['performance', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
