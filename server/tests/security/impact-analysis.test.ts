import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeChangeImpact } from '../../src/changes/impact.js';
import { planChangeTransaction, __test__ as transactionTest } from '../../src/changes/transaction.js';
import { resolveWorkspace } from '../../src/workspace/service.js';

function writeWorkspaceFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

async function createImpactWorkspace(label: string) {
  const workspace = await resolveWorkspace(`impact-${label}-${Date.now()}-${Math.random()}`);
  writeWorkspaceFile(workspace.rootPath, 'tsconfig.json', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true },
    include: ['server/src/**/*.ts', 'server/tests/**/*.ts'],
  }));
  writeWorkspaceFile(workspace.rootPath, 'server/package.json', JSON.stringify({
    name: 'fixture-server',
    scripts: { typecheck: 'tsc -p tsconfig.json --noEmit', test: 'vitest run' },
  }));
  writeWorkspaceFile(workspace.rootPath, 'server/src/services/symbol.ts', 'export const feature = 1;\n');
  writeWorkspaceFile(workspace.rootPath, 'server/src/routes/example.ts', [
    "import { feature } from '../services/symbol.js';",
    'export const exampleRouter = { get(_path: string) {} };',
    "exampleRouter.get('/health');",
    'export const routeFeature = feature;',
    '',
  ].join('\n'));
  writeWorkspaceFile(workspace.rootPath, 'server/src/index.ts', [
    "import { exampleRouter } from './routes/example.js';",
    'const app = { use(_path: string, _router: unknown) {} };',
    "app.use('/api/example', exampleRouter);",
    '',
  ].join('\n'));
  writeWorkspaceFile(workspace.rootPath, 'server/tests/symbol.test.ts', [
    "import { feature } from '../src/services/symbol.js';",
    'void feature;',
    '',
  ].join('\n'));
  return workspace;
}

describe('changed-surface impact analysis', () => {
  beforeEach(() => transactionTest.clearTransactions());

  it('derives TypeScript symbol dependents, tests, routes, and a minimal unexecuted verification plan from real workspace files', async () => {
    const workspace = await createImpactWorkspace('compiler');
    const before = 'export const feature = 1;\n';
    const after = 'export const feature = 2;\n';

    const impact = analyzeChangeImpact({ workspace, path: 'server/src/services/symbol.ts', before, after });

    expect(impact.status).toBe('available');
    expect(impact.confidence).toBe('direct-static-evidence');
    expect(impact.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'feature', kind: 'variable' })]));
    expect(impact.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'server/src/routes/example.ts', importedNames: ['feature'] }),
      expect.objectContaining({ path: 'server/tests/symbol.test.ts', importedNames: ['feature'] }),
    ]));
    expect(impact.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/api/example/health', modulePath: 'server/src/routes/example.ts' }),
    ]));
    expect(impact.tests).toContainEqual({ path: 'server/tests/symbol.test.ts', evidence: 'typescript-module-resolution' });
    expect(impact.verification).toEqual(expect.arrayContaining([
      expect.objectContaining({ packagePath: 'server', command: 'npm run typecheck', status: 'planned' }),
      expect.objectContaining({ packagePath: 'server', command: 'npm test -- tests/symbol.test.ts', status: 'planned' }),
    ]));
    expect(impact.gaps).toContain('Verification entries are declared plans; they are not execution results.');
  });

  it('reports declarations added by the immutable proposal and declarations removed from the disk baseline', async () => {
    const workspace = await createImpactWorkspace('symbols');
    const added = analyzeChangeImpact({
      workspace,
      path: 'server/src/services/symbol.ts',
      before: 'export const feature = 1;\n',
      after: 'export const feature = 1;\nexport function addedSurface() { return feature; }\n',
    });
    const removed = analyzeChangeImpact({
      workspace,
      path: 'server/src/services/symbol.ts',
      before: 'export const feature = 1;\n',
      after: '',
    });

    expect(added.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'addedSurface', kind: 'function' })]));
    expect(removed.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'feature', kind: 'variable' })]));
  });

  it('returns explicit non-applicability instead of invented TypeScript impact for a non-TypeScript file', async () => {
    const workspace = await createImpactWorkspace('markdown');
    writeWorkspaceFile(workspace.rootPath, 'README.md', '# Before\n');

    const impact = analyzeChangeImpact({ workspace, path: 'README.md', before: '# Before\n', after: '# After\n' });

    expect(impact).toMatchObject({
      status: 'not-applicable',
      confidence: 'not-applicable',
      dependents: [],
      tests: [],
      verification: [],
    });
  });

  it('returns unavailable evidence without fabricating dependents when no TypeScript project exists', async () => {
    const workspace = await resolveWorkspace(`impact-unconfigured-${Date.now()}`);
    writeWorkspaceFile(workspace.rootPath, 'src/unconfigured.ts', 'export const isolated = 1;\n');

    const impact = analyzeChangeImpact({
      workspace,
      path: 'src/unconfigured.ts',
      before: 'export const isolated = 1;\n',
      after: 'export const isolated = 2;\n',
    });

    expect(impact).toMatchObject({ status: 'unavailable', confidence: 'unavailable', dependents: [], tests: [], verification: [] });
    expect(impact.reason).toContain('tsconfig.json');
  });

  it('rejects a traversal target through WorkspaceService instead of accepting a caller-supplied filesystem path', async () => {
    const workspace = await createImpactWorkspace('traversal');

    expect(() => analyzeChangeImpact({
      workspace,
      path: '../outside.ts',
      before: 'export const outside = 1;\n',
      after: 'export const outside = 2;\n',
    })).toThrow(/workspace|path|outside/i);
  });

  it('attaches the same impact evidence to the immutable transaction plan without applying a write or verification command', async () => {
    const workspace = await createImpactWorkspace('transaction');
    const before = 'export const feature = 1;\n';
    const planned = await planChangeTransaction({
      userId: workspace.userId,
      projectId: workspace.projectId,
      path: 'server/src/services/symbol.ts',
      before: '1',
      after: '2',
      expectedContent: before,
      mode: 'refactor',
    });

    expect(planned.status).toBe('planned');
    expect(planned.impact).toMatchObject({ status: 'available', confidence: 'direct-static-evidence' });
    expect(planned.impact?.verification.every((entry) => entry.status === 'planned')).toBe(true);
  });
});
