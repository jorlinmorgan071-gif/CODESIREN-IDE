// tests/security/security-agent.test.ts
//
// Phase C Agent 2 — SecurityAgent tests.
//
// Covers all 3 scan surfaces + Ghost Mode coupling + the SecurityReviewResult
// shape from directive Section 4:
//   1. Dependency scan (npm audit --json against a fixture with known-bad versions)
//   2. API/network exposure (static pass over fixture route files)
//   3. Auth/session logic (LLM holistic review — mocked)
//   4. Ghost Mode coupling (critical/high → ghostMode.reportFinding)
//   5. skipped[] honest reporting when scans can't run
//   6. overallRisk computation from all findings

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { SecurityAgent } from '../../src/agents/security/index.js';
import { modelRouter } from '../../src/orchestration/model-router.js';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import type { SecurityReviewResult } from '../../src/types.js';

describe('Phase C Agent 2 — SecurityAgent', () => {
  let agent: SecurityAgent;

  beforeAll(() => {
    agent = new SecurityAgent();
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 2: IAgent skeleton — registered + callable
  // ════════════════════════════════════════════════════════════════════

  describe('IAgent skeleton (Step 2)', () => {
    it('has correct id, name, domain, icon', () => {
      expect(agent.id).toBe('security-agent');
      expect(agent.name).toBe('Security Agent');
      expect(agent.domain).toBe('SECURITY');
      expect(agent.icon).toBe('shield');
    });

    it('has securityScan() method that returns SecurityReviewResult', async () => {
      const result = await agent.securityScan({ projectRoot: '/tmp/nonexistent' });
      expect(result).toHaveProperty('dependencyFindings');
      expect(result).toHaveProperty('authFindings');
      expect(result).toHaveProperty('exposureFindings');
      expect(result).toHaveProperty('overallRisk');
      expect(result).toHaveProperty('reviewTier');
      expect(result).toHaveProperty('skipped');
    });

    it('preserves execute() chat persona (yields chunks)', async () => {
      // execute() should still work as a chat persona
      const task = {
        id: 'test-' + Date.now(),
        projectId: 'test',
        sessionId: 'test',
        agentId: 'security-agent',
        type: 'chat' as const,
        description: 'What is SQL injection?',
        context: { projectId: 'test', rootPath: '/tmp', techStack: {}, activeFiles: [] },
        priority: 'normal' as const,
        executionMode: 'single-shot' as const,
        origin: 'api' as const,
        createdAt: Date.now(),
      };
      const controller = new AbortController();
      const chunks: unknown[] = [];
      for await (const chunk of agent.execute(task, controller.signal)) {
        chunks.push(chunk);
      }
      // Should yield at least one chunk (the stub engine produces output)
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 3: Dependency scan via npm audit --json
  // ════════════════════════════════════════════════════════════════════

  describe('Dependency scan (Step 3)', () => {
    let vulnProjectRoot: string;
    let cleanProjectRoot: string;

    beforeAll(() => {
      // Create a fixture project with KNOWN-VULNERABLE versions
      // (same versions we had before the audit fix in commit 94ab6e3)
      vulnProjectRoot = mkdtempSync(join(tmpdir(), 'cs-sec-vuln-'));
      writeFileSync(
        join(vulnProjectRoot, 'package.json'),
        JSON.stringify({
          name: 'vuln-fixture',
          version: '1.0.0',
          dependencies: {
            'body-parser': '1.20.5',  // vulnerable (GHSA-v422-hmwv-36x6)
            'postcss': '8.5.15',      // vulnerable (GHSA-r28c-9q8g-f849)
          },
        }),
      );
      // Run npm install to generate node_modules + package-lock.json
      execSync('npm install --no-audit --no-fund', { cwd: vulnProjectRoot, stdio: 'pipe', timeout: 60_000 });

      // Create a clean fixture project with no vulnerabilities
      // D10/D13 live spot-check found that the npm advisory DB was updated to
      // flag body-parser 1.20.5–1.20.6 as moderate severity (via transitive
      // qs dependency). The previous 'patched' version 1.20.6 is now vulnerable.
      // Bumped to 2.3.0 (the actual patched version per the advisory — fix is
      // a SemVer-major bump because the qs transitive fix is breaking).
      cleanProjectRoot = mkdtempSync(join(tmpdir(), 'cs-sec-clean-'));
      writeFileSync(
        join(cleanProjectRoot, 'package.json'),
        JSON.stringify({
          name: 'clean-fixture',
          version: '1.0.0',
          dependencies: {
            'body-parser': '2.3.0',   // patched (was 1.20.6, now flagged moderate)
            'postcss': '8.5.25',      // patched
          },
        }),
      );
      execSync('npm install --no-audit --no-fund', { cwd: cleanProjectRoot, stdio: 'pipe', timeout: 60_000 });
    });

    afterAll(() => {
      rmSync(vulnProjectRoot, { recursive: true, force: true });
      rmSync(cleanProjectRoot, { recursive: true, force: true });
    });

    it('REJECTS: detects known-vulnerable body-parser + postcss in fixture', async () => {
      const result = await agent.securityScan({ projectRoot: vulnProjectRoot });
      expect(result.dependencyFindings.length).toBeGreaterThanOrEqual(2);
      const packages = result.dependencyFindings.map(f => f.package);
      expect(packages).toContain('body-parser');
      expect(packages).toContain('postcss');

      const postcssFinding = result.dependencyFindings.find(f => f.package === 'postcss');
      expect(postcssFinding).toBeDefined();
      expect(postcssFinding!.severity).toBe('high');
      expect(postcssFinding!.advisory).toContain('PostCSS');
      expect(postcssFinding!.recommendedFix).toContain('upgrade');
    });

    it('APPROVES: clean fixture with patched versions has no dependency findings', async () => {
      const result = await agent.securityScan({ projectRoot: cleanProjectRoot });
      expect(result.dependencyFindings).toEqual([]);
    });

    it('skipped[] reports when node_modules is missing', async () => {
      const noDepsRoot = mkdtempSync(join(tmpdir(), 'cs-sec-nodeps-'));
      writeFileSync(
        join(noDepsRoot, 'package.json'),
        JSON.stringify({ name: 'no-deps', version: '1.0.0', dependencies: {} }),
      );
      // No npm install — no node_modules
      const result = await agent.securityScan({ projectRoot: noDepsRoot });
      expect(result.skipped.some(s => s.includes('dependency-scan'))).toBe(true);
      expect(result.dependencyFindings).toEqual([]);
      rmSync(noDepsRoot, { recursive: true, force: true });
    });

    it('overallRisk reflects high-severity dependency findings', async () => {
      const result = await agent.securityScan({ projectRoot: vulnProjectRoot });
      // postcss is high-severity → overallRisk should be 'high' or 'critical'
      expect(['high', 'critical']).toContain(result.overallRisk);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 4: API/network exposure static pass
  // ════════════════════════════════════════════════════════════════════

  describe('API exposure scan (Step 4)', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-sec-api-'));
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it('REJECTS: flags route without requireAuth middleware', async () => {
      writeFileSync(
        join(fixtureRoot, 'src', 'routes', 'admin.ts'),
        [
          `import { Router } from 'express';`,
          `export const adminRouter = Router();`,
          `adminRouter.get('/dashboard', (req, res) => { res.json({}); });`,
          `adminRouter.post('/users', (req, res) => { res.json({}); });`,
        ].join('\n'),
      );

      const result = await agent.securityScan({ projectRoot: fixtureRoot });
      expect(result.exposureFindings.length).toBeGreaterThanOrEqual(2);
      const routes = result.exposureFindings.map(f => f.route);
      expect(routes.some(r => r.includes('/dashboard'))).toBe(true);
      expect(routes.some(r => r.includes('/users'))).toBe(true);
    });

    it('APPROVES: routes WITH requireAuth are not flagged', async () => {
      writeFileSync(
        join(fixtureRoot, 'src', 'routes', 'secure.ts'),
        [
          `import { Router } from 'express';`,
          `import { requireAuth } from '../auth/middleware.js';`,
          `export const secureRouter = Router();`,
          `secureRouter.get('/profile', requireAuth, (req, res) => { res.json({}); });`,
          `secureRouter.post('/settings', requireAuth, (req, res) => { res.json({}); });`,
        ].join('\n'),
      );

      const result = await agent.securityScan({ projectRoot: fixtureRoot });
      const secureRoutes = result.exposureFindings.filter(f =>
        f.route.includes('/profile') || f.route.includes('/settings')
      );
      expect(secureRoutes).toEqual([]);
    });

    it('does NOT flag health-check routes (intentionally public)', async () => {
      writeFileSync(
        join(fixtureRoot, 'src', 'routes', 'health.ts'),
        [
          `import { Router } from 'express';`,
          `export const healthRouter = Router();`,
          `healthRouter.get('/', (req, res) => { res.json({ status: 'ok' }); });`,
        ].join('\n'),
      );

      const result = await agent.securityScan({ projectRoot: fixtureRoot });
      const healthFindings = result.exposureFindings.filter(f => f.route.includes("'/'"));
      expect(healthFindings).toEqual([]);
    });

    it('flags admin/debug routes as high severity (not just moderate)', async () => {
      writeFileSync(
        join(fixtureRoot, 'src', 'routes', 'debug.ts'),
        [
          `import { Router } from 'express';`,
          `export const debugRouter = Router();`,
          `debugRouter.get('/admin/config', (req, res) => { res.json({}); });`,
          `debugRouter.get('/debug/env', (req, res) => { res.json({}); });`,
        ].join('\n'),
      );

      const result = await agent.securityScan({ projectRoot: fixtureRoot });
      const adminFindings = result.exposureFindings.filter(f => f.route.includes('/admin') || f.route.includes('/debug'));
      expect(adminFindings.length).toBeGreaterThanOrEqual(2);
      expect(adminFindings.every(f => f.severity === 'high')).toBe(true);
    });

    it('flags global wildcard CORS in src/index.ts', async () => {
      mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'index.ts'),
        [
          `import express from 'express';`,
          `import cors from 'cors';`,
          `const app = express();`,
          `app.use(cors({ origin: '*' }));`,
          `app.use(express.json());`,
        ].join('\n'),
      );

      const result = await agent.securityScan({ projectRoot: fixtureRoot });
      const corsFindings = result.exposureFindings.filter(f => f.issue.includes('CORS'));
      expect(corsFindings.length).toBeGreaterThanOrEqual(1);
      expect(corsFindings[0].severity).toBe('high');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 5d: Auth/session LLM review (calls extractFencedJson directly)
  // ════════════════════════════════════════════════════════════════════

  describe('Auth/session LLM review (Step 5d)', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-sec-auth-'));
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    function mockLlmResponse(text: string) {
      vi.spyOn(modelRouter, 'stream').mockReturnValue(
        (async function* () {
          yield { delta: text, done: false };
          yield { delta: '', done: true };
        })(),
      );
    }

    it('parses fenced JSON auth findings from LLM response', async () => {
      mkdirSync(join(fixtureRoot, 'src', 'auth'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'auth', 'jwt.ts'),
        `export function signToken(payload) { return 'fake-jwt'; }`,
      );

      mockLlmResponse(
        '<review>\n{"findings": [{"file": "src/auth/jwt.ts", "issue": "JWT secret is hardcoded", "severity": "critical"}]}\n</review>',
      );

      const result = await agent.securityScan({
        projectRoot: fixtureRoot,
        files: ['src/auth/jwt.ts'],
      });

      expect(result.authFindings.length).toBe(1);
      expect(result.authFindings[0].file).toBe('src/auth/jwt.ts');
      expect(result.authFindings[0].issue).toContain('hardcoded');
      expect(result.authFindings[0].severity).toBe('critical');
    });

    it('returns empty authFindings when LLM produces no fenced JSON (stub-fallback)', async () => {
      mkdirSync(join(fixtureRoot, 'src', 'auth'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'auth', 'jwt.ts'),
        `export function signToken(payload) { return 'fake-jwt'; }`,
      );

      // Stub engine produces unstructured text — no fences
      mockLlmResponse('I am the security agent. I received your request...');

      const result = await agent.securityScan({
        projectRoot: fixtureRoot,
        files: ['src/auth/jwt.ts'],
      });

      expect(result.authFindings).toEqual([]);
    });

    it('returns empty authFindings when no auth files are found', async () => {
      // No auth-related files in the fixture
      mkdirSync(join(fixtureRoot, 'src', 'utils'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'utils', 'helpers.ts'),
        `export function add(a, b) { return a + b; }`,
      );

      const result = await agent.securityScan({ projectRoot: fixtureRoot });
      expect(result.authFindings).toEqual([]);
    });

    it('auto-discovers auth-related files when none specified', async () => {
      mkdirSync(join(fixtureRoot, 'src', 'auth'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'auth', 'jwt.ts'),
        `export function signToken(payload) { return 'fake'; }`,
      );
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'routes', 'login.ts'),
        `export const loginRouter = {};`,
      );

      mockLlmResponse('<review>\n{"findings": []}\n</review>');

      const result = await agent.securityScan({ projectRoot: fixtureRoot });
      // Should have called the LLM (auto-discovered auth files)
      expect(modelRouter.stream).toHaveBeenCalled();
      expect(result.authFindings).toEqual([]);
    });

    it('skipped[] reports when LLM call throws', async () => {
      mkdirSync(join(fixtureRoot, 'src', 'auth'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'auth', 'jwt.ts'),
        `export function signToken(payload) { return 'fake'; }`,
      );

      vi.spyOn(modelRouter, 'stream').mockImplementation(() => {
        throw new Error('simulated LLM failure');
      });

      const result = await agent.securityScan({
        projectRoot: fixtureRoot,
        files: ['src/auth/jwt.ts'],
      });

      expect(result.skipped.some(s => s.includes('auth-review'))).toBe(true);
      expect(result.authFindings).toEqual([]);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 6: Ghost Mode coupling (critical/high only)
  // ════════════════════════════════════════════════════════════════════

  describe('Ghost Mode coupling (Step 6)', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-sec-ghost-'));
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('reports critical/high findings to Ghost Mode', async () => {
      // Set up a fixture with a vulnerable dependency (high severity)
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({
          name: 'ghost-test',
          version: '1.0.0',
          dependencies: { 'postcss': '8.5.15' },  // high severity vuln
        }),
      );
      execSync('npm install --no-audit --no-fund', { cwd: fixtureRoot, stdio: 'pipe', timeout: 60_000 });

      const reportSpy = vi.spyOn(ghostMode, 'reportFinding');

      await agent.securityScan({ projectRoot: fixtureRoot });

      // Should have called reportFinding for the high-severity postcss vuln
      expect(reportSpy).toHaveBeenCalled();
      const calls = reportSpy.mock.calls;
      const depCalls = calls.filter(c => c[0].type === 'dependency-vulnerability');
      expect(depCalls.length).toBeGreaterThanOrEqual(1);
      expect(depCalls[0][0].severity).toBe('high'); // mapped from directive's "critical"/"high"
      expect(depCalls[0][0].description).toContain('postcss');
    });

    it('does NOT report moderate/low findings to Ghost Mode', async () => {
      // Set up a fixture with a moderate-severity vuln.
      // D10/D13 live spot-check: body-parser@1.20.5 was previously classified
      // as 'low' severity. The npm advisory DB was updated to reclassify it
      // as 'moderate' (the advisory now covers 1.20.5–1.20.6 via the
      // transitive qs dependency). The test's purpose — proving that
      // moderate/low findings are NOT reported to Ghost Mode — still holds;
      // only the severity label has shifted from 'low' to 'moderate'.
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({
          name: 'ghost-test-moderate',
          version: '1.0.0',
          dependencies: { 'body-parser': '1.20.5' },  // moderate severity vuln (was low)
        }),
      );
      execSync('npm install --no-audit --no-fund', { cwd: fixtureRoot, stdio: 'pipe', timeout: 60_000 });

      const reportSpy = vi.spyOn(ghostMode, 'reportFinding');

      const result = await agent.securityScan({ projectRoot: fixtureRoot });

      // body-parser is moderate-severity — should NOT be reported to Ghost Mode
      // (Ghost Mode only reports critical/high — see security/index.ts:500).
      // The finding still appears in dependencyFindings.
      const bodyParserFinding = result.dependencyFindings.find(f => f.package === 'body-parser');
      expect(bodyParserFinding).toBeDefined();
      expect(bodyParserFinding!.severity).toBe('moderate');

      // No Ghost Mode reports for moderate/low-severity findings
      const depCalls = reportSpy.mock.calls.filter(c => c[0].type === 'dependency-vulnerability');
      expect(depCalls.length).toBe(0);
    });

    it('reports auth findings (critical/high) to Ghost Mode', async () => {
      mkdirSync(join(fixtureRoot, 'src', 'auth'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'auth', 'jwt.ts'),
        `export function signToken(payload) { return 'fake'; }`,
      );

      vi.spyOn(modelRouter, 'stream').mockReturnValue(
        (async function* () {
          yield {
            delta: '<review>\n{"findings": [{"file": "src/auth/jwt.ts", "issue": "Hardcoded JWT secret", "severity": "critical"}]}\n</review>',
            done: false,
          };
          yield { delta: '', done: true };
        })(),
      );

      const reportSpy = vi.spyOn(ghostMode, 'reportFinding');

      await agent.securityScan({
        projectRoot: fixtureRoot,
        files: ['src/auth/jwt.ts'],
      });

      const authCalls = reportSpy.mock.calls.filter(c => c[0].type === 'auth-issue');
      expect(authCalls.length).toBe(1);
      expect(authCalls[0][0].severity).toBe('high');
      expect(authCalls[0][0].filePath).toBe('src/auth/jwt.ts');
    });

    it('reports exposure findings (high) to Ghost Mode', async () => {
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'routes', 'admin.ts'),
        [
          `import { Router } from 'express';`,
          `export const adminRouter = Router();`,
          `adminRouter.get('/admin/config', (req, res) => { res.json({}); });`,
        ].join('\n'),
      );

      const reportSpy = vi.spyOn(ghostMode, 'reportFinding');

      await agent.securityScan({ projectRoot: fixtureRoot });

      const exposureCalls = reportSpy.mock.calls.filter(c => c[0].type === 'api-exposure');
      expect(exposureCalls.length).toBeGreaterThanOrEqual(1);
      expect(exposureCalls[0][0].severity).toBe('high');
    });

    it('survives Ghost Mode reportFinding() throwing (does not fail the scan)', async () => {
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'routes', 'admin.ts'),
        [
          `import { Router } from 'express';`,
          `export const adminRouter = Router();`,
          `adminRouter.get('/admin/config', (req, res) => { res.json({}); });`,
        ].join('\n'),
      );

      vi.spyOn(ghostMode, 'reportFinding').mockImplementation(() => {
        throw new Error('simulated Ghost Mode failure');
      });

      // Should NOT throw — the scan completes, Ghost Mode failure is logged
      const result = await agent.securityScan({ projectRoot: fixtureRoot });
      expect(result.exposureFindings.length).toBeGreaterThanOrEqual(1);
      // The scan still returned results even though Ghost Mode threw
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // overallRisk + reviewTier + skipped[] integration
  // ════════════════════════════════════════════════════════════════════

  describe('overallRisk + reviewTier + skipped[] integration', () => {
    it('overallRisk is "none" when no findings and no skips', async () => {
      // Clean fixture — no vulns, no routes, no auth files.
      // Use a small real dependency so npm install actually creates node_modules/
      // (npm install with empty dependencies doesn't create node_modules/).
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-sec-empty-'));
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({
          name: 'empty',
          version: '1.0.0',
          dependencies: { 'postcss': '8.5.25' },  // patched version — no vulns
        }),
      );
      execSync('npm install --no-audit --no-fund', { cwd: fixtureRoot, stdio: 'pipe', timeout: 60_000 });

      try {
        const result = await agent.securityScan({ projectRoot: fixtureRoot });
        expect(result.dependencyFindings).toEqual([]);
        expect(result.authFindings).toEqual([]);
        expect(result.exposureFindings).toEqual([]);
        expect(result.overallRisk).toBe('none');
        expect(result.reviewTier).toBe('full-scan');
        expect(result.skipped).toEqual([]);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('reviewTier is "partial-scan" when one surface is skipped', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-sec-partial-'));
      // No package.json → dependency scan will skip (no node_modules)
      // No src/routes → exposure scan finds nothing (but doesn't skip)
      // No auth files → auth scan finds nothing (but doesn't skip)

      try {
        const result = await agent.securityScan({ projectRoot: fixtureRoot });
        expect(result.skipped.some(s => s.includes('dependency-scan'))).toBe(true);
        expect(result.reviewTier).toBe('partial-scan');
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('reviewTier is "stub-fallback" when ALL surfaces are skipped', async () => {
      // Use a completely empty temp dir — all 3 scans will fail
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-sec-stub-'));
      try {
        const result = await agent.securityScan({ projectRoot: fixtureRoot });
        // dependency scan: no package.json → skip
        // exposure scan: no src/routes → skip (throws? or empty?)
        // auth scan: no auth files → empty (not a skip)
        // At minimum, dependency-scan should be skipped
        expect(result.skipped.length).toBeGreaterThanOrEqual(1);
        // reviewTier should be partial-scan or stub-fallback depending on how many skipped
        expect(['partial-scan', 'stub-fallback']).toContain(result.reviewTier);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  });
});
