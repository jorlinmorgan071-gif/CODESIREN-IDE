export interface ChangeImpactAnalysis {
  status: 'available' | 'not-applicable' | 'unavailable';
  confidence: 'direct-static-evidence' | 'not-applicable' | 'unavailable';
  dependents: Array<{ path: string; importedNames: string[]; evidence: 'typescript-module-resolution' }>;
  routes: Array<{ method: string; path: string; modulePath: string; evidence: 'express-static-route' }>;
  tests: Array<{ path: string; evidence: 'typescript-module-resolution' | 'adjacent-test-file' }>;
  verification: Array<{ packagePath: string; command: string; reason: string; status: 'planned' }>;
  gaps: string[];
  reason?: string;
}

export function summarizeChangeImpact(impact: ChangeImpactAnalysis): string {
  if (impact.status === 'unavailable') return impact.reason ?? 'Impact analysis is unavailable for this workspace file.';
  if (impact.status === 'not-applicable') return impact.reason ?? 'TypeScript impact analysis is not applicable to this file.';
  return `${impact.dependents.length} direct dependent${impact.dependents.length === 1 ? '' : 's'}, ${impact.tests.length} affected test${impact.tests.length === 1 ? '' : 's'}, and ${impact.routes.length} static route${impact.routes.length === 1 ? '' : 's'} identified.`;
}
