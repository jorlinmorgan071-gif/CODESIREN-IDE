// server/src/orchestration/ghost-scanners.ts
// Phase A Section 1: wires existing structured scanners into Ghost Mode's
// periodic scanCycle(). This module breaks the circular import that would
// arise if ghost-mode.ts imported the agents directly (SecurityAgent imports
// ghostMode for the approval-gate reportFinding() calls).
//
// Two scanners are registered:
//   1. performance-anti-patterns — every 30s (regex scan, ~50-200ms, no network)
//      Maps PerformanceAntiPatternFinding → GhostFinding:
//        severity 'warning' → 'medium'
//        severity 'info'    → 'low'
//   2. security-dependencies — every 5min (npm audit --json, ~1-3s, network call)
//      Maps DependencyFinding → GhostFinding:
//        severity 'critical' → 'high'  (GhostFinding has no 'critical' bucket)
//        severity 'high'     → 'high'
//        severity 'moderate' → 'medium'
//        severity 'low'      → 'low'
//
// Both scanners call the agent's real structured-output method directly
// (not via execute()/dispatchStrategy — no LLM call, no task required).
//
// IMPORTANT: this module must be imported AFTER loadAgents() has populated
// agentManager. The import site is server/src/index.ts, right after the
// ghostMode.start() call.

import { ghostMode } from './ghost-mode.js';
import { agentManager } from './agent-manager.js';
import type { GhostFinding, PerformanceAntiPatternFinding, DependencyFinding } from '../types.js';

// Scanner return type — same as GhostScanner in ghost-mode.ts. Findings omit
// `id` (assigned by reportFinding()).
type ScannerFinding = Omit<GhostFinding, 'id'>;

// ── Project root resolution ─────────────────────────────────────────────
// The server runs from <projectRoot>/server/, so projectRoot = parent of cwd.
// This is the same convention used by PerformanceAgent.performanceReview()
// (which takes projectRoot and joins 'server/' + 'app/' under it).
//
// `let` (not `const`) so tests can override via __test__._setProjectRootForTest().
let PROJECT_ROOT = resolveProjectRoot(process.cwd());

function resolveProjectRoot(serverCwd: string): string {
  // If cwd ends with /server, project root is the parent.
  // Otherwise (e.g. running from project root directly), use cwd as-is and
  // let the agents' existsSync() checks handle a missing server/ dir.
  if (serverCwd.endsWith('/server') || serverCwd.endsWith('\\server')) {
    return serverCwd.replace(/[/\\]server$/, '');
  }
  return serverCwd;
}

// ── Severity mappers ────────────────────────────────────────────────────

function mapPerformanceSeverity(s: PerformanceAntiPatternFinding['severity']): GhostFinding['severity'] {
  // Per directive: 'warning' → 'medium', 'info' → 'low'
  return s === 'warning' ? 'medium' : 'low';
}

function mapSecuritySeverity(s: DependencyFinding['severity']): GhostFinding['severity'] {
  // GhostFinding only has 'low' | 'medium' | 'high' — no 'critical'.
  // Per directive: critical/high → 'high', moderate → 'medium', low → 'low'.
  // No findings are dropped silently.
  if (s === 'critical' || s === 'high') return 'high';
  if (s === 'moderate') return 'medium';
  return 'low';
}

// ── Scanner adapters ────────────────────────────────────────────────────
//
// Each adapter calls the agent's real scan method, then maps the structured
// findings to GhostFinding[]. The agent is fetched via agentManager.get()
// so we use the SAME singleton that's registered for chat/dispatch — no
// second instance, no state divergence.
//
// The scanner contract is sync () => GhostFinding[]. Both underlying scan
// methods (scanAntiPatterns, scanDependencies) are sync-in-body (regex +
// execSync), so no async bridge is needed. We access the private methods
// via `as any` cast — local to this module, doesn't leak to the type system.

function performanceAntiPatternScanner(): ScannerFinding[] {
  const agent = agentManager.get('performance-agent');
  if (!agent) return []; // agent not registered yet (e.g. during early boot)

  try {
    const anyAgent = agent as any;
    const serverDir = PROJECT_ROOT + '/server';
    const findings: PerformanceAntiPatternFinding[] = anyAgent.scanAntiPatterns(serverDir);
    return findings.map((f) => ({
      type: `performance:${f.pattern}`,
      severity: mapPerformanceSeverity(f.severity),
      filePath: f.file,
      line: f.line,
      description: `${f.pattern}: ${f.suggestion}`,
      agentId: 'performance-agent',
    }));
  } catch (err: any) {
    console.warn(`[ghost-scanners] performance scan failed: ${err.message}`);
    return [];
  }
}

function securityDependencyScanner(): ScannerFinding[] {
  const agent = agentManager.get('security-agent');
  if (!agent) return [];

  try {
    const anyAgent = agent as any;
    const serverDir = PROJECT_ROOT + '/server';
    // SecurityAgent.scanDependencies expects a projectRoot that CONTAINS
    // node_modules + package-lock.json. For Code Siren, that's server/.
    const findings: DependencyFinding[] = anyAgent.scanDependencies(serverDir);
    return findings.map((f) => ({
      type: 'dependency-vulnerability',
      severity: mapSecuritySeverity(f.severity),
      description: `${f.package}@${f.currentVersion}: ${f.advisory}. Fix: ${f.recommendedFix}`,
      agentId: 'security-agent',
      // Phase A Section 1b: carry the package metadata so planFix() can
      // build a real remediation plan and applyFix() can run npm audit fix
      // targeting the right project dir.
      packageName: f.package,
      currentVersion: f.currentVersion,
      recommendedFix: f.recommendedFix,
    }));
  } catch (err: any) {
    // Common in test/dev: no node_modules, no package-lock. Not an error —
    // silently return empty so the scanner doesn't spam logs every 5min.
    if (err.message.includes('node_modules') || err.message.includes('package-lock')) {
      return [];
    }
    console.warn(`[ghost-scanners] security scan failed: ${err.message}`);
    return [];
  }
}

// ── Registration entry point ────────────────────────────────────────────

export function registerGhostScanners(): void {
  // Sync the project root to ghostMode so planFix()/applyFix() can resolve
  // the server cwd for `npm audit fix`. This must happen before the scanners
  // register so the first scan tick (if it produces a finding) can build a
  // real plan with the right cwd.
  ghostMode.setProjectRoot(PROJECT_ROOT);

  // 30s cadence — runs from scanCycle() heartbeat (the main 30s timer).
  // Per ghost-mode.ts: scanners at cadence == 30s piggyback on the heartbeat.
  ghostMode.registerScanner('performance-anti-patterns', 30_000, performanceAntiPatternScanner);

  // 5min cadence — gets its OWN interval inside ghost-mode.ts.
  // npm audit is a network call (1-3s); running it every 30s would be wasteful
  // and would hit npm's rate limit. 5min is a reasonable ambient-scan cadence.
  ghostMode.registerScanner('security-dependencies', 5 * 60_000, securityDependencyScanner);
}

// Exported for tests — allows injecting a fake projectRoot or replacing
// the scanner functions without going through agentManager.
export const __test__ = {
  performanceAntiPatternScanner,
  securityDependencyScanner,
  resolveProjectRoot,
  mapPerformanceSeverity,
  mapSecuritySeverity,
  _setProjectRootForTest(root: string): void {
    PROJECT_ROOT = root;
  },
  _getProjectRootForTest(): string {
    return PROJECT_ROOT;
  },
};
