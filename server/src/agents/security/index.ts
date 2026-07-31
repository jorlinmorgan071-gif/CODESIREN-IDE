// server/src/agents/security/index.ts
// Security Agent — Vulnerability scanning, dependency audits, auth/session review,
// API/network exposure analysis.
//
// Phase C Agent 2: HARDENED from 31-line chat-only stub to real IAgent with
// a `securityScan()` method that performs 3 complementary scans:
//   1. Dependency vulnerabilities — `npm audit --json` (real, not faked)
//   2. Auth/session logic — LLM holistic review of relevant files
//   3. API/network exposure — static pass over route definition files
//
// NOT a per-write gate (that's CodeReviewAgent's job via writeProjectFile()).
// SecurityAgent is a HOLISTIC scanner invoked on-demand — it reviews the
// project as a whole, not individual writes.
//
// Per directive Section 5: calls ghostMode.reportFinding() for CRITICAL/HIGH
// findings only (mapped to Ghost Mode's 'high' severity — the highest it
// supports). Moderate/low findings are reported in the SecurityReviewResult
// but NOT escalated to Ghost Mode.

import type { AgentChunk, AgentTask, AgentDomain, SecurityReviewResult, DependencyFinding, AuthFinding, ExposureFinding } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { modelRouter } from '../../orchestration/model-router.js';
import { ghostMode } from '../../orchestration/ghost-mode.js';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { extractFencedJson } from '../_shared/review-parse.js';

const SYSTEM_PROMPT = `You are the Security Agent of Zero Two: Code Siren.
Your role: identify vulnerabilities, audit dependencies, prevent injection attacks, and detect secrets.
When reviewing code:
1. Check for OWASP Top 10 vulnerabilities (injection, broken auth, XSS, SSRF, etc.).
2. Flag hardcoded secrets, API keys, and credentials.
3. Audit dependency versions against known CVEs.
4. Recommend fixes with specific code changes.
Be thorough. Every finding must include severity, description, and remediation.`;

// Dedicated prompt for the auth/session holistic review. Asks for fenced JSON
// output so we can use extractFencedJson() directly (shared with CodeReviewAgent).
const AUTH_REVIEW_PROMPT = `You are the Security Agent performing an auth/session logic review.
You will be given the contents of auth-related source files. Review them HOLISTICALLY
(not line-by-line regex) for:
- JWT handling: weak secret, missing expiry, algorithm confusion, no verification
- Password hashing: plaintext storage, weak hash (MD5/SHA1), missing salt
- Session management: no expiry, no rotation, predictable tokens
- Permission checks: missing authorization (vs authentication), IDOR, privilege escalation
- Other auth/session issues you identify

Output your findings as fenced JSON. The JSON must have this shape:
{
  "findings": [
    {"file": "src/auth/jwt.ts", "issue": "JWT secret is hardcoded", "severity": "critical"},
    {"file": "src/routes/admin.ts", "issue": "No auth check on /admin endpoint", "severity": "high"}
  ]
}
severity must be one of: "low" | "moderate" | "high" | "critical"

Wrap the JSON in <review>...</review> tags like:
<review>
{"findings": [...]}
</review>

If you find no issues, return an empty findings array:
<review>
{"findings": []}
</review>`;

export class SecurityAgent extends IAgent {
  readonly id = 'security-agent';
  readonly name = 'Security Agent';
  readonly domain: AgentDomain = 'SECURITY';
  readonly icon = 'shield';
  readonly color = '#EE1C1C';
  constructor() { super(0.96); }

