import { describe, expect, it } from 'vitest';
import { summarizeChangeImpact, type ChangeImpactAnalysis } from '../src/lib/change-impact';

const available: ChangeImpactAnalysis = {
  status: 'available',
  confidence: 'direct-static-evidence',
  dependents: [{ path: 'server/src/routes/example.ts', importedNames: ['feature'], evidence: 'typescript-module-resolution' }],
  routes: [{ method: 'GET', path: '/api/example/health', modulePath: 'server/src/routes/example.ts', evidence: 'express-static-route' }],
  tests: [{ path: 'server/tests/example.test.ts', evidence: 'typescript-module-resolution' }],
  verification: [{ packagePath: 'server', command: 'npm test -- tests/example.test.ts', reason: 'Compiler evidence', status: 'planned' }],
  gaps: [],
};

describe('change impact preview summary', () => {
  it('reports static evidence counts without claiming declared verification executed', () => {
    expect(summarizeChangeImpact(available)).toBe('1 direct dependent, 1 affected test, and 1 static route identified.');
    expect(available.verification[0].status).toBe('planned');
  });

  it('keeps unavailable analysis explicit instead of displaying an invented zero-impact conclusion', () => {
    expect(summarizeChangeImpact({ ...available, status: 'unavailable', confidence: 'unavailable', reason: 'No in-workspace tsconfig.json was found.' }))
      .toBe('No in-workspace tsconfig.json was found.');
  });
});
