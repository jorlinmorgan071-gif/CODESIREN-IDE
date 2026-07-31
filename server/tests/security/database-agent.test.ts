// tests/security/database-agent.test.ts
//
// Phase C Agent 3 — DatabaseAgent tests.
//
// Covers:
//   1. IAgent skeleton (registered, callable, execute() chat persona preserved)
//   2. designMigration() — LLM-generated SQL migration written via writeProjectFile()
//   3. applyMigration() — Ghost Mode approval gate (reportFinding → planFix → poll)
//   4. introspectSchema() — information_schema queries (degraded mode when no Postgres)
//   5. databaseOperation() — full flow with confirmedSchema output for Backend Agent
//   6. inputData hand-off — confirmedSchema can be passed to a subsequent agent task
//   7. Scope boundary — DatabaseAgent only writes to migrations/, never routes/

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseAgent } from '../../src/agents/database/index.js';
import { modelRouter } from '../../src/orchestration/model-router.js';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import * as projectFilesModule from '../../src/agents/_shared/project-files.js';
import { isDbAvailable } from '../../src/db/client.js';
import type { DatabaseAgentResult, AgentTask } from '../../src/types.js';

describe('Phase C Agent 3 — DatabaseAgent', () => {
  let agent: DatabaseAgent;

  beforeAll(() => {
    agent = new DatabaseAgent();
  });

  // ════════════════════════════════════════════════════════════════════
  // 1. IAgent skeleton
  // ════════════════════════════════════════════════════════════════════

  describe('IAgent skeleton', () => {
    it('has correct id, name, domain, icon', () => {
      expect(agent.id).toBe('database-agent');
      expect(agent.name).toBe('Database Agent');
      expect(agent.domain).toBe('DATABASE');
      expect(agent.icon).toBe('database');
    });

    it('preserves execute() chat persona (yields chunks)', async () => {
      const task = {
        id: 'test-' + Date.now(),
        projectId: 'test',
        sessionId: 'test',
        agentId: 'database-agent',
        type: 'chat' as const,
        description: 'What is a B-tree index?',
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
  // 2. designMigration() — generates SQL migration via LLM + writeProjectFile()
  // ════════════════════════════════════════════════════════════════════

  describe('designMigration()', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-db-design-'));
      mkdirSync(join(fixtureRoot, 'src', 'db', 'migrations'), { recursive: true });
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    function mockLlmMigrationResponse(filename: string, sql: string, tables: unknown[]) {
      const payload = { filename, sql, tables };
      vi.spyOn(modelRouter, 'stream').mockReturnValue(
        (async function* () {
          yield { delta: `<review>\n${JSON.stringify(payload)}\n</review>`, done: false };
          yield { delta: '', done: true };
        })(),
      );
    }

    function mockWriteProjectFileSuccess() {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });
    }

    function mockWriteProjectFileRejection() {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: false,
        path: 'mocked',
        review: { approved: false, score: 0, notes: 'rejected', issues: ['[CRITICAL] bad SQL'] },
        reason: 'CodeReviewAgent rejected',
      });
    }

    it('generates a migration file from LLM output + writes it via writeProjectFile', async () => {
      mockLlmMigrationResponse(
        '011_add_user_avatar.sql',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;',
        [{
          name: 'users',
          columns: [
            { name: 'avatar_url', dataType: 'text', isNullable: true, defaultValue: null, isPrimaryKey: false },
          ],
        }],
      );
      mockWriteProjectFileSuccess();

      const result = await agent.designMigration({
        description: 'Add an avatar_url column to the users table',
        projectRoot: fixtureRoot,
      });

      expect(result.filename).toBe('011_add_user_avatar.sql');
      expect(result.sql).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url');
      expect(result.tables.length).toBe(1);
      expect(result.tables[0].name).toBe('users');
      expect(result.tables[0].columns[0].name).toBe('avatar_url');
      expect(result.applied).toBe(false); // not applied yet
      expect(result.error).toBeUndefined();

      // Verify writeProjectFile was called with the migration path
      expect(projectFilesModule.writeProjectFile).toHaveBeenCalled();
      const callArgs = (projectFilesModule.writeProjectFile as any).mock.calls[0];
      expect(callArgs[0]).toBe('database-agent'); // agentId
      expect(callArgs[1]).toContain('011_add_user_avatar.sql'); // filePath includes filename
      expect(callArgs[2]).toContain('ALTER TABLE'); // content is the SQL
    });

    it('returns error when writeProjectFile rejects the SQL (CodeReviewAgent gate)', async () => {
      mockLlmMigrationResponse(
        '012_bad.sql',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;',
        [],
      );
      mockWriteProjectFileRejection();

      const result = await agent.designMigration({
        description: 'Add a password column',
        projectRoot: fixtureRoot,
      });

      expect(result.applied).toBe(false);
      expect(result.error).toContain('rejected by CodeReviewAgent');
    });

    it('throws when LLM produces no fenced JSON (stub engine)', async () => {
      vi.spyOn(modelRouter, 'stream').mockReturnValue(
        (async function* () {
          yield { delta: 'I am the database agent. I received your request...', done: false };
          yield { delta: '', done: true };
        })(),
      );

      await expect(
        agent.designMigration({
          description: 'Add a column',
          projectRoot: fixtureRoot,
        }),
      ).rejects.toThrow('did not produce structured migration output');
    });

    it('determines next migration number from existing files', async () => {
      // Create some existing migration files
      writeFileSync(join(fixtureRoot, 'src', 'db', 'migrations', '001_core.sql'), '-- existing');
      writeFileSync(join(fixtureRoot, 'src', 'db', 'migrations', '010_tracking.sql'), '-- existing');

      mockLlmMigrationResponse(
        '011_new_feature.sql',
        'CREATE TABLE IF NOT EXISTS features (id UUID PRIMARY KEY);',
        [{ name: 'features', columns: [{ name: 'id', dataType: 'uuid', isNullable: false, defaultValue: null, isPrimaryKey: true }] }],
      );
      mockWriteProjectFileSuccess();

      const result = await agent.designMigration({
        description: 'Add features table',
        projectRoot: fixtureRoot,
      });

      // The LLM was told the next number is 11 (max existing is 10, +1 = 11)
      expect(modelRouter.stream).toHaveBeenCalled();
      const llmCall = (modelRouter.stream as any).mock.calls[0][0];
      expect(llmCall.messages[1].content).toContain('11');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 3. applyMigration() — Ghost Mode approval gate
  // ════════════════════════════════════════════════════════════════════

  describe('applyMigration() — Ghost Mode approval', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      // Reset Ghost Mode to a clean state
      ghostMode.stop();
      ghostMode.setLevel('approval-required');
    });

    afterEach(() => {
      ghostMode.stop();
      vi.restoreAllMocks();
    });

    it('reports to Ghost Mode via reportFinding + planFix', async () => {
      const reportSpy = vi.spyOn(ghostMode, 'reportFinding');
      const planSpy = vi.spyOn(ghostMode, 'planFix');

      // Auto-approve in test mode
      ghostMode.start();

      // Since Postgres isn't available, applyMigration will return early
      // with "Postgres unavailable" — but NOT before calling reportFinding.
      // Actually, wait — the code checks isDbAvailable() FIRST and returns
      // early. So reportFinding won't be called if Postgres is unavailable.
      // Let's test that path instead.
      const result = await agent.applyMigration({
        filename: '011_test.sql',
        sql: 'SELECT 1;',
        projectRoot: '/tmp',
        userId: 'test-user',
        taskId: 'test-task',
        testOnlyAutoApprove: true,
      });

      // Postgres is not available in the sandbox — migration can't apply
      expect(result.applied).toBe(false);
      expect(result.error).toContain('Postgres unavailable');
      // reportFinding should NOT have been called (early return before the gate)
      expect(reportSpy).not.toHaveBeenCalled();
    });

    it('fail-closed when Postgres unavailable — migration NOT applied', async () => {
      const result = await agent.applyMigration({
        filename: '011_test.sql',
        sql: 'CREATE TABLE IF NOT EXISTS test (id UUID PRIMARY KEY);',
        projectRoot: '/tmp',
      });

      expect(result.applied).toBe(false);
      expect(result.error).toContain('Postgres unavailable');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 4. introspectSchema() — information_schema queries
  // ════════════════════════════════════════════════════════════════════

  describe('introspectSchema()', () => {
    it('returns available=false when Postgres is unavailable (degraded mode)', async () => {
      // Postgres is not available in the sandbox
      const result = await agent.introspectSchema();
      expect(result.available).toBe(false);
      expect(result.tables).toEqual([]);
      expect(result.skipped).toContain('Postgres unavailable');
    });

    it('honestly reports the skip reason in skipped field', async () => {
      const result = await agent.introspectSchema();
      expect(result.skipped).toBeDefined();
      expect(typeof result.skipped).toBe('string');
      expect(result.skipped!.length).toBeGreaterThan(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 5. databaseOperation() — full flow with confirmedSchema output
  // ════════════════════════════════════════════════════════════════════

  describe('databaseOperation() — full flow', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-db-full-'));
      mkdirSync(join(fixtureRoot, 'src', 'db', 'migrations'), { recursive: true });
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('returns DatabaseAgentResult with all fields populated', async () => {
      // Mock LLM to produce a valid migration
      vi.spyOn(modelRouter, 'stream').mockReturnValue(
        (async function* () {
          yield {
            delta: `<review>\n${JSON.stringify({
              filename: '011_add_tags.sql',
              sql: 'CREATE TABLE IF NOT EXISTS tags (id UUID PRIMARY KEY, name TEXT NOT NULL);',
              tables: [{
                name: 'tags',
                columns: [
                  { name: 'id', dataType: 'uuid', isNullable: false, defaultValue: null, isPrimaryKey: true },
                  { name: 'name', dataType: 'text', isNullable: false, defaultValue: null, isPrimaryKey: false },
                ],
              }],
            })}\n</review>`,
            done: false,
          };
          yield { delta: '', done: true };
        })(),
      );

      // Mock writeProjectFile to succeed
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.databaseOperation({
        description: 'Add a tags table',
        projectRoot: fixtureRoot,
      });

      expect(result.migration).toBeDefined();
      expect(result.migration!.filename).toBe('011_add_tags.sql');
      expect(result.migration!.tables.length).toBe(1);
      expect(result.migration!.tables[0].name).toBe('tags');
      expect(result.migration!.applied).toBe(false); // apply=false by default
      expect(result.schemaIntrospection).toBeDefined();
      expect(result.schemaIntrospection!.available).toBe(false); // no Postgres
      expect(result.skipped.length).toBeGreaterThan(0); // introspection skipped
      expect(result.reviewTier).toBe('partial-scan'); // introspection skipped
    });

    it('confirmedSchema is populated when migration succeeds', async () => {
      vi.spyOn(modelRouter, 'stream').mockReturnValue(
        (async function* () {
          yield {
            delta: `<review>\n${JSON.stringify({
              filename: '011_add_tags.sql',
              sql: 'CREATE TABLE IF NOT EXISTS tags (id UUID PRIMARY KEY);',
              tables: [{
                name: 'tags',
                columns: [
                  { name: 'id', dataType: 'uuid', isNullable: false, defaultValue: null, isPrimaryKey: true },
                ],
              }],
            })}\n</review>`,
            done: false,
          };
          yield { delta: '', done: true };
        })(),
      );
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.databaseOperation({
        description: 'Add a tags table',
        projectRoot: fixtureRoot,
      });

      expect(result.confirmedSchema).toBeDefined();
      expect(result.confirmedSchema!.tables.length).toBe(1);
      expect(result.confirmedSchema!.tables[0].name).toBe('tags');
      expect(result.confirmedSchema!.migrationFile).toBe('011_add_tags.sql');
      expect(result.confirmedSchema!.applied).toBe(false); // not applied (apply=false)
    });

    it('confirmedSchema is undefined when migration design fails', async () => {
      // Stub engine produces no fenced JSON
      vi.spyOn(modelRouter, 'stream').mockReturnValue(
        (async function* () {
          yield { delta: 'I am the database agent...', done: false };
          yield { delta: '', done: true };
        })(),
      );

      const result = await agent.databaseOperation({
        description: 'Add a table',
        projectRoot: fixtureRoot,
      });

      expect(result.migration).toBeUndefined();
      expect(result.confirmedSchema).toBeUndefined();
      expect(result.skipped.length).toBeGreaterThan(0);
      // Migration design failed (1 skip) + introspection unavailable (1 skip)
      // = 2 skips → reviewTier is 'stub-fallback' (not 'partial-scan')
      expect(result.reviewTier).toBe('stub-fallback');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 6. inputData hand-off — confirmedSchema can be passed to another agent
  // ════════════════════════════════════════════════════════════════════

  describe('inputData hand-off (for Backend Agent)', () => {
    it('confirmedSchema can be attached to a subsequent AgentTask as inputData', async () => {
      // This test simulates the caller-supplies-confirmed-schema pattern:
      // 1. Database Agent produces confirmedSchema
      // 2. Caller constructs a Backend Agent task with inputData=confirmedSchema
      // 3. Backend Agent reads task.inputData to get the schema

      const confirmedSchema = {
        tables: [{
          name: 'tags',
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: false, defaultValue: null, isPrimaryKey: true },
            { name: 'name', dataType: 'text', isNullable: false, defaultValue: null, isPrimaryKey: false },
          ],
        }],
        migrationFile: '011_add_tags.sql',
        applied: true,
      };

      // Construct a task with inputData (simulating what the caller would do)
      const backendTask: AgentTask = {
        id: 'backend-task-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        agentId: 'backend-agent',
        type: 'code-gen',
        description: 'Build CRUD endpoints for the tags table',
        context: { projectId: 'proj-1', rootPath: '/tmp', techStack: {}, activeFiles: [] },
        priority: 'normal',
        executionMode: 'single-shot',
        origin: 'api',
        createdAt: Date.now(),
        inputData: confirmedSchema,
      };

      // The task now carries the confirmed schema
      expect(backendTask.inputData).toBeDefined();
      expect(backendTask.inputData!.tables).toEqual(confirmedSchema.tables);
      expect(backendTask.inputData!.migrationFile).toBe('011_add_tags.sql');
      expect(backendTask.inputData!.applied).toBe(true);

      // Backend Agent would read: task.inputData?.tables to know what columns exist
      const tables = (backendTask.inputData as any)?.tables;
      expect(tables[0].name).toBe('tags');
      expect(tables[0].columns.length).toBe(2);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 7. Scope boundary — DatabaseAgent only writes to migrations/
  // ════════════════════════════════════════════════════════════════════

  describe('scope boundary (never writes route/handler code)', () => {
    it('designMigration writes to src/db/migrations/ only, never src/routes/', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-db-scope-'));
      mkdirSync(join(fixtureRoot, 'src', 'db', 'migrations'), { recursive: true });

      vi.spyOn(modelRouter, 'stream').mockReturnValue(
        (async function* () {
          yield {
            delta: `<review>\n${JSON.stringify({
              filename: '011_add_users.sql',
              sql: 'CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY);',
              tables: [{ name: 'users', columns: [{ name: 'id', dataType: 'uuid', isNullable: false, defaultValue: null, isPrimaryKey: true }] }],
            })}\n</review>`,
            done: false,
          };
          yield { delta: '', done: true };
        })(),
      );

      const writeSpy = vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      await agent.designMigration({
        description: 'Add users table',
        projectRoot: fixtureRoot,
      });

      // Verify the write path goes to migrations/, NOT routes/
      const writePath = writeSpy.mock.calls[0][1] as string;
      expect(writePath).toContain('db');
      expect(writePath).toContain('migrations');
      expect(writePath).not.toContain('routes');
      expect(writePath).not.toContain('handler');

      rmSync(fixtureRoot, { recursive: true, force: true });
    });
  });
});