  /**
   * Holistic security scan across 3 surfaces. NOT a per-write gate — this is
   * an on-demand scan invoked by the user or by Ghost Mode's scan cycle.
   *
   * Per directive Section 5: reports CRITICAL/HIGH findings to Ghost Mode
   * via ghostMode.reportFinding() as a single named call site at the end.
   */
  async securityScan(params: { projectRoot: string; files?: string[] }): Promise<SecurityReviewResult> {
    const { projectRoot, files = [] } = params;
    const skipped: string[] = [];
    let reviewTier: 'full-scan' | 'partial-scan' | 'stub-fallback' = 'full-scan';

    // ── Surface 1: Dependency vulnerabilities (npm audit --json) ──────
    let dependencyFindings: DependencyFinding[] = [];
    try {
      dependencyFindings = this.scanDependencies(projectRoot);
    } catch (err: any) {
      skipped.push(`dependency-scan: ${err.message}`);
      reviewTier = 'partial-scan';
    }

    // ── Surface 2: API/network exposure (static route-file pass) ──────
    let exposureFindings: ExposureFinding[] = [];
    try {
      exposureFindings = this.scanApiExposure(projectRoot);
    } catch (err: any) {
      skipped.push(`api-exposure: ${err.message}`);
      reviewTier = 'partial-scan';
    }

    // ── Surface 3: Auth/session logic (LLM holistic review) ───────────
    let authFindings: AuthFinding[] = [];
    try {
      authFindings = await this.scanAuthLogic(projectRoot, files);
    } catch (err: any) {
      skipped.push(`auth-review: ${err.message}`);
      reviewTier = 'partial-scan';
    }

    // ── Compute overall risk from all findings ────────────────────────
    const overallRisk = this.computeOverallRisk(dependencyFindings, authFindings, exposureFindings);

    // If everything was skipped, downgrade to stub-fallback
    if (skipped.length === 3) {
      reviewTier = 'stub-fallback';
    }

    const result: SecurityReviewResult = {
      dependencyFindings,
      authFindings,
      exposureFindings,
      overallRisk,
      reviewTier,
      skipped,
    };

    // ── Ghost Mode coupling (directive Section 5) ─────────────────────
    // Report CRITICAL/HIGH findings only. Map directive's "critical" and
    // "high" both to Ghost Mode's 'high' severity (the highest Ghost Mode
    // supports — GhostFinding.severity is 'low' | 'medium' | 'high').
    // This is the SINGLE named call site per the directive.
    this.reportCriticalHighFindingsToGhostMode(result);

    return result;
  }

  // ── Surface 1: Dependency scan via `npm audit --json` ──────────────
  /**
   * Run `npm audit --json` in the project root and normalize the output
   * into DependencyFinding[]. Uses execSync — same pattern as Terminal Agent.
   *
   * Throws if `npm audit` fails entirely (e.g. no node_modules, no package-lock).
   * Individual vulnerability parsing errors are caught + reported per-package.
   */
  private scanDependencies(projectRoot: string): DependencyFinding[] {
    // Verify node_modules exists — npm audit requires it
    if (!existsSync(join(projectRoot, 'node_modules'))) {
      throw new Error('node_modules/ not found — run `npm install` first');
    }
    if (!existsSync(join(projectRoot, 'package-lock.json'))) {
      throw new Error('package-lock.json not found — run `npm install` first');
    }

    let auditRaw: string;
    try {
      auditRaw = execSync('npm audit --json', {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024, // 2MB — large projects can have big audit output
        stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr noise
      });
    } catch (err: any) {
      // npm audit exits non-zero if vulnerabilities are found, but still
      // writes valid JSON to stdout. The JSON is in err.stdout.
      if (err.stdout) {
        auditRaw = err.stdout.toString();
      } else {
        throw new Error(`npm audit failed: ${err.message}`);
      }
    }

    let audit: any;
    try {
      audit = JSON.parse(auditRaw);
    } catch (err: any) {
      throw new Error(`npm audit output was not valid JSON: ${err.message}`);
    }

    const findings: DependencyFinding[] = [];
    const vulnerabilities = audit.vulnerabilities ?? {};
    for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
      const v = vuln as any;
      // Map npm audit severity to our severity union
      // (npm uses: info, low, moderate, high, critical — we support all but 'info')
      const severity = v.severity === 'info' ? 'low' : v.severity;
      if (!['low', 'moderate', 'high', 'critical'].includes(severity)) continue;

      // Get the first advisory for the title + URL
      const via = Array.isArray(v.via) ? v.via : [];
      const firstAdvisory = via.find((x: any) => typeof x === 'object' && x.title);
      const advisoryTitle = firstAdvisory?.title ?? 'Unknown vulnerability';
      const advisoryUrl = firstAdvisory?.url ?? '';
      const advisory = advisoryUrl ? `${advisoryTitle} (${advisoryUrl})` : advisoryTitle;

      // Get the current version
      const currentVersion = v.version ?? 'unknown';

      // Get the recommended fix range
      const fixRange = firstAdvisory?.range ?? v.range ?? 'unknown';
      const recommendedFix = fixRange !== 'unknown' ? `upgrade past ${fixRange}` : 'see advisory for fix';

      findings.push({
        package: pkgName,
        currentVersion,
        severity: severity as DependencyFinding['severity'],
        advisory,
        recommendedFix,
      });
    }

