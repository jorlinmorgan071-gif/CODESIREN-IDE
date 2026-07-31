// tests/security/ui-designer-agent.test.ts
//
// Phase C Agent 9 — UIDesignerAgent tests.
//
// CRITICAL (Step 2): Component generation is tested with a REAL (not mocked)
// write through the actual cross-package writeProjectFile() → CodeReviewAgent
// path — file existence proven before/after, then cleaned up. Same standard
// as the Section 1 pre-build proof. This is the specific gap the original
// session got caught on for this exact agent.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UIDesignerAgent } from '../../src/agents/ui-designer/index.js';
import { CodeReviewAgent } from '../../src/agents/code-review/index.js';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import * as projectFilesModule from '../../src/agents/_shared/project-files.js';
import type { UIReviewResult } from '../../src/types.js';

const PROJECT_ROOT = join(process.cwd(), '..');

describe('Phase C Agent 9 — UIDesignerAgent', () => {
  let agent: UIDesignerAgent;

  beforeAll(() => {
    agent = new UIDesignerAgent();
    if (!agentManager.get('code-review-agent')) {
      agentManager.register(new CodeReviewAgent());
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // IAgent skeleton
  // ════════════════════════════════════════════════════════════════════

  describe('IAgent skeleton', () => {
    it('has correct id, name, domain, icon', () => {
      expect(agent.id).toBe('ui-designer-agent');
      expect(agent.name).toBe('UI Designer Agent');
      expect(agent.domain).toBe('DESIGN');
      expect(agent.icon).toBe('palette');
    });

    it('preserves execute() chat persona (yields chunks)', async () => {
      const task = {
        id: 'test-' + Date.now(),
        projectId: 'test',
        sessionId: 'test',
        agentId: 'ui-designer-agent',
        type: 'chat' as const,
        description: 'What is a design token?',
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
  // Step 2: Component generation — REAL cross-package write (NOT mocked)
  // ════════════════════════════════════════════════════════════════════

  describe('Step 2: Component generation (REAL cross-package write)', () => {
    it('writes a component file to app/src/ via REAL writeProjectFile() — file existence proven before/after', async () => {
      // Use the REAL project root — write to app/src/components/ui/
      const componentPath = 'app/src/components/ui/TestGenerated.tsx';
      const fullPath = join(PROJECT_ROOT, componentPath);

      // Ensure parent dir exists
      mkdirSync(join(PROJECT_ROOT, 'app', 'src', 'components', 'ui'), { recursive: true });

      // BEFORE: file should not exist (clean state)
      if (existsSync(fullPath)) {
        rmSync(fullPath);
      }
      expect(existsSync(fullPath)).toBe(false);

      // Generate the component (REAL write, NOT mocked)
      const result = await agent.generateComponent({
        projectRoot: PROJECT_ROOT,
        componentPath,
        componentName: 'TestGenerated',
        description: 'Test component for cross-package write proof',
        props: [
          { name: 'label', type: 'string', required: true },
          { name: 'onClick', type: '() => void', required: false },
        ],
      });

      // Verify write succeeded
      expect(result.written).toBe(true);
      expect(result.refused).toBeUndefined();

      // AFTER: file should exist on disk
      expect(existsSync(fullPath)).toBe(true);

      // Verify content matches conventions
      const writtenContent = readFileSync(fullPath, 'utf8');
      expect(writtenContent).toContain('// app/src/components/ui/TestGenerated.tsx');
      expect(writtenContent).toContain('interface TestGeneratedProps');
      expect(writtenContent).toContain("import React from 'react'");
      expect(writtenContent).toContain("import { cn } from '@/lib/utils'");
      expect(writtenContent).toContain('export const TestGenerated');
      expect(writtenContent).not.toContain('@param'); // NOT JSDoc
      expect(writtenContent).not.toContain('@returns');

      // CLEAN UP — remove the test file
      rmSync(fullPath);
      expect(existsSync(fullPath)).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 3: Component generation with icons + animation
  // ════════════════════════════════════════════════════════════════════

  describe('Step 3: Component generation with icons + animation', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-gen-'));
      mkdirSync(join(fixtureRoot, 'app', 'src', 'components', 'ui'), { recursive: true });
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

    it('generates component with motion/react import when includeAnimation=true', async () => {
      mockWriteSuccess();

      const result = await agent.generateComponent({
        projectRoot: fixtureRoot,
        componentPath: 'app/src/components/ui/AnimatedCard.tsx',
        componentName: 'AnimatedCard',
        description: 'Card with entrance animation',
        includeAnimation: true,
      });

      expect(result.written).toBe(true);
      expect(result.content).toContain("import { motion } from 'motion/react'");
      expect(result.content).toContain('<motion.div');
      expect(result.content).toContain('initial={{ opacity: 0 }}');
      expect(result.content).toContain('animate={{ opacity: 1 }}');
    });

    it('generates component with lucide-react import when includeIcons=true', async () => {
      mockWriteSuccess();

      const result = await agent.generateComponent({
        projectRoot: fixtureRoot,
        componentPath: 'app/src/components/ui/IconButton.tsx',
        componentName: 'IconButton',
        description: 'Button with icon',
        includeIcons: true,
      });

      expect(result.written).toBe(true);
      expect(result.content).toContain("import { Check } from 'lucide-react'");
      expect(result.content).toContain('<Check');
      // Icon should have aria-hidden="true" (accessibility default)
      expect(result.content).toContain('aria-hidden="true"');
    });

    it('generated content uses CSS variable tokens, NOT hardcoded hex', async () => {
      mockWriteSuccess();

      const result = await agent.generateComponent({
        projectRoot: fixtureRoot,
        componentPath: 'app/src/components/ui/TokenCard.tsx',
        componentName: 'TokenCard',
        description: 'Card using design tokens',
        includeIcons: true,
      });

      expect(result.written).toBe(true);
      // Should use var(--token-name) pattern
      expect(result.content).toContain('var(--');
      // Should NOT contain hardcoded hex colors
      expect(result.content).not.toMatch(/#[0-9A-Fa-f]{6}/);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 4: Token-fabrication guard
  // ════════════════════════════════════════════════════════════════════

  describe('Step 4: Token-fabrication guard', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-fab-'));
      mkdirSync(join(fixtureRoot, 'app', 'src'), { recursive: true });
      vi.restoreAllMocks();
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('REFUSES: requested color not in token list', async () => {
      const result = await agent.generateComponent({
        projectRoot: fixtureRoot,
        componentPath: 'app/src/components/ui/BadColor.tsx',
        componentName: 'BadColor',
        description: 'Component with unknown color',
        requiredColor: '#FF00FF', // not in token list
      });

      expect(result.written).toBe(false);
      expect(result.refused).toBeDefined();
      expect(result.refused).toContain('#FF00FF');
      expect(result.refused).toContain('not in the design-token list');
    });

    it('APPROVES: requested color IS in token list', async () => {
      vi.spyOn(projectFilesModule, 'writeProjectFile').mockResolvedValue({
        written: true,
        path: 'mocked',
        review: { approved: true, score: 100, notes: 'mocked', issues: [] },
      });

      const result = await agent.generateComponent({
        projectRoot: fixtureRoot,
        componentPath: 'app/src/components/ui/GoodColor.tsx',
        componentName: 'GoodColor',
        description: 'Component with known color',
        requiredColor: '#EE1C1C', // --siren-red, in token list
      });

      expect(result.written).toBe(true);
      expect(result.refused).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 5: uiReview() — token findings (live-code test against REAL files)
  // ════════════════════════════════════════════════════════════════════

  describe('Step 5: uiReview() — token findings', () => {
    it('LIVE-CODE: flags hardcoded hex in real Terminal.tsx', async () => {
      const terminalPath = join(PROJECT_ROOT, 'app', 'src', 'components', 'terminal', 'Terminal.tsx');
      if (!existsSync(terminalPath)) {
        console.log('[live test] Terminal.tsx not found — skipping');
        return;
      }

      const result = await agent.uiReview(terminalPath);

      // Terminal.tsx has 10+ hardcoded hex colors (confirmed in Section 0)
      expect(result.tokenFindings.length).toBeGreaterThanOrEqual(5);

      // Should include known token colors (suggesting var() usage)
      const knownTokenFindings = result.tokenFindings.filter(f =>
        f.suggestion.includes('Use var(')
      );
      expect(knownTokenFindings.length).toBeGreaterThan(0);

      // Verify some specific colors are found
      const colors = result.tokenFindings.map(f => f.hardcodedColor.toUpperCase());
      expect(colors).toContain('#EE1C1C'); // --siren-red
      expect(colors).toContain('#C8C8DC'); // --bright-silver
    });

    it('LIVE-CODE: flags hardcoded hex in real TracingView.tsx', async () => {
      const tracingPath = join(PROJECT_ROOT, 'app', 'src', 'components', 'dashboard', 'views', 'TracingView.tsx');
      if (!existsSync(tracingPath)) {
        console.log('[live test] TracingView.tsx not found — skipping');
        return;
      }

      const result = await agent.uiReview(tracingPath);
      expect(result.tokenFindings.length).toBeGreaterThanOrEqual(1);
      expect(result.tokenFindings[0].line).toBeGreaterThan(0);
    });

    it('FALSE-POSITIVE: clean fixture with no hardcoded hex → 0 token findings', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-clean-'));
      const cleanFile = join(fixtureRoot, 'Clean.tsx');
      writeFileSync(cleanFile, [
        '// Clean.tsx',
        "import React from 'react';",
        '',
        'export const Clean: React.FC = () => {',
        "  return <div className=\"text-[var(--bright-silver)]\" />;",
        '};',
      ].join('\n'));

      try {
        const result = await agent.uiReview(cleanFile);
        expect(result.tokenFindings).toEqual([]);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('suggests correct token for known hex colors', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-tokens-'));
      const testFile = join(fixtureRoot, 'TokenTest.tsx');
      writeFileSync(testFile, [
        '// TokenTest.tsx',
        "export const T = () => <div style={{ color: '#EE1C1C' }} />;",
      ].join('\n'));

      try {
        const result = await agent.uiReview(testFile);
        expect(result.tokenFindings.length).toBe(1);
        expect(result.tokenFindings[0].hardcodedColor).toBe('#EE1C1C');
        expect(result.tokenFindings[0].suggestion).toContain('var(--siren-red)');
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 6: uiReview() — accessibility findings
  // ════════════════════════════════════════════════════════════════════

  describe('Step 6: uiReview() — accessibility findings', () => {
    it('FLAGS: <img> without alt attribute', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-a11y-img-'));
      const testFile = join(fixtureRoot, 'NoAlt.tsx');
      writeFileSync(testFile, [
        '// NoAlt.tsx',
        "export const N = () => <img src=\"test.jpg\" />;",
      ].join('\n'));

      try {
        const result = await agent.uiReview(testFile);
        const imgFindings = result.accessibilityFindings.filter(f => f.issue.includes('<img>'));
        expect(imgFindings.length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('FALSE-POSITIVE: <img> WITH alt → not flagged', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-a11y-img-ok-'));
      const testFile = join(fixtureRoot, 'HasAlt.tsx');
      writeFileSync(testFile, [
        '// HasAlt.tsx',
        "export const H = () => <img src=\"test.jpg\" alt=\"Test image\" />;",
      ].join('\n'));

      try {
        const result = await agent.uiReview(testFile);
        const imgFindings = result.accessibilityFindings.filter(f => f.issue.includes('<img>'));
        expect(imgFindings).toEqual([]);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('FLAGS: <input> without id/aria-label/aria-labelledby', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-a11y-input-'));
      const testFile = join(fixtureRoot, 'NoLabel.tsx');
      writeFileSync(testFile, [
        '// NoLabel.tsx',
        "export const N = () => <input type=\"text\" />;",
      ].join('\n'));

      try {
        const result = await agent.uiReview(testFile);
        const inputFindings = result.accessibilityFindings.filter(f => f.issue.includes('<input>'));
        expect(inputFindings.length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('FALSE-POSITIVE: <input> WITH aria-label → not flagged', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-a11y-input-ok-'));
      const testFile = join(fixtureRoot, 'HasLabel.tsx');
      writeFileSync(testFile, [
        '// HasLabel.tsx',
        "export const H = () => <input type=\"text\" aria-label=\"Search\" />;",
      ].join('\n'));

      try {
        const result = await agent.uiReview(testFile);
        const inputFindings = result.accessibilityFindings.filter(f => f.issue.includes('<input>'));
        expect(inputFindings).toEqual([]);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 7: uiReview() — convention findings
  // ════════════════════════════════════════════════════════════════════

  describe('Step 7: uiReview() — convention findings', () => {
    it('PASSES: file with // header + typed props + no any', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-conv-good-'));
      const testFile = join(fixtureRoot, 'Good.tsx');
      writeFileSync(testFile, [
        '// Good.tsx',
        '// A well-conforming component',
        "import React from 'react';",
        '',
        'interface GoodProps {',
        '  label: string;',
        '}',
        '',
        'export const Good: React.FC<GoodProps> = ({ label }) => {',
        '  return <div>{label}</div>;',
        '};',
      ].join('\n'));

      try {
        const result = await agent.uiReview(testFile);
        const headerConv = result.conventionFindings.find(c => c.rule === 'file-level-header-comment');
        expect(headerConv?.passed).toBe(true);
        const propsConv = result.conventionFindings.find(c => c.rule === 'typed-props-interface');
        expect(propsConv?.passed).toBe(true);
        const anyConv = result.conventionFindings.find(c => c.rule === 'no-any-type');
        expect(anyConv?.passed).toBe(true);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('FAILS: file without header comment', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-conv-noheader-'));
      const testFile = join(fixtureRoot, 'NoHeader.tsx');
      writeFileSync(testFile, [
        "import React from 'react';",
        '',
        'export const N = () => <div />;',
      ].join('\n'));

      try {
        const result = await agent.uiReview(testFile);
        const headerConv = result.conventionFindings.find(c => c.rule === 'file-level-header-comment');
        expect(headerConv?.passed).toBe(false);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('FAILS: file with `any` type', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-conv-any-'));
      const testFile = join(fixtureRoot, 'HasAny.tsx');
      writeFileSync(testFile, [
        '// HasAny.tsx',
        "import React from 'react';",
        '',
        'export const H = (props: any) => <div />;',
      ].join('\n'));

      try {
        const result = await agent.uiReview(testFile);
        const anyConv = result.conventionFindings.find(c => c.rule === 'no-any-type');
        expect(anyConv?.passed).toBe(false);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // review() override — advisory only
  // ════════════════════════════════════════════════════════════════════

  describe('review() override — advisory only', () => {
    it('ALWAYS returns approved: true regardless of findings', async () => {
      // Use a file with violations — review() must still approve
      const terminalPath = join(PROJECT_ROOT, 'app', 'src', 'components', 'terminal', 'Terminal.tsx');
      if (!existsSync(terminalPath)) return;

      const result = await agent.review({
        content: 'test',
        files: [terminalPath],
      });

      expect(result.approved).toBe(true);
    });

    it('outOfScopeNote is always present in uiReview result', async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'cs-ui-oos-'));
      const testFile = join(fixtureRoot, 'Test.tsx');
      writeFileSync(testFile, '// Test\nexport const T = () => <div />;\n');

      try {
        const result = await agent.uiReview(testFile);
        expect(result.outOfScopeNote).toBeDefined();
        expect(result.outOfScopeNote).toContain('NOT performed');
        expect(result.outOfScopeNote).toContain('out of scope');
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Scope boundary
  // ════════════════════════════════════════════════════════════════════

  describe('scope boundary', () => {
    it('does NOT have Storybook/visual-regression methods', () => {
      expect(typeof (agent as any).runStorybook).toBe('undefined');
      expect(typeof (agent as any).visualRegression).toBe('undefined');
    });

    it('does NOT have contrast-ratio calculation methods', () => {
      expect(typeof (agent as any).calculateContrast).toBe('undefined');
      expect(typeof (agent as any).wcagCheck).toBe('undefined');
    });

    it('does NOT have Ghost Mode coupling', () => {
      expect(typeof (agent as any).reportFinding).toBe('undefined');
    });
  });
});
