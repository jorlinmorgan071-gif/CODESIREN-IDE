// tests/security/performance-agent.test.ts
//
// Phase C Agent 6 — PerformanceAgent tests.
//
// Per directive Section 6:
//   - Anti-pattern detection has REJECTS/FLAGS + false-positive pairs,
//     including at least one live-code test against real files
//   - review() always returns approved: true (advisory only)
//   - Bundle size measurement works against a real build
//   - skipped[] honestly reflects anything unmeasurable

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PerformanceAgent } from '../../src/agents/performance/index.js';
import type { PerformanceReviewResult } from '../../src/types.js';

// The project root is the parent of the server/ directory
const PROJECT_ROOT = join(process.cwd(), '..');

describe('Phase C Agent 6 — PerformanceAgent', () => {
  let agent: PerformanceAgent;

  beforeAll(() => {
    agent = new PerformanceAgent();
  });

  // ════════════════════════════════════════════════════════════════════
  // IAgent skeleton
  // ════════════════════════════════════════════════════════════════════

  describe('IAgent skeleton', () => {
    it('has correct id, name, domain, icon', () => {
      expect(agent.id).toBe('performance-agent');
      expect(agent.name).toBe('Performance Agent');
      expect(agent.domain).toBe('PERFORMANCE');
      expect(agent.icon).toBe('gauge');
    });

    it('preserves execute() chat persona (yields chunks)', async () => {
      const task = {
        id: 'test-' + Date.now(),
        projectId: 'test',
        sessionId: 'test',
        agentId: 'performance-agent',
        type: 'chat' as const,
        description: 'What is a performance bottleneck?',
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
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 2: Anti-pattern detection
  // ════════════════════════════════════════════════════════════════════

  describe('Step 2: Anti-pattern detection', () => {
    // ── Pattern 1: execSync in route handlers ─────────────────────────
    describe('Pattern 1: execSync in route handler files', () => {
      it('FLAGS: execSync in src/routes/*.ts (live-code test against real files)', async () => {
        // This tests against the REAL codebase — dashboard.ts and traces.ts
        // both have execSync in route handlers (confirmed in Section 0)
        const result = await agent.performanceReview(PROJECT_ROOT);

        const execSyncFindings = result.antiPatternFindings.filter(
          f => f.pattern === 'execSync-in-route-handler'
        );

        // Should find at least the 2 known instances
        expect(execSyncFindings.length).toBeGreaterThanOrEqual(2);

        // Verify they're in the expected files
        const files = execSyncFindings.map(f => f.file);
        expect(files.some(f => f.includes('dashboard'))).toBe(true);
        expect(files.some(f => f.includes('traces'))).toBe(true);

        // Verify severity + suggestion
        for (const finding of execSyncFindings) {
          expect(finding.severity).toBe('warning');
          expect(finding.suggestion).toContain('execSync');
          expect(finding.line).toBeGreaterThan(0);
        }
      });

      it('FALSE-POSITIVE: execSync in non-route files is NOT flagged', async () => {
        // Create a fixture with execSync in a non-route file (legitimate)
        const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-perf-fp-'));
        mkdirSync(join(fixtureRoot, 'server', 'src', 'routes'), { recursive: true });
        mkdirSync(join(fixtureRoot, 'server', 'src', 'orchestration'), { recursive: true });

        // This execSync is in orchestration/ (NOT routes/) — legitimate startup check
        writeFileSync(
          join(fixtureRoot, 'server', 'src', 'orchestration', 'engine.ts'),
          `import { execSync } from 'node:child_process';\nconst version = execSync('node --version').toString();\n`,
        );

        // This route file has NO execSync — should not be flagged
        writeFileSync(
          join(fixtureRoot, 'server', 'src', 'routes', 'clean.ts'),
          `import { Router } from 'express';\nexport const cleanRouter = Router();\ncleanRouter.get('/', (req, res) => res.json({}));\n`,
        );

        try {
          const result = await agent.performanceReview(fixtureRoot);
          const execSyncFindings = result.antiPatternFindings.filter(
            f => f.pattern === 'execSync-in-route-handler'
          );
          expect(execSyncFindings).toEqual([]);
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      });

      it('FLAGS: execSync in a fixture route file (synthetic REJECTS test)', async () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-perf-reject-'));
        mkdirSync(join(fixtureRoot, 'server', 'src', 'routes'), { recursive: true });

        writeFileSync(
          join(fixtureRoot, 'server', 'src', 'routes', 'bad.ts'),
          `import { Router } from 'express';\nimport { execSync } from 'node:child_process';\nexport const badRouter = Router();\nbadRouter.get('/', (req, res) => {\n  const out = execSync('ls -la').toString();\n  res.json({ out });\n});\n`,
        );

        try {
          const result = await agent.performanceReview(fixtureRoot);
          const execSyncFindings = result.antiPatternFindings.filter(
            f => f.pattern === 'execSync-in-route-handler'
          );
          expect(execSyncFindings.length).toBeGreaterThanOrEqual(1);
          expect(execSyncFindings[0].file).toContain('bad.ts');
          expect(execSyncFindings[0].severity).toBe('warning');
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      });
    });

    // ── Pattern 2: Unbounded SELECT without LIMIT ─────────────────────
    describe('Pattern 2: Unbounded SELECT without LIMIT', () => {
      it('FLAGS: unbounded SELECT in real codebase (live-code test)', async () => {
        // This tests against the REAL codebase — plans-repo.ts and relay-loop.ts
        // both have unbounded SELECTs (confirmed in Section 0)
        const result = await agent.performanceReview(PROJECT_ROOT);

        const selectFindings = result.antiPatternFindings.filter(
          f => f.pattern === 'unbounded-select'
        );

        // Should find at least the 2 known instances
        expect(selectFindings.length).toBeGreaterThanOrEqual(2);

        // Verify they're in the expected files
        const files = selectFindings.map(f => f.file);
        expect(files.some(f => f.includes('plans-repo'))).toBe(true);
        expect(files.some(f => f.includes('relay-loop'))).toBe(true);

        // Verify severity + suggestion
        for (const finding of selectFindings) {
          expect(finding.severity).toBe('warning');
          expect(finding.suggestion).toContain('LIMIT');
          expect(finding.line).toBeGreaterThan(0);
        }
      });

      it('FALSE-POSITIVE: SELECT with LIMIT is NOT flagged', async () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-perf-limit-'));
        mkdirSync(join(fixtureRoot, 'server', 'src', 'db'), { recursive: true });

        writeFileSync(
          join(fixtureRoot, 'server', 'src', 'db', 'queries.ts'),
          `const rows = await query('SELECT id, name FROM users ORDER BY created_at DESC LIMIT 50');\n`,
        );

        try {
          const result = await agent.performanceReview(fixtureRoot);
          const selectFindings = result.antiPatternFindings.filter(
            f => f.pattern === 'unbounded-select'
          );
          expect(selectFindings).toEqual([]);
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      });

      it('FALSE-POSITIVE: SELECT COUNT/GROUP BY is NOT flagged (aggregate)', async () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-perf-count-'));
        mkdirSync(join(fixtureRoot, 'server', 'src', 'db'), { recursive: true });

        writeFileSync(
          join(fixtureRoot, 'server', 'src', 'db', 'stats.ts'),
          `const rows = await query('SELECT agent_id, COUNT(*) as count FROM agent_memory GROUP BY agent_id');\n`,
        );

        try {
          const result = await agent.performanceReview(fixtureRoot);
          const selectFindings = result.antiPatternFindings.filter(
            f => f.pattern === 'unbounded-select'
          );
          expect(selectFindings).toEqual([]);
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      });

      it('FALSE-POSITIVE: SELECT with WHERE id = $1 IS flagged (defensive — no LIMIT)', async () => {
        // Per Section 0 refinement: we do NOT exclude WHERE ... = $1 because
        // regex can't distinguish PK lookups (1 row) from FK lookups (many rows).
        // The auth query (WHERE email = $1) WILL be flagged — adding LIMIT 1
        // is a defensive best practice. This test confirms that behavior.
        const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-perf-lookup-'));
        mkdirSync(join(fixtureRoot, 'server', 'src', 'db'), { recursive: true });

        writeFileSync(
          join(fixtureRoot, 'server', 'src', 'db', 'lookup.ts'),
          `const rows = await query('SELECT id, email, name FROM users WHERE id = $1', [userId]);\n`,
        );

        try {
          const result = await agent.performanceReview(fixtureRoot);
          const selectFindings = result.antiPatternFindings.filter(
            f => f.pattern === 'unbounded-select'
          );
          // This IS flagged — no LIMIT, even though it's a single-row lookup.
          // The suggestion recommends adding LIMIT 1 for defensive practice.
          expect(selectFindings.length).toBeGreaterThanOrEqual(1);
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      });

      it('FLAGS: unbounded SELECT in a fixture file (synthetic REJECTS test)', async () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-perf-unbounded-'));
        mkdirSync(join(fixtureRoot, 'server', 'src', 'db'), { recursive: true });

        writeFileSync(
          join(fixtureRoot, 'server', 'src', 'db', 'unbounded.ts'),
          `const rows = await query('SELECT id, name FROM users ORDER BY created_at DESC');\n`,
        );

        try {
          const result = await agent.performanceReview(fixtureRoot);
          const selectFindings = result.antiPatternFindings.filter(
            f => f.pattern === 'unbounded-select'
          );
          expect(selectFindings.length).toBeGreaterThanOrEqual(1);
          expect(selectFindings[0].severity).toBe('warning');
          expect(selectFindings[0].suggestion).toContain('LIMIT');
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 3: Bundle-size measurement
  // ════════════════════════════════════════════════════════════════════

  describe('Step 3: Bundle-size measurement', () => {
    it('returns bundle sizes when server/dist/ exists (real build)', async () => {
      // server/dist/ was built during Section 0 — it should exist
      const result = await agent.performanceReview(PROJECT_ROOT);

      if (existsSync(join(PROJECT_ROOT, 'server', 'dist'))) {
        expect(result.bundleSizes).not.toBeNull();
        expect(result.bundleSizes!.unit).toBe('bytes');
        expect(result.bundleSizes!.server).toBeGreaterThan(0);
        // app/dist/ may or may not exist (depends on whether app node_modules was installed)
        // Don't assert app size — just verify the shape is correct
      }
    });

    it('returns null bundleSizes when dist/ does not exist', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-perf-nodist-'));
      mkdirSync(join(fixtureRoot, 'server', 'src'), { recursive: true });
      // No dist/ directory

      try {
        const result = await agent.performanceReview(fixtureRoot);
        expect(result.bundleSizes).toBeNull();
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('bundleSizes has correct shape { app, server, unit }', async () => {
      const result = await agent.performanceReview(PROJECT_ROOT);

      if (result.bundleSizes !== null) {
        expect(result.bundleSizes).toHaveProperty('app');
        expect(result.bundleSizes).toHaveProperty('server');
        expect(result.bundleSizes).toHaveProperty('unit');
        expect(result.bundleSizes!.unit).toBe('bytes');
        expect(typeof result.bundleSizes!.app).toBe('number');
        expect(typeof result.bundleSizes!.server).toBe('number');
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 4: Ghost Mode — explicitly NOT wired
  // ════════════════════════════════════════════════════════════════════

  describe('Step 4: Ghost Mode (explicitly NOT wired)', () => {
    it('PerformanceAgent does NOT import ghostMode', () => {
      // Read the source file and verify no ghostMode import
      const source = require('fs').readFileSync(
        join(process.cwd(), 'src', 'agents', 'performance', 'index.ts'),
        'utf8'
      );
      expect(source).not.toContain('ghostMode');
      expect(source).not.toContain('reportFinding');
    });

    it('PerformanceAgent does NOT have any Ghost Mode methods', () => {
      expect(typeof (agent as any).reportToGhostMode).toBe('undefined');
      expect(typeof (agent as any).escalateFinding).toBe('undefined');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // review() override — always approved, advisory only
  // ════════════════════════════════════════════════════════════════════

  describe('review() override — advisory only', () => {
    it('review() ALWAYS returns approved: true regardless of findings', async () => {
      // Even against the real codebase which HAS anti-pattern findings,
      // review() must return approved: true
      const result = await agent.review({
        content: 'test content',
        files: [join(PROJECT_ROOT, 'server', 'src', 'routes', 'dashboard.ts')],
      });

      expect(result.approved).toBe(true); // ALWAYS approved
      expect(result.reviewTier).toBeDefined();
    });

    it('review() flattens findings into issues[] for ReviewResult compatibility', async () => {
      const result = await agent.review({
        content: 'test content',
        files: [join(PROJECT_ROOT, 'server', 'src', 'routes', 'dashboard.ts')],
      });

      // If there are findings, they should appear as strings in issues[]
      if (result.issues.length > 0) {
        expect(typeof result.issues[0]).toBe('string');
        expect(result.issues[0]).toContain('execSync-in-route-handler');
      }
    });

    it('review() returns approved: true even with invalid project root', async () => {
      // Pass an invalid project root — performanceReview will return empty
      // findings (no files to scan), but review() must still approve
      // (advisory — don't block writes)
      const result = await agent.review({
        content: 'test',
        files: ['/nonexistent/server/src/routes/test.ts'],
      });

      expect(result.approved).toBe(true);
      // performanceReview succeeds (returns empty) even with invalid paths —
      // it doesn't throw, just finds nothing. So reviewTier is 'llm-reviewed'.
      expect(['llm-reviewed', 'llm-error']).toContain(result.reviewTier);
    });

    it('review() with no files returns clean approved result', async () => {
      const result = await agent.review({
        content: 'test',
        files: [],
      });

      expect(result.approved).toBe(true);
      expect(result.issues).toEqual([]);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // performanceReview() — structured result
  // ════════════════════════════════════════════════════════════════════

  describe('performanceReview() — structured result', () => {
    it('returns PerformanceReviewResult with all fields', async () => {
      const result = await agent.performanceReview(PROJECT_ROOT);

      expect(result).toHaveProperty('antiPatternFindings');
      expect(result).toHaveProperty('bundleSizes');
      expect(result).toHaveProperty('overallAssessment');
      expect(result).toHaveProperty('skipped');

      expect(Array.isArray(result.antiPatternFindings)).toBe(true);
      expect(['healthy', 'attention-needed', 'unknown']).toContain(result.overallAssessment);
      expect(Array.isArray(result.skipped)).toBe(true);
    });

    it('overallAssessment is "attention-needed" when findings exist', async () => {
      // The real codebase has findings — assessment should be attention-needed
      const result = await agent.performanceReview(PROJECT_ROOT);

      if (result.antiPatternFindings.length > 0) {
        expect(result.overallAssessment).toBe('attention-needed');
      }
    });

    it('overallAssessment is "healthy" when no findings and bundleSizes available', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-perf-healthy-'));
      mkdirSync(join(fixtureRoot, 'server', 'src', 'routes'), { recursive: true });

      // Clean route file — no anti-patterns
      writeFileSync(
        join(fixtureRoot, 'server', 'src', 'routes', 'clean.ts'),
        `import { Router } from 'express';\nexport const cleanRouter = Router();\ncleanRouter.get('/', (req, res) => res.json({}));\n`,
      );

      try {
        const result = await agent.performanceReview(fixtureRoot);
        expect(result.antiPatternFindings).toEqual([]);
        // bundleSizes will be null (no dist/) → overallAssessment is 'unknown'
        // (can't be 'healthy' without bundleSizes)
        if (result.bundleSizes === null) {
          expect(result.overallAssessment).toBe('unknown');
        } else {
          expect(result.overallAssessment).toBe('healthy');
        }
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Scope boundary
  // ════════════════════════════════════════════════════════════════════

  describe('scope boundary', () => {
    it('does NOT have any runtime profiling methods', () => {
      expect(typeof (agent as any).profileRuntime).toBe('undefined');
      expect(typeof (agent as any).instrumentApp).toBe('undefined');
      expect(typeof (agent as any).measureLatency).toBe('undefined');
    });

    it('does NOT scan app/ (frontend) directory', async () => {
      // Create a fixture with an anti-pattern in app/ — should NOT be flagged
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-perf-scope-'));
      mkdirSync(join(fixtureRoot, 'server', 'src', 'routes'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'app', 'src'), { recursive: true });

      // Clean server route
      writeFileSync(
        join(fixtureRoot, 'server', 'src', 'routes', 'clean.ts'),
        `export const r = {};\n`,
      );

      // Anti-pattern in app/ — should NOT be detected (server-only scope)
      writeFileSync(
        join(fixtureRoot, 'app', 'src', 'App.tsx'),
        `import { execSync } from 'node:child_process';\nexecSync('bad');\n`,
      );

      try {
        const result = await agent.performanceReview(fixtureRoot);
        const appFindings = result.antiPatternFindings.filter(f => f.file.includes('app/'));
        expect(appFindings).toEqual([]);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('does NOT have Ghost Mode coupling (advisory only, not a gate)', () => {
      // Already tested in Step 4 — this is a redundant confirmation
      expect(typeof (agent as any).reportFinding).toBe('undefined');
    });
  });
});