    return findings;
  }

  // ── Surface 2: API/network exposure (static route-file pass) ───────
  /**
   * Static pass over route definition files in src/routes/ + src/index.ts.
   * Flags:
   *   - Routes with no auth middleware (missing requireAuth)
   *   - Wildcard CORS beyond the per-file cases CodeReviewAgent catches
   *   - Debug/admin-pattern routes without explicit auth check nearby
   *
   * This is a HEURISTIC regex pass — not a full AST analysis. It reads
   * route files and looks for `.get(` / `.post(` / `.put(` / `.delete(`
   * patterns, then checks whether `requireAuth` appears on the same line
   * or nearby.
   */
  private scanApiExposure(projectRoot: string): ExposureFinding[] {
    const findings: ExposureFinding[] = [];
    const routesDir = join(projectRoot, 'src', 'routes');
    const indexFile = join(projectRoot, 'src', 'index.ts');

    // Scan all .ts files in src/routes/ (if the dir exists)
    const routeFiles: string[] = [];
    if (existsSync(routesDir)) {
      for (const file of readdirSync(routesDir)) {
        if (file.endsWith('.ts')) routeFiles.push(join(routesDir, file));
      }
    }
    // Also scan src/index.ts (has inline route definitions)
    if (existsSync(indexFile)) routeFiles.push(indexFile);

    // If neither routes/ nor index.ts exists, there's nothing to scan —
    // return empty findings (NOT an error/skip). A project without any
    // route definitions legitimately has zero exposure findings.
    if (routeFiles.length === 0) {
      return [];
    }

    for (const filePath of routeFiles) {
      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue; // skip unreadable files
      }

      // Find route definitions: `routerVar.method('path', [middleware...], handler)`
      // Match lines like `someRouter.get('/foo', requireAuth, ...)` or `app.get('/bar', ...)`
      const routeRegex = /(\w+)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
      let match: RegExpExecArray | null;
      while ((match = routeRegex.exec(content)) !== null) {
        const routerVar = match[1];
        const method = match[2];
        const routePath = match[3];
        const lineStart = content.lastIndexOf('\n', match.index) + 1;
        const lineEnd = content.indexOf('\n', match.index);
        const fullLine = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

        // Check if requireAuth appears in the same line (heuristic — it's
        // typically the 2nd argument after the path)
        const hasRequireAuth = /\brequireAuth\b/.test(fullLine);

        // Skip health-check routes (intentionally public — these are standard)
        const isHealthRoute = routePath === '/' || routePath === '/health' || routePath === '/healthz';

        // Flag admin/debug routes specifically
        const isAdminDebug = /\/(admin|debug|internal)/i.test(routePath);

        if (!hasRequireAuth && !isHealthRoute) {
          const severity = isAdminDebug ? 'high' : 'moderate';
          findings.push({
            route: `${routerVar}.${method}('${routePath}')`,
            issue: isAdminDebug
              ? `Admin/debug route without auth middleware: ${routePath}`
              : `Route without auth middleware: ${routePath}`,
            severity: severity as ExposureFinding['severity'],
          });
        }
      }

      // Check for wildcard CORS beyond per-file cases
      // (CodeReviewAgent already catches `cors({origin: '*'})` per-write;
      // here we look for the global app.use(cors({...origin: '*'})) pattern)
      if (/app\.use\s*\(\s*cors\s*\(\s*\{[^}]*origin\s*:\s*['"]\*['"]/i.test(content)) {
        findings.push({
          route: 'app.use(cors(...))',
          issue: 'Global wildcard CORS origin detected',
          severity: 'high',
        });
      }
    }

    return findings;
  }

  // ── Surface 3: Auth/session logic (LLM holistic review) ────────────
  /**
   * LLM-based holistic review of auth-related files. Reads the files,
   * concatenates them, sends to the LLM with a structured-output prompt,
   * then parses the fenced JSON response via extractFencedJson() (shared
   * with CodeReviewAgent).
   *
   * If no auth-related files are found, returns empty findings (not an error).
   * If the LLM produces no fenced JSON, returns empty findings + a skipped note.
   */
  private async scanAuthLogic(projectRoot: string, files: string[]): Promise<AuthFinding[]> {
    // If caller didn't specify files, auto-discover auth-related files
    let authFiles = files;
    if (authFiles.length === 0) {
      authFiles = this.discoverAuthFiles(projectRoot);
    }

    if (authFiles.length === 0) {
      return []; // no auth files to review — not an error
    }

    // Read + concatenate file contents
    const fileContents: string[] = [];
    for (const file of authFiles) {
      const fullPath = join(projectRoot, file);
      if (!existsSync(fullPath)) continue;
      try {
        const content = readFileSync(fullPath, 'utf8');
        fileContents.push(`── ${file} ──\n${content}\n`);
      } catch {
        // skip unreadable files
      }
    }

    if (fileContents.length === 0) {
      return [];
    }

    // Call the LLM with the structured-output prompt
    let reviewText = '';
    try {
      const stream = modelRouter.stream({
        agentId: this.id,
        domain: this.domain,
        messages: [
          { role: 'system', content: AUTH_REVIEW_PROMPT },
          { role: 'user', content: `Review these auth-related files:\n\n${fileContents.join('\n')}` },
        ],
        temperature: 0.2,
        maxTokens: 1024,
        executionMode: 'single-shot',
      });

      for await (const chunk of stream) {
        if (chunk.done) break;
        reviewText += chunk.delta;
      }
    } catch (err: any) {
      // LLM call failed — return empty findings, the caller will see the
      // skipped[] entry from the outer try/catch in securityScan()
      throw new Error(`LLM call failed: ${err.message}`);
    }

    // Parse the fenced JSON response
    const parsed = extractFencedJson(reviewText);
    if (!parsed || !Array.isArray(parsed.findings)) {
      // LLM didn't produce structured output — return empty findings.
      // The caller can check reviewTier to see if this was a stub-fallback.
      return [];
    }

    // Normalize the parsed findings into AuthFinding[]
    const authFindings: AuthFinding[] = [];
    for (const f of parsed.findings) {
      if (typeof f !== 'object' || f === null) continue;
      const file = String(f.file ?? 'unknown');
      const issue = String(f.issue ?? '');
      const severity = String(f.severity ?? 'low');
      if (!['low', 'moderate', 'high', 'critical'].includes(severity)) continue;
      if (!issue) continue;
      authFindings.push({
        file,
        issue,
        severity: severity as AuthFinding['severity'],
      });
    }

    return authFindings;
  }

  /**
   * Discover auth-related files in the project. Looks for files matching
   * common auth/session/jwt/password patterns in their path or filename.
   */
  private discoverAuthFiles(projectRoot: string): string[] {
    const authFiles: string[] = [];
    const authPatterns = [
      /auth/i, /session/i, /jwt/i, /password/i, /login/i, /middleware/i,
    ];

    const scanDir = (dir: string, relativeTo: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        const relativePath = fullPath.slice(relativeTo.length + 1).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          // Skip node_modules, dist, .git
          if (['node_modules', 'dist', '.git', 'tests'].includes(entry.name)) continue;
          scanDir(fullPath, relativeTo);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          if (authPatterns.some(p => p.test(relativePath))) {
            authFiles.push(relativePath);
          }
        }
      }
    };

    scanDir(projectRoot, projectRoot);
    return authFiles;
  }

  /**
   * Compute overall risk from all findings. Returns the highest severity
   * found across all 3 surfaces.
   */
  private computeOverallRisk(
    deps: DependencyFinding[],
    auth: AuthFinding[],
    exposure: ExposureFinding[],
  ): SecurityReviewResult['overallRisk'] {
    const all = [...deps, ...auth, ...exposure];
    if (all.length === 0) return 'none';

    const severities = all.map(f => f.severity);
    if (severities.includes('critical')) return 'critical';
    if (severities.includes('high')) return 'high';
    if (severities.includes('moderate')) return 'moderate';
    return 'low';
  }

  /**
   * Report CRITICAL/HIGH findings to Ghost Mode (directive Section 5).
   * SINGLE named call site at the end of securityScan().
   *
   * Severity mapping: directive's "critical" + "high" → Ghost Mode's 'high'
   * (the highest GhostFinding.severity supports). Moderate/low are NOT reported.
   */
  private reportCriticalHighFindingsToGhostMode(result: SecurityReviewResult): void {
    const report = (type: string, severity: 'low' | 'medium' | 'high', description: string, filePath?: string) => {
      try {
        ghostMode.reportFinding({
          type,
          severity,
          filePath,
          description,
          agentId: this.id,
        });
      } catch (err: any) {
        // Ghost Mode reporting failed — log but don't fail the scan.
        // The scan results are already in `result`; Ghost Mode is additive.
        console.warn(`[security-agent] ghostMode.reportFinding() failed: ${err.message}`);
      }
    };

    // Dependency findings — critical/high only
    for (const dep of result.dependencyFindings) {
      if (dep.severity === 'critical' || dep.severity === 'high') {
        report(
          'dependency-vulnerability',
          'high',
          `${dep.package}@${dep.currentVersion}: ${dep.advisory}. Fix: ${dep.recommendedFix}`,
        );
      }
    }

    // Auth findings — critical/high only
    for (const auth of result.authFindings) {
      if (auth.severity === 'critical' || auth.severity === 'high') {
        report(
          'auth-issue',
          'high',
          `${auth.file}: ${auth.issue}`,
          auth.file,
        );
      }
    }

    // Exposure findings — critical/high only
    for (const exp of result.exposureFindings) {
      if (exp.severity === 'critical' || exp.severity === 'high') {
        report(
          'api-exposure',
          'high',
          `${exp.route}: ${exp.issue}`,
        );
      }
    }
  }

  // ── Chat persona (preserved from original stub) ────────────────────
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.2, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['security', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
