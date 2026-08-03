// tests/unit/terminal-intelligence.test.ts
// Phase A Section 2: Terminal Intelligence tests.
//
// Three test groups:
//   1. Event-driven terminal error reporting — a real failing command through
//      Terminal Agent triggers ghostMode.reportFinding({ type: 'terminal:error' })
//      with real stderr, plans as suggest-only.
//   2. Package install capability — real npm install <pkg> in a real fixture
//      + real npm ls verification.
//   3. classifyCommand() — matched commands get real explanations, blocked
//      commands get blocklist reasons, unmatched commands get honest fallback.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import { registerSink } from '../../src/ws/events.js';
import { __test__ as remediationTest } from '../../src/orchestration/ghost-remediation.js';
import { __test__ as installTest } from '../../src/orchestration/package-install.js';
import { __test__ as classifyTest } from '../../src/orchestration/classify-command.js';
import { TerminalAgent } from '../../src/agents/terminal/index.js';
import type { AgentEvent, GhostFinding } from '../../src/types.js';

describe('Phase A Section 2 — Terminal Intelligence', () => {
  let fixtureRoot: string;
  let capturedEvents: AgentEvent[];
  let unregisterSink: () => void;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'terminal-intel-'));
    capturedEvents = [];
    unregisterSink = registerSink((evt) => {
      capturedEvents.push(evt);
    });
    ghostMode.stop();
    ghostMode.clearReportedFindings();
    ghostMode.setLevel('approval-required');
    ghostMode.start();
  });

  afterEach(() => {
    unregisterSink();
    ghostMode.stop();
    ghostMode.clearReportedFindings();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════════════
  // GROUP 1: Event-driven terminal error reporting
  // ════════════════════════════════════════════════════════════════════
  describe('Terminal error → Ghost Mode reporting', () => {
    it('a real failing command reports terminal:error to Ghost Mode with real stderr', async () => {
      // Run a command that will really fail — `ls /nonexistent/path` exits
      // non-zero with real stderr ("No such file or directory").
      // Terminal Agent runs in /tmp, so the command is independent of fixtureRoot.
      const agent = new TerminalAgent();
      const taskId = `test-err-${Date.now()}`;

      // Build a task with an explicit command (bypasses LLM proposal)
      const task: any = {
        id: taskId,
        projectId: 'test',
        sessionId: 'test',
        agentId: 'terminal-agent',
        type: 'chat',
        description: JSON.stringify({ command: 'ls /nonexistent/path/that/does/not/exist', autoApprove: true }),
        executionMode: 'single-shot',
        origin: 'test',
        createdAt: Date.now(),
        context: { userId: 'test-user' },
      };

      // Collect chunks + traces
      const chunks: any[] = [];
      const signal = new AbortController().signal;

      // NODE_ENV must be 'test' for autoApprove to work
      const origNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      try {
        // Auto-approve the Ghost Mode finding (the approval gate fires for
        // the command execution). We need to approve it in parallel.
        // Set up a listener that auto-approves when the ghost:plan fires.
        const offPlan = registerSink((evt) => {
          if (evt.event === 'ghost:plan') {
            const plan = evt.payload as any;
            // Auto-approve in a microtask
            setTimeout(() => {
              ghostMode.approve(plan).catch(() => {});
            }, 0);
          }
        });

        for await (const chunk of agent.execute(task, signal)) {
          chunks.push(chunk);
        }
        offPlan();
      } finally {
        process.env.NODE_ENV = origNodeEnv;
      }

      // ── Verify the terminal:error finding was reported ──────────────
      // ghost:detection events fire for BOTH the approval-gate finding
      // (type: 'terminal:command') AND the error finding (type: 'terminal:error').
      const detectionEvents = capturedEvents.filter((e) => e.event === 'ghost:detection');
      const errorDetections = detectionEvents.filter(
        (e) => (e.payload as GhostFinding).type === 'terminal:error'
      );

      expect(errorDetections.length).toBe(1);
      const errorFinding = errorDetections[0].payload as GhostFinding;
      expect(errorFinding.severity).toBe('high');
      expect(errorFinding.description).toContain('ls /nonexistent');
      expect(errorFinding.description).toContain('failed');
      expect(errorFinding.description).toContain('exit');
      // Real stderr content should be in the description (not a placeholder)
      expect(errorFinding.description.length).toBeGreaterThan(50);
      expect(errorFinding.agentId).toBe('terminal-agent');
      expect(errorFinding.taskId).toBe(taskId);
    }, 30_000);

    it('terminal:error finding plans as suggest-only (no safe auto-fix)', async () => {
      // Build a terminal:error finding + call planFix directly
      const finding: GhostFinding = {
        id: `test-term-err-${Date.now()}`,
        type: 'terminal:error',
        severity: 'high',
        description: 'Command "ls /nonexistent" failed (exit 2): No such file or directory',
        agentId: 'terminal-agent',
      };

      ghostMode.reportFinding(finding);
      const plan = await ghostMode.planFix(finding);

      expect(plan.fixAction).toBe('suggest-only');
      expect(plan.preview).toContain('Terminal command failed');
      expect(plan.steps.some((s) => s.includes('NOT auto-fixable'))).toBe(true);
      expect(plan.steps.some((s) => s.includes('Manual review required'))).toBe(true);
    });

    it('FSM single-in-flight: terminal:error reported mid-flow is stored + broadcast, not dropped', () => {
      // Confirm that reportFinding stores the finding + broadcasts the event
      // regardless of FSM state. The finding is NOT silently dropped.
      ghostMode.stop();
      ghostMode.setLevel('approval-required');
      ghostMode.start();

      // Report a terminal:error. reportFinding returns the full finding
      // with the assigned uuid (we must use the RETURNED id for lookups,
      // not any pre-set id — reportFinding assigns its own).
      const returnedFinding = ghostMode.reportFinding({
        type: 'terminal:error',
        severity: 'high',
        description: 'Command failed mid-flow',
        agentId: 'terminal-agent',
      });

      // The finding IS stored (getFinding works with the RETURNED id)
      const stored = ghostMode.getFinding(returnedFinding.id);
      expect(stored).not.toBeNull();
      expect(stored?.type).toBe('terminal:error');
      expect(stored?.description).toBe('Command failed mid-flow');

      // The ghost:detection event IS broadcast
      const detectionEvents = capturedEvents.filter(
        (e) => e.event === 'ghost:detection' && (e.payload as GhostFinding).id === returnedFinding.id
      );
      expect(detectionEvents.length).toBe(1);

      // The finding is retrievable later — NOT dropped
      expect(ghostMode.getFinding(returnedFinding.id)?.id).toBe(returnedFinding.id);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // GROUP 2: Package install capability
  // ════════════════════════════════════════════════════════════════════
  describe('Package install capability', () => {
    it('installPackage: real npm install + real npm ls verification', () => {
      // Create a real npm fixture under fixtureRoot/server/
      const serverDir = join(fixtureRoot, 'server');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(
        join(serverDir, 'package.json'),
        JSON.stringify({ name: 'install-test', version: '1.0.0', dependencies: {} }),
        'utf8',
      );
      execSync('npm install --no-audit --no-fund', { cwd: serverDir, stdio: 'pipe', timeout: 60_000 });

      // Install a real, small package (minimist — tiny, no deps)
      const result = installTest.installPackage(fixtureRoot, {
        packageName: 'minimist@1.2.8',
        targetDir: 'server',
      });

      expect(result.success).toBe(true);
      expect(result.installedSpec).toBe('minimist@1.2.8');
      expect(result.installedVersion).toBe('1.2.8');
      expect(result.verifyOutput).toContain('minimist');

      // Verify the package is really in package.json
      const pkgJson = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));
      expect(pkgJson.dependencies.minimist).toBe('^1.2.8');
    }, 120_000);

    it('installPackage: target dir without package.json fails honestly', () => {
      const result = installTest.installPackage(fixtureRoot, {
        packageName: 'minimist',
        targetDir: 'server', // no package.json created in fixtureRoot/server/
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain('no package.json');
    });

    it('buildInstallCommand: correct command for regular + dev deps', () => {
      expect(installTest.buildInstallCommand({ packageName: 'express', targetDir: 'server' }))
        .toBe('npm install express');
      expect(installTest.buildInstallCommand({ packageName: 'jest@29.0.0', targetDir: 'app', dev: true }))
        .toBe('npm install jest@29.0.0 --save-dev');
    });

    it('extractBarePackageName: handles scoped + versioned specs', () => {
      expect(installTest.extractBarePackageName('lodash')).toBe('lodash');
      expect(installTest.extractBarePackageName('lodash@4.17.21')).toBe('lodash');
      expect(installTest.extractBarePackageName('@scope/pkg')).toBe('@scope/pkg');
      expect(installTest.extractBarePackageName('@scope/pkg@1.0.0')).toBe('@scope/pkg');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // GROUP 3: classifyCommand()
  // ════════════════════════════════════════════════════════════════════
  describe('classifyCommand()', () => {
    it('npm commands: matched with real explanations', () => {
      const cases = [
        { cmd: 'npm install', expectContains: 'Installs all dependencies' },
        { cmd: 'npm install express', expectContains: 'Adds the package to dependencies' },
        { cmd: 'npm install jest --save-dev', expectContains: 'devDependencies' },
        { cmd: 'npm audit fix', expectContains: 'security fixes' },
        { cmd: 'npm test', expectContains: 'test script' },
        { cmd: 'npm run build', expectContains: 'named script' },
        { cmd: 'npm ls minimist', expectContains: 'Lists installed packages' },
        { cmd: 'npm outdated', expectContains: 'outdated dependencies' },
      ];

      for (const { cmd, expectContains } of cases) {
        const result = classifyTest.classifyCommand(cmd);
        expect(result.blocked).toBe(false);
        expect(result.matched).toBe(true);
        expect(result.explanation).toContain(expectContains);
      }
    });

    it('git commands: matched with real explanations', () => {
      const cases = [
        { cmd: 'git status', expectContains: 'working tree status' },
        { cmd: 'git add file.ts', expectContains: 'Stages' },
        { cmd: 'git commit -m "fix"', expectContains: 'commit' },
        { cmd: 'git push', expectContains: 'Pushes' },
        { cmd: 'git pull', expectContains: 'Fetches' },
        { cmd: 'git log', expectContains: 'commit history' },
      ];

      for (const { cmd, expectContains } of cases) {
        const result = classifyTest.classifyCommand(cmd);
        expect(result.blocked).toBe(false);
        expect(result.matched).toBe(true);
        expect(result.explanation).toContain(expectContains);
      }
    });

    it('file system commands: matched with real explanations', () => {
      const cases = [
        { cmd: 'ls -la', expectContains: 'Lists directory' },
        { cmd: 'cat file.txt', expectContains: 'Prints' },
        { cmd: 'mkdir newdir', expectContains: 'Creates' },
        { cmd: 'rm file.txt', expectContains: 'Deletes' },
        { cmd: 'pwd', expectContains: 'working directory' },
        { cmd: 'echo hello', expectContains: 'Prints' },
      ];

      for (const { cmd, expectContains } of cases) {
        const result = classifyTest.classifyCommand(cmd);
        expect(result.blocked).toBe(false);
        expect(result.matched).toBe(true);
        expect(result.explanation).toContain(expectContains);
      }
    });

    it('blocked commands: blocklist reason used as explanation', () => {
      const result = classifyTest.classifyCommand('rm -rf /');
      expect(result.blocked).toBe(true);
      expect(result.matched).toBe(false);
      expect(result.risk).toBe('blocked');
      expect(result.explanation).toContain('BLOCKED');
      expect(result.blockReason).toBeDefined();
    });

    it('blocked: sudo command', () => {
      const result = classifyTest.classifyCommand('sudo npm install');
      expect(result.blocked).toBe(true);
      expect(result.risk).toBe('blocked');
      expect(result.explanation).toContain('sudo');
    });

    it('unrecognized command: honest fallback, no fabricated explanation', () => {
      const result = classifyTest.classifyCommand('awk "{print $2}" file.txt | sort | uniq -c');
      expect(result.blocked).toBe(false);
      expect(result.matched).toBe(false);
      expect(result.risk).toBe('moderate');
      expect(result.explanation).toBe('Custom command — review before executing');
      // Crucially, it does NOT pretend to know what the command does
      expect(result.explanation).not.toContain('awk');
      expect(result.explanation).not.toContain('sort');
    });

    it('dangerous commands flagged with risk=dangerous', () => {
      // rm without -rf is allowed but flagged dangerous
      const result = classifyTest.classifyCommand('rm somefile.txt');
      expect(result.blocked).toBe(false);
      expect(result.matched).toBe(true);
      expect(result.risk).toBe('dangerous');
    });
  });
});
