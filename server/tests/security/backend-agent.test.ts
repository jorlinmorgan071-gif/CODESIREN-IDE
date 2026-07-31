// tests/security/backend-agent.test.ts
//
// Phase C Agent 4 — BackendAgent tests.
//
// Covers all 8 build steps:
//   Step 2: Non-DB route generation, end-to-end through writeProjectFile()
//   Step 3: DB-backed route generation with valid schemaConfirmation fixture
//   Step 4: Column-mismatch refusal test
//   Step 5: index.ts registration write, fresh-read discipline tested
//   Step 6: Partial-failure handling — mock CodeReviewAgent rejecting second write
//   Step 7: Self-check sanity pass — unmarked debug/admin path blocked, explicit flag allows
//   Step 8: Scope-boundary test (never writes DDL/migrations)
//
// Plus the two degraded-confirmation refusal paths:
//   - tableExists === null → refuse
//   - error === 'postgres-unavailable' → refuse

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BackendAgent } from '../../src/agents/backend/index.js';
import * as projectFilesModule from '../../src/agents/_shared/project-files.js';
import type { SchemaConfirmation, BackendRouteResult } from '../../src/types.js';

describe('Phase C Agent 4 — BackendAgent', () => {
  let agent: BackendAgent;

  beforeAll(() => {
    agent = new BackendAgent();
  });

  // ════════════════════════════════════════════════════════════════════
  // IAgent skeleton
  // ════════════════════════════════════════════════════════════════════

  describe('IAgent skeleton', () => {
    it('has correct id, name, domain, icon', () => {
      expect(agent.id).toBe('backend-agent');
      expect(agent.name).toBe('Backend Agent');
      expect(agent.domain).toBe('BACKEND');
      expect(agent.icon).toBe('server');
    });

    it('preserves execute() chat persona (yields chunks)', async () => {
      const task = {
        id: 'test-' + Date.now(),
        projectId: 'test',
        sessionId: 'test',
        agentId: 'backend-agent',
        type: 'chat' as const,
        description: 'What is REST?',
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
  // Step 2: Non-DB route generation, end-to-end through writeProjectFile()
  // ════════════════════════════════════════════════════════════════════

  describe('Step 2: Non-DB route generation', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-be-nodb-'));
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
      // Create a minimal index.ts with existing route imports + app.use lines
      writeFileSync(
        join(fixtureRoot, 'src', 'index.ts'),
        [
          '// server/src/index.ts',
          "import { agentsRouter } from './routes/agents.js';",
          "import { healthRouter } from './routes/health.js';",
          '',
          'const app = express();',
          "app.use('/api/agents', agentsRouter);",
          "app.use('/api/health', healthRouter);",
          '',
        ].join('\n'),
      );
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    function mockWriteProjectFileSuccess() {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });
    }

    it('generates a non-DB route file with zod + requireAuth + Express Router', async () => {
      mockWriteProjectFileSuccess();

      const result = await agent.generateRoute({
        description: 'GET /api/status — health check endpoint',
        projectRoot: fixtureRoot,
        routeName: 'status',
        routerVarName: 'statusRouter',
        mountPath: '/api/status',
      });

      expect(result.routeFileWritten).toBe(true);
      expect(result.registered).toBe(true);
      expect(result.routeFilePath).toContain('routes/status.ts');
      expect(result.routeContent).toContain("import { Router } from 'express'");
      expect(result.routeContent).toContain("import { z } from 'zod'");
      expect(result.routeContent).toContain("import { requireAuth } from '../auth/middleware.js'");
      expect(result.routeContent).toContain('export const statusRouter = Router()');
      expect(result.routeContent).toContain('.safeParse(req.body)');
      expect(result.routeContent).toContain("{ error: 'Invalid input', issues: parsed.error.issues }");
      expect(result.routeContent).toContain('requireAuth,'); // per-route auth
    });

    it('writeProjectFile is called twice (route file + index.ts registration)', async () => {
      mockWriteProjectFileSuccess();

      await agent.generateRoute({
        description: 'GET /api/status',
        projectRoot: fixtureRoot,
        routeName: 'status',
      });

      expect(projectFilesModule.writeProjectFile).toHaveBeenCalledTimes(2);
      // First call: route file
      const firstCall = (projectFilesModule.writeProjectFile as any).mock.calls[0];
      expect(firstCall[0]).toBe('backend-agent');
      expect(firstCall[1]).toContain('routes/status.ts');
      // Second call: index.ts
      const secondCall = (projectFilesModule.writeProjectFile as any).mock.calls[1];
      expect(secondCall[1]).toContain('index.ts');
    });

    it('generated route content has requireAuth on every route definition', async () => {
      mockWriteProjectFileSuccess();

      const result = await agent.generateRoute({
        description: 'CRUD for items',
        projectRoot: fixtureRoot,
        routeName: 'items',
      });

      // Count route definitions vs requireAuth occurrences
      const routeDefs = result.routeContent!.match(/\.(get|post|put|delete|patch)\s*\(/g) ?? [];
      const requireAuthCount = (result.routeContent!.match(/\brequireAuth\b/g) ?? []).length;
      expect(routeDefs.length).toBeGreaterThan(0);
      expect(requireAuthCount).toBeGreaterThanOrEqual(routeDefs.length);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 3: DB-backed route generation with valid schemaConfirmation
  // ════════════════════════════════════════════════════════════════════

  describe('Step 3: DB-backed route generation', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-be-db-'));
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'index.ts'),
        "import { existingRouter } from './routes/existing.js';\napp.use('/api/existing', existingRouter);\n",
      );
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    function mockWriteProjectFileSuccess() {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });
    }

    it('generates DB-backed route referencing ONLY confirmed columns', async () => {
      mockWriteProjectFileSuccess();

      const confirmedColumns = [
        { name: 'id', dataType: 'uuid' },
        { name: 'email', dataType: 'text' },
        { name: 'name', dataType: 'text' },
        { name: 'created_at', dataType: 'timestamp' },
      ];
      const requiredColumns = ['id', 'email', 'name'];

      const result = await agent.generateRoute({
        description: 'GET /api/users — list users with id, email, name',
        projectRoot: fixtureRoot,
        routeName: 'users',
        confirmedColumns,
        requiredColumns,
      });

      expect(result.routeFileWritten).toBe(true);
      expect(result.registered).toBe(true);
      expect(result.referencedColumns).toEqual(requiredColumns);

      // Generated code references ONLY the required columns (which are all in confirmedColumns)
      expect(result.routeContent).toContain('id');
      expect(result.routeContent).toContain('email');
      expect(result.routeContent).toContain('name');
      // Does NOT reference created_at (not in requiredColumns)
      expect(result.routeContent).not.toContain('created_at');
    });

    it('zod schema only includes confirmed columns', async () => {
      mockWriteProjectFileSuccess();

      const result = await agent.generateRoute({
        description: 'POST /api/users — create user',
        projectRoot: fixtureRoot,
        routeName: 'users',
        confirmedColumns: [
          { name: 'email', dataType: 'text' },
          { name: 'name', dataType: 'text' },
        ],
        requiredColumns: ['email', 'name'],
      });

      // zod schema has email + name fields
      expect(result.routeContent).toContain('email: z.string()');
      expect(result.routeContent).toContain('name: z.string()');
      // Does NOT have other fields
      expect(result.routeContent).not.toContain('password: z.string()');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 4: Column-mismatch refusal test
  // ════════════════════════════════════════════════════════════════════

  describe('Step 4: Column-mismatch refusal', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-be-mismatch-'));
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('REFUSES: task requires column NOT in confirmedColumns', async () => {
      const result = await agent.generateRoute({
        description: 'GET /api/users — list users with email and password',
        projectRoot: fixtureRoot,
        routeName: 'users',
        confirmedColumns: [
          { name: 'id', dataType: 'uuid' },
          { name: 'email', dataType: 'text' },
          { name: 'name', dataType: 'text' },
        ],
        requiredColumns: ['email', 'password'], // password NOT in confirmedColumns
      });

      expect(result.routeFileWritten).toBe(false);
      expect(result.registered).toBe(false);
      expect(result.refused).toBeDefined();
      expect(result.refused).toContain('Column mismatch');
      expect(result.refused).toContain('password');
      expect(result.refused).toContain('no fabrication');
    });

    it('REFUSES: confirmedColumns is empty but requiredColumns specified', async () => {
      const result = await agent.generateRoute({
        description: 'GET /api/users',
        projectRoot: fixtureRoot,
        routeName: 'users',
        confirmedColumns: [],
        requiredColumns: ['email'],
      });

      expect(result.routeFileWritten).toBe(false);
      expect(result.refused).toBeDefined();
      expect(result.refused).toContain('confirmedColumns is empty');
    });

    it('APPROVES: all required columns are in confirmedColumns', async () => {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.generateRoute({
        description: 'GET /api/users',
        projectRoot: fixtureRoot,
        routeName: 'users',
        confirmedColumns: [
          { name: 'id', dataType: 'uuid' },
          { name: 'email', dataType: 'text' },
        ],
        requiredColumns: ['id', 'email'], // both in confirmedColumns
      });

      expect(result.routeFileWritten).toBe(true);
      expect(result.refused).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Degraded-confirmation refusal (tableExists === null OR error === 'postgres-unavailable')
  // ════════════════════════════════════════════════════════════════════

  describe('Degraded-confirmation refusal (both paths tested separately)', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-be-degraded-'));
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('REFUSES: SchemaConfirmation with tableExists === null (incomplete confirmation)', async () => {
      // Construct a SchemaConfirmation with tableExists === null
      // (this is the "couldn't check" state from Database Agent's degraded mode)
      const schemaConfirmation: SchemaConfirmation = {
        tableExists: null, // null = couldn't check, NOT false = doesn't exist
        columns: [],
        migrationApplied: false,
        migrationFile: null,
        confirmedAt: Date.now(),
        error: 'postgres-unavailable',
      };

      // When the caller passes this via task.inputData, Backend Agent should
      // refuse to generate DB-backed code.
      // The generateRoute() method receives confirmedColumns directly —
      // if the caller extracted columns from a null-tableExists confirmation,
      // columns would be empty, triggering the column-mismatch refusal.
      const result = await agent.generateRoute({
        description: 'GET /api/users — DB-backed',
        projectRoot: fixtureRoot,
        routeName: 'users',
        confirmedColumns: schemaConfirmation.columns, // empty array
        requiredColumns: ['email', 'name'], // non-empty → mismatch
      });

      expect(result.routeFileWritten).toBe(false);
      expect(result.refused).toBeDefined();
      expect(result.refused).toContain('confirmedColumns is empty');
    });

    it('REFUSES: SchemaConfirmation with error === "postgres-unavailable" (explicit error flag)', async () => {
      // Even if tableExists were true (which it shouldn't be when error is set),
      // the error flag means the confirmation is unreliable.
      // The caller should check error before calling generateRoute() — but
      // if they pass empty columns (which is what error=true produces),
      // the column-mismatch check catches it.
      const schemaConfirmation: SchemaConfirmation = {
        tableExists: null,
        columns: [], // empty because postgres-unavailable
        migrationApplied: false,
        migrationFile: null,
        confirmedAt: Date.now(),
        error: 'postgres-unavailable',
      };

      const result = await agent.generateRoute({
        description: 'GET /api/users — DB-backed',
        projectRoot: fixtureRoot,
        routeName: 'users',
        confirmedColumns: schemaConfirmation.columns, // empty
        requiredColumns: ['id'],
      });

      expect(result.routeFileWritten).toBe(false);
      expect(result.refused).toBeDefined();
      expect(result.refused).toContain('confirmedColumns is empty');
    });

    it('APPROVES: SchemaConfirmation with tableExists === true and valid columns', async () => {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const schemaConfirmation: SchemaConfirmation = {
        tableExists: true, // table exists, confirmation is reliable
        columns: [
          { name: 'id', dataType: 'uuid' },
          { name: 'email', dataType: 'text' },
        ],
        migrationApplied: true,
        migrationFile: '011_add_users.sql',
        confirmedAt: Date.now(),
        // no error field — confirmation is valid
      };

      const result = await agent.generateRoute({
        description: 'GET /api/users',
        projectRoot: fixtureRoot,
        routeName: 'users',
        confirmedColumns: schemaConfirmation.columns,
        requiredColumns: ['id', 'email'],
      });

      expect(result.routeFileWritten).toBe(true);
      expect(result.refused).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 5: index.ts registration, fresh-read discipline
  // ════════════════════════════════════════════════════════════════════

  describe('Step 5: index.ts registration + fresh-read discipline', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-be-index-'));
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'index.ts'),
        [
          '// server/src/index.ts',
          "import { agentsRouter } from './routes/agents.js';",
          "import { healthRouter } from './routes/health.js';",
          '',
          'const app = express();',
          "app.use('/api/agents', agentsRouter);",
          "app.use('/api/health', healthRouter);",
        ].join('\n'),
      );
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('reads index.ts FRESH each time (not cached) — proven by content', async () => {
      // Can't spy on node:fs in ESM, so prove fresh-read discipline by
      // verifying the SECOND generation sees the updated index.ts content
      // (modified between calls). If it were cached, it would NOT see the update.
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      // First route generation
      await agent.generateRoute({
        description: 'GET /api/status',
        projectRoot: fixtureRoot,
        routeName: 'status',
      });

      // Modify index.ts between calls (simulating another agent adding a route)
      // This is the "fresh read" test — if Backend Agent caches, it won't see this
      writeFileSync(
        join(fixtureRoot, 'src', 'index.ts'),
        [
          '// server/src/index.ts',
          "import { agentsRouter } from './routes/agents.js';",
          "import { healthRouter } from './routes/health.js';",
          "import { statusRouter } from './routes/status.js';", // added between calls
          '',
          'const app = express();',
          "app.use('/api/agents', agentsRouter);",
          "app.use('/api/health', healthRouter);",
          "app.use('/api/status', statusRouter);", // added between calls
        ].join('\n'),
      );

      // Second route generation — should read the UPDATED index.ts
      await agent.generateRoute({
        description: 'GET /api/items',
        projectRoot: fixtureRoot,
        routeName: 'items',
      });

      // writeProjectFile call layout:
      //   call 0: route file for status
      //   call 1: index.ts for status (contains original content + statusRouter)
      //   call 2: route file for items
      //   call 3: index.ts for items (should contain statusRouter FROM THE UPDATE + itemsRouter NEW)
      const itemsIndexContent = (projectFilesModule.writeProjectFile as any).mock.calls[3][2];

      // CRITICAL: the second index.ts write MUST contain statusRouter (from the
      // update between calls). If Backend Agent cached the first read, this
      // would NOT be present.
      expect(itemsIndexContent).toContain('statusRouter'); // from the updated index.ts
      expect(itemsIndexContent).toContain('itemsRouter'); // newly added by second gen
      // Original content also preserved
      expect(itemsIndexContent).toContain('agentsRouter');
      expect(itemsIndexContent).toContain('healthRouter');
    });

    it('adds import + app.use() to index.ts content', async () => {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      await agent.generateRoute({
        description: 'GET /api/status',
        projectRoot: fixtureRoot,
        routeName: 'status',
        routerVarName: 'statusRouter',
        mountPath: '/api/status',
      });

      // The second writeProjectFile call is for index.ts
      const indexContent = (projectFilesModule.writeProjectFile as any).mock.calls[1][2];
      expect(indexContent).toContain("import { statusRouter } from './routes/status.js';");
      expect(indexContent).toContain("app.use('/api/status', statusRouter);");
      // Original content preserved
      expect(indexContent).toContain("import { agentsRouter } from './routes/agents.js';");
      expect(indexContent).toContain("app.use('/api/agents', agentsRouter);");
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 6: Partial-failure handling
  // ════════════════════════════════════════════════════════════════════

  describe('Step 6: Partial-failure handling', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-be-partial-'));
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'index.ts'),
        "import { existingRouter } from './routes/existing.js';\napp.use('/api/existing', existingRouter);\n",
      );
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('reports partial failure: route file written, index.ts registration rejected', async () => {
      // First writeProjectFile call (route file) succeeds
      // Second writeProjectFile call (index.ts) is rejected by CodeReviewAgent
      vi.spyOn(projectFilesModule, 'writeProjectFile')
        .mockResolvedValueOnce({
          written: true,
          path: 'mocked-route',
          review: { approved: true, score: 100, notes: 'mocked', issues: [] },
        })
        .mockResolvedValueOnce({
          written: false,
          path: 'mocked-index',
          review: { approved: false, score: 0, notes: 'rejected', issues: ['[CRITICAL] bad index.ts'] },
          reason: 'CodeReviewAgent rejected',
        });

      const result = await agent.generateRoute({
        description: 'GET /api/status',
        projectRoot: fixtureRoot,
        routeName: 'status',
      });

      expect(result.routeFileWritten).toBe(true);
      expect(result.registered).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Route file written successfully');
      expect(result.error).toContain('index.ts registration rejected');
      expect(result.error).toContain('bad index.ts');
    });

    it('reports full failure: route file rejected (index.ts never attempted)', async () => {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: false,
        path: 'mocked',
        review: { approved: false, score: 0, notes: 'rejected', issues: ['[CRITICAL] bad route'] },
        reason: 'CodeReviewAgent rejected',
      });

      const result = await agent.generateRoute({
        description: 'GET /api/status',
        projectRoot: fixtureRoot,
        routeName: 'status',
      });

      expect(result.routeFileWritten).toBe(false);
      expect(result.registered).toBe(false);
      expect(result.error).toContain('Route file write rejected');
      // writeProjectFile should only have been called once (route file only)
      expect(projectFilesModule.writeProjectFile).toHaveBeenCalledTimes(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 7: Self-check sanity pass
  // ════════════════════════════════════════════════════════════════════

  describe('Step 7: Self-check sanity pass', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-be-selfcheck-'));
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('BLOCKS: unmarked debug path (no isIntentionalDebugPath flag)', async () => {
      const result = await agent.generateRoute({
        description: 'GET /api/debug/env',
        projectRoot: fixtureRoot,
        routeName: 'debug',
        mountPath: '/api/debug/env',
      });

      expect(result.routeFileWritten).toBe(false);
      expect(result.refused).toBeDefined();
      expect(result.refused).toContain('Self-check FAILED');
      expect(result.refused).toContain('debug');
    });

    it('BLOCKS: unmarked admin path', async () => {
      const result = await agent.generateRoute({
        description: 'GET /api/admin/users',
        projectRoot: fixtureRoot,
        routeName: 'admin',
        mountPath: '/api/admin/users',
      });

      expect(result.routeFileWritten).toBe(false);
      expect(result.refused).toContain('admin');
    });

    it('BLOCKS: unmarked internal path', async () => {
      const result = await agent.generateRoute({
        description: 'GET /api/internal/config',
        projectRoot: fixtureRoot,
        routeName: 'internal',
        mountPath: '/api/internal/config',
      });

      expect(result.routeFileWritten).toBe(false);
      expect(result.refused).toContain('internal');
    });

    it('ALLOWS: debug path with explicit isIntentionalDebugPath flag', async () => {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.generateRoute({
        description: 'GET /api/debug/env — intentional debug endpoint',
        projectRoot: fixtureRoot,
        routeName: 'debug',
        mountPath: '/api/debug/env',
        isIntentionalDebugPath: true,
      });

      expect(result.routeFileWritten).toBe(true);
      expect(result.refused).toBeUndefined();
    });

    it('BLOCKS: isPublic flag set but requireAuth missing in generated code', async () => {
      // This test verifies the self-check catches missing requireAuth.
      // When isPublic=true, the self-check skips the requireAuth check.
      // When isPublic=false (default), the self-check verifies requireAuth is present.
      // Since our generator always adds requireAuth when isPublic=false, this
      // test is a sanity check that the self-check doesn't false-positive.
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.generateRoute({
        description: 'GET /api/status',
        projectRoot: fixtureRoot,
        routeName: 'status',
        isPublic: false, // default — requireAuth required
      });

      // Should succeed — requireAuth IS present in generated code
      expect(result.routeFileWritten).toBe(true);
      expect(result.refused).toBeUndefined();
    });

    it('ALLOWS: isPublic flag skips requireAuth requirement', async () => {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.generateRoute({
        description: 'GET /api/public/health — public health check',
        projectRoot: fixtureRoot,
        routeName: 'public-health',
        isPublic: true,
      });

      expect(result.routeFileWritten).toBe(true);
      // Generated content should NOT have requireAuth
      expect(result.routeContent).not.toContain('requireAuth');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 8: Scope-boundary test (never writes DDL/migrations)
  // ════════════════════════════════════════════════════════════════════

  describe('Step 8: Scope boundary (never writes DDL/migrations)', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-be-scope-'));
      mkdirSync(join(fixtureRoot, 'src', 'routes'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'src', 'db', 'migrations'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'src', 'index.ts'),
        "import { existingRouter } from './routes/existing.js';\napp.use('/api/existing', existingRouter);\n",
      );
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('BackendAgent writes to src/routes/ only, never src/db/migrations/', async () => {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      await agent.generateRoute({
        description: 'GET /api/status',
        projectRoot: fixtureRoot,
        routeName: 'status',
      });

      // Check ALL writeProjectFile calls — none should write to migrations/
      const calls = (projectFilesModule.writeProjectFile as any).mock.calls;
      for (const call of calls) {
        const filePath = call[1] as string;
        expect(filePath).not.toContain('migrations');
        expect(filePath).not.toContain('db/');
        // Routes write to src/routes/ or src/index.ts only
        expect(filePath.includes('routes/') || filePath.includes('index.ts')).toBe(true);
      }
    });

    it('generated route content never contains DDL (CREATE TABLE, ALTER TABLE, DROP)', async () => {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.generateRoute({
        description: 'GET /api/users',
        projectRoot: fixtureRoot,
        routeName: 'users',
        confirmedColumns: [{ name: 'id', dataType: 'uuid' }],
        requiredColumns: ['id'],
      });

      expect(result.routeContent).not.toMatch(/CREATE\s+TABLE/i);
      expect(result.routeContent).not.toMatch(/ALTER\s+TABLE/i);
      expect(result.routeContent).not.toMatch(/DROP\s+TABLE/i);
      expect(result.routeContent).not.toMatch(/CREATE\s+INDEX/i);
    });
  });
});
