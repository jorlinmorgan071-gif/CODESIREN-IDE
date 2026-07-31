// tests/security/documentation-agent.test.ts
//
// Phase C Agent 7 — DocumentationAgent tests.
//
// Per directive Section 5:
//   - Generated documentation grounded in real, read source
//   - Refuses with clear error when asked to document something that doesn't exist
//   - README section edits are marker-bounded, byte-for-byte preservation proven
//   - Fresh-read discipline proven
//   - All writes through writeProjectFile()

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentationAgent } from '../../src/agents/documentation/index.js';
import { CodeReviewAgent } from '../../src/agents/code-review/index.js';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import * as projectFilesModule from '../../src/agents/_shared/project-files.js';

const PROJECT_ROOT = join(process.cwd(), '..');

describe('Phase C Agent 7 — DocumentationAgent', () => {
  let agent: DocumentationAgent;

  beforeAll(() => {
    agent = new DocumentationAgent();
    // Register CodeReviewAgent for writeProjectFile() to work (non-mocked tests)
    if (!agentManager.get('code-review-agent')) {
      agentManager.register(new CodeReviewAgent());
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // IAgent skeleton
  // ════════════════════════════════════════════════════════════════════

  describe('IAgent skeleton', () => {
    it('has correct id, name, domain, icon', () => {
      expect(agent.id).toBe('documentation-agent');
      expect(agent.name).toBe('Documentation Agent');
      expect(agent.domain).toBe('DOCUMENTATION');
      expect(agent.icon).toBe('file-text');
    });

    it('preserves execute() chat persona (yields chunks)', async () => {
      const task = {
        id: 'test-' + Date.now(),
        projectId: 'test',
        sessionId: 'test',
        agentId: 'documentation-agent',
        type: 'chat' as const,
        description: 'What is a README?',
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
  // Step 2: Function/comment documentation for a real function
  // ════════════════════════════════════════════════════════════════════

  describe('Step 2: Function/comment documentation', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-doc-fn-'));
      mkdirSync(join(fixtureRoot, 'server', 'src', 'agents', 'test'), { recursive: true });
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    function mockWriteSuccess() {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });
    }

    it('reads a REAL file and generates informal // header comment (not JSDoc)', async () => {
      // Create a real fixture file with no header
      const fixtureFile = join(fixtureRoot, 'server', 'src', 'agents', 'test', 'helper.ts');
      writeFileSync(fixtureFile, 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');

      mockWriteSuccess();

      const result = await agent.documentFunction({
        projectRoot: fixtureRoot,
        filePath: 'server/src/agents/test/helper.ts',
        functionName: 'add',
        description: 'Adds two numbers',
      });

      expect(result.written).toBe(true);
      expect(result.commentAdded).toBe(true);
      expect(result.refused).toBeUndefined();
      // The generated content should have // comments, NOT JSDoc (@param, @returns)
      expect(result.updatedContent).toContain('//');
      expect(result.updatedContent).not.toContain('@param');
      expect(result.updatedContent).not.toContain('@returns');
    });

    it('updates an existing // header comment (replaces, not duplicates)', async () => {
      const fixtureFile = join(fixtureRoot, 'server', 'src', 'agents', 'test', 'existing.ts');
      writeFileSync(fixtureFile, [
        '// server/src/agents/test/existing.ts',
        '// Old description',
        '',
        'export function foo() { return 42; }',
      ].join('\n'));

      mockWriteSuccess();

      const result = await agent.documentFunction({
        projectRoot: fixtureRoot,
        filePath: 'server/src/agents/test/existing.ts',
        description: 'New updated description',
      });

      expect(result.written).toBe(true);
      // Should contain the NEW description, not the old one
      expect(result.updatedContent).toContain('New updated description');
      // Should NOT contain the old description as a duplicate
      expect(result.updatedContent).not.toContain('Old description');
    });

    it('writeProjectFile is called with the full file path + content', async () => {
      const fixtureFile = join(fixtureRoot, 'server', 'src', 'agents', 'test', 'callcheck.ts');
      writeFileSync(fixtureFile, 'export function bar() { return 1; }\n');

      mockWriteSuccess();

      await agent.documentFunction({
        projectRoot: fixtureRoot,
        filePath: 'server/src/agents/test/callcheck.ts',
        description: 'Test function',
      });

      expect(projectFilesModule.writeProjectFile).toHaveBeenCalled();
      const callArgs = (projectFilesModule.writeProjectFile as any).mock.calls[0];
      expect(callArgs[0]).toBe('documentation-agent');
      expect(callArgs[1]).toContain('callcheck.ts');
      expect(typeof callArgs[2]).toBe('string');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 3: Fabrication guard tests
  // ════════════════════════════════════════════════════════════════════

  describe('Step 3: Fabrication guards', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-doc-fab-'));
      mkdirSync(join(fixtureRoot, 'server', 'src'), { recursive: true });
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('REFUSES: file does not exist', async () => {
      const result = await agent.documentFunction({
        projectRoot: fixtureRoot,
        filePath: 'server/src/nonexistent.ts',
        description: 'This file does not exist',
      });

      expect(result.written).toBe(false);
      expect(result.commentAdded).toBe(false);
      expect(result.refused).toContain('does not exist');
      expect(result.refused).toContain('nonexistent.ts');
    });

    it('REFUSES: function does not exist in the target file', async () => {
      const fixtureFile = join(fixtureRoot, 'server', 'src', 'real.ts');
      writeFileSync(fixtureFile, 'export function realFunction() { return 1; }\n');

      const result = await agent.documentFunction({
        projectRoot: fixtureRoot,
        filePath: 'server/src/real.ts',
        functionName: 'nonexistentFunction',
        description: 'This function does not exist',
      });

      expect(result.written).toBe(false);
      expect(result.refused).toContain('nonexistentFunction');
      expect(result.refused).toContain('does not exist');
    });

    it('APPROVES: function exists in the target file', async () => {
      const fixtureFile = join(fixtureRoot, 'server', 'src', 'real.ts');
      writeFileSync(fixtureFile, 'export function realFunction() { return 1; }\n');

      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.documentFunction({
        projectRoot: fixtureRoot,
        filePath: 'server/src/real.ts',
        functionName: 'realFunction',
        description: 'A real function',
      });

      expect(result.written).toBe(true);
      expect(result.refused).toBeUndefined();
    });

    it('API docs: REFUSES when route file does not exist', async () => {
      const result = await agent.documentRouteFile({
        projectRoot: fixtureRoot,
        routeFilePath: 'server/src/routes/nonexistent.ts',
      });

      expect(result.refused).toContain('does not exist');
      expect(result.routes).toEqual([]);
    });

    it('API docs: claimed auth matches REAL requireAuth presence', async () => {
      // Create a route file WITH requireAuth
      mkdirSync(join(fixtureRoot, 'server', 'src', 'routes'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'server', 'src', 'routes', 'secure.ts'),
        [
          "import { Router } from 'express';",
          "import { requireAuth } from '../auth/middleware.js';",
          'export const secureRouter = Router();',
          "secureRouter.get('/profile', requireAuth, (req, res) => res.json({}));",
          "secureRouter.post('/settings', requireAuth, (req, res) => res.json({}));",
          // A public route (no requireAuth)
          "secureRouter.get('/public', (req, res) => res.json({}));",
        ].join('\n')
      );

      const result = await agent.documentRouteFile({
        projectRoot: fixtureRoot,
        routeFilePath: 'server/src/routes/secure.ts',
      });

      expect(result.refused).toBeUndefined();
      expect(result.routes.length).toBe(3);

      // /profile and /settings have requireAuth
      const profileRoute = result.routes.find(r => r.path === '/profile');
      expect(profileRoute).toBeDefined();
      expect(profileRoute!.requiresAuth).toBe(true);

      const settingsRoute = result.routes.find(r => r.path === '/settings');
      expect(settingsRoute).toBeDefined();
      expect(settingsRoute!.requiresAuth).toBe(true);

      // /public does NOT have requireAuth
      const publicRoute = result.routes.find(r => r.path === '/public');
      expect(publicRoute).toBeDefined();
      expect(publicRoute!.requiresAuth).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 4: README section generation with realistic fixture + byte-for-byte preservation
  // ════════════════════════════════════════════════════════════════════

  describe('Step 4: README section generation + byte-for-byte preservation', () => {
    let fixtureRoot: string;
    let readmePath: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-doc-readme-'));
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    // Realistic fixture: multiple sections, markdown formatting, code block, table, list
    const REALISTIC_README = `# Test Project

This is a realistic README with multiple sections.

## Overview

This project does things. It has:

- Feature A
- Feature B
- Feature C

## Installation

\`\`\`bash
npm install
npm run dev
\`\`\`

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| PORT    | 3001    | Server port |
| DB_HOST | localhost | Database host |

## API

Some API docs here that should be preserved.

## License

MIT
`;

    it('inserts a NEW marked section at the end when markers do not exist', async () => {
      readmePath = 'README.md';
      writeFileSync(join(fixtureRoot, readmePath), REALISTIC_README);

      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.updateReadmeSection({
        projectRoot: fixtureRoot,
        readmePath,
        sectionName: 'api-endpoints',
        sectionContent: '## API Endpoints\n\n- GET /api/health\n- POST /api/agents/:id/send',
      });

      expect(result.written).toBe(true);
      expect(result.preservedOutsideMarkers).toBe(true);
      // Updated content should contain the markers
      expect(result.updatedContent).toContain('<!-- AUTO-GENERATED: api-endpoints -->');
      expect(result.updatedContent).toContain('<!-- END AUTO-GENERATED -->');
    });

    it('preserves content OUTSIDE markers BYTE-FOR-BYTE (realistic fixture)', async () => {
      readmePath = 'README.md';
      writeFileSync(join(fixtureRoot, readmePath), REALISTIC_README);

      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.updateReadmeSection({
        projectRoot: fixtureRoot,
        readmePath,
        sectionName: 'changelog',
        sectionContent: '## Changelog\n\n- v1.0.0: Initial release',
      });

      // CRITICAL: content outside the markers must be byte-for-byte identical
      expect(result.preservedOutsideMarkers).toBe(true);

      // Verify the original content (minus the appended section) is intact
      const updatedContent = result.updatedContent!;
      // The original README content should appear verbatim in the updated content
      // (before the appended markers)
      const beforeMarkers = updatedContent.split('<!-- AUTO-GENERATED')[0].trim();
      const originalTrimmed = REALISTIC_README.trim();
      expect(beforeMarkers).toBe(originalTrimmed);
    });

    it('updates an EXISTING marked section (replaces content between markers)', async () => {
      readmePath = 'README.md';
      const readmeWithMarkers = REALISTIC_README + '\n\n<!-- AUTO-GENERATED: api -->\n## Old API\n\n- Old endpoint\n\n<!-- END AUTO-GENERATED -->\n';
      writeFileSync(join(fixtureRoot, readmePath), readmeWithMarkers);

      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.updateReadmeSection({
        projectRoot: fixtureRoot,
        readmePath,
        sectionName: 'api',
        sectionContent: '## New API\n\n- New endpoint',
      });

      expect(result.written).toBe(true);
      expect(result.preservedOutsideMarkers).toBe(true);
      // New content should be present
      expect(result.updatedContent).toContain('## New API');
      expect(result.updatedContent).toContain('New endpoint');
      // Old content should NOT be present (replaced, not duplicated)
      expect(result.updatedContent).not.toContain('Old API');
      expect(result.updatedContent).not.toContain('Old endpoint');
    });

    it('REFUSES when README file does not exist', async () => {
      const result = await agent.updateReadmeSection({
        projectRoot: fixtureRoot,
        readmePath: 'nonexistent.md',
        sectionName: 'test',
        sectionContent: 'test',
      });

      expect(result.written).toBe(false);
      expect(result.refused).toContain('does not exist');
    });

    it('fresh-read discipline: second call sees content modified between calls', async () => {
      readmePath = 'README.md';
      writeFileSync(join(fixtureRoot, readmePath), REALISTIC_README);

      // Don't mock writeProjectFile — let it actually write to disk
      // so the second call's fresh read sees the first call's changes.
      // CodeReviewAgent will run on the .md content — should pass since
      // it's just markdown with no code patterns.

      // First call — adds a section (actually writes to disk)
      const result1 = await agent.updateReadmeSection({
        projectRoot: fixtureRoot,
        readmePath,
        sectionName: 'section1',
        sectionContent: '## Section 1',
      });

      // Verify first call succeeded
      expect(result1.written).toBe(true);

      // Modify the README between calls (simulating another agent editing it)
      const afterFirstCall = readFileSync(join(fixtureRoot, readmePath), 'utf8');
      const modifiedContent = afterFirstCall + '\n## New Section Added By Someone Else\n';
      writeFileSync(join(fixtureRoot, readmePath), modifiedContent);

      // Second call — should see the modification (fresh read)
      const result2 = await agent.updateReadmeSection({
        projectRoot: fixtureRoot,
        readmePath,
        sectionName: 'section2',
        sectionContent: '## Section 2',
      });

      // The second write should contain BOTH sections
      expect(result2.updatedContent).toContain('Section 1');
      expect(result2.updatedContent).toContain('Section 2');
      // And the modification from between calls
      expect(result2.updatedContent).toContain('New Section Added By Someone Else');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 5: API route documentation from a real route file
  // ════════════════════════════════════════════════════════════════════

  describe('Step 5: API route documentation (live-code test)', () => {
    it('documents a REAL route file from the actual codebase', async () => {
      // Use the real routes/agents.ts file
      const result = await agent.documentRouteFile({
        projectRoot: PROJECT_ROOT,
        routeFilePath: 'server/src/routes/agents.ts',
      });

      expect(result.refused).toBeUndefined();
      expect(result.routerVarName).toBe('agentsRouter');
      expect(result.routes.length).toBeGreaterThan(0);

      // Should find the POST /:agentId/send route
      const sendRoute = result.routes.find(r => r.method === 'POST' && r.path.includes('send'));
      expect(sendRoute).toBeDefined();
      expect(sendRoute!.requiresAuth).toBe(true); // requireAuth is on this route

      // Should find the GET / route
      const listRoute = result.routes.find(r => r.method === 'GET' && r.path === '/');
      expect(listRoute).toBeDefined();
      expect(listRoute!.requiresAuth).toBe(true);

      // Schema fields should be populated from the zod schema
      const someRoute = result.routes[0];
      expect(someRoute.schemaFields.length).toBeGreaterThan(0);
      // Should have 'description' field (from the zod schema)
      expect(someRoute.schemaFields.some(f => f.name === 'description')).toBe(true);
    });

    it('mountPath is populated from index.ts', async () => {
      const result = await agent.documentRouteFile({
        projectRoot: PROJECT_ROOT,
        routeFilePath: 'server/src/routes/agents.ts',
      });

      expect(result.mountPath).toBe('/api/agents');
      // All routes should have the mountPath prefixed in fullPath
      for (const route of result.routes) {
        expect(route.fullPath).toContain('/api/agents');
      }
    });

    it('documentRouteFile with real health route (public, no requireAuth)', async () => {
      const result = await agent.documentRouteFile({
        projectRoot: PROJECT_ROOT,
        routeFilePath: 'server/src/routes/health.ts',
      });

      expect(result.refused).toBeUndefined();
      expect(result.routerVarName).toBe('healthRouter');
      expect(result.routes.length).toBeGreaterThan(0);

      // Health route should NOT have requireAuth
      const healthRoute = result.routes[0];
      expect(healthRoute.requiresAuth).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Scope boundary
  // ════════════════════════════════════════════════════════════════════

  describe('scope boundary', () => {
    it('uses informal // comments, NOT JSDoc', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-doc-scope-'));
      mkdirSync(join(fixtureRoot, 'server', 'src'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'server', 'src', 'test.ts'),
        'export function foo() { return 1; }\n'
      );

      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      try {
        const result = await agent.documentFunction({
          projectRoot: fixtureRoot,
          filePath: 'server/src/test.ts',
          description: 'Test',
        });

        // Generated content should use // NOT @param/@returns
        expect(result.updatedContent).toMatch(/^\/\//);
        expect(result.updatedContent).not.toContain('@param');
        expect(result.updatedContent).not.toContain('@returns');
        expect(result.updatedContent).not.toContain('@throws');
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
        vi.restoreAllMocks();
      }
    });

    it('does NOT have any auto-trigger methods', () => {
      expect(typeof (agent as any).autoGenerate).toBe('undefined');
      expect(typeof (agent as any).onFileChange).toBe('undefined');
      expect(typeof (agent as any).watchFiles).toBe('undefined');
    });

    it('does NOT have Ghost Mode coupling', () => {
      expect(typeof (agent as any).reportFinding).toBe('undefined');
      expect(typeof (agent as any).escalateFinding).toBe('undefined');
    });
  });
});
