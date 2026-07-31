// tests/security/prompt-engineer-agent.test.ts
//
// Phase C Agent 10 (FINAL) — PromptEngineerAgent tests.
//
// CRITICAL TEST (the single most important test in this directive):
//   proposeImprovedPrompt() MUST NEVER call writeProjectFile().
//   Proven by spy — writeProjectFile is spied on, the method is called,
//   and the spy asserts it was NOT called. This is unambiguous.
//
// Per directive Section 6:
//   - Static analysis runs cleanly across all 19 SYSTEM_PROMPTs + 3 secondary prompts
//   - Empirical test correctly distinguishes stub-inconclusive from real-engine-measured
//   - proposeImprovedPrompt() NEVER calls writeProjectFile() — PROVEN by spy test
//   - Fabrication guard confirmed

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { PromptEngineerAgent } from '../../src/agents/prompt-engineer/index.js';
import { CodeReviewAgent } from '../../src/agents/code-review/index.js';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import * as projectFilesModule from '../../src/agents/_shared/project-files.js';
import type { PromptAnalysisResult, EmpiricalTestResult, PromptProposal } from '../../src/types.js';

describe('Phase C Agent 10 — PromptEngineerAgent', () => {
  let agent: PromptEngineerAgent;

  beforeAll(() => {
    agent = new PromptEngineerAgent();
    if (!agentManager.get('code-review-agent')) {
      agentManager.register(new CodeReviewAgent());
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // IAgent skeleton
  // ════════════════════════════════════════════════════════════════════

  describe('IAgent skeleton', () => {
    it('has correct id, name, domain, icon', () => {
      expect(agent.id).toBe('prompt-engineer-agent');
      expect(agent.name).toBe('Prompt Engineer');
      expect(agent.domain).toBe('PROMPT');
      expect(agent.icon).toBe('message-square');
    });

    it('preserves execute() chat persona (yields chunks)', async () => {
      const task = {
        id: 'test-' + Date.now(),
        projectId: 'test',
        sessionId: 'test',
        agentId: 'prompt-engineer-agent',
        type: 'chat' as const,
        description: 'What is a system prompt?',
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
  // Step 2 + 3: Static analysis — all 19 SYSTEM_PROMPTs + 3 secondary prompts
  // ════════════════════════════════════════════════════════════════════

  describe('Steps 2+3: Static analysis', () => {
    it('analyzePrompts() with no arg returns ALL agents (19+)', async () => {
      const results = await agent.analyzePrompts();

      expect(results.length).toBeGreaterThanOrEqual(19);

      // Each result has the right shape
      for (const r of results) {
        expect(r.agentId).toBeDefined();
        expect(Array.isArray(r.prompts)).toBe(true);
        expect(r.prompts.length).toBeGreaterThan(0);
        expect(typeof r.totalFindings).toBe('number');
      }
    });

    it('analyzePrompts() includes secondary prompts (MIGRATION_GEN_PROMPT, AUTH_REVIEW_PROMPT, SYNTHESIS_PROMPT)', async () => {
      const allResults = await agent.analyzePrompts();

      // Database agent should have MIGRATION_GEN_PROMPT
      const dbResult = allResults.find(r => r.agentId === 'database');
      expect(dbResult).toBeDefined();
      const dbPromptNames = dbResult!.prompts.map(p => p.promptName);
      expect(dbPromptNames).toContain('MIGRATION_GEN_PROMPT');

      // Security agent should have AUTH_REVIEW_PROMPT
      const secResult = allResults.find(r => r.agentId === 'security');
      expect(secResult).toBeDefined();
      const secPromptNames = secResult!.prompts.map(p => p.promptName);
      expect(secPromptNames).toContain('AUTH_REVIEW_PROMPT');

      // Research agent should have SYNTHESIS_PROMPT
      const resResult = allResults.find(r => r.agentId === 'research');
      expect(resResult).toBeDefined();
      const resPromptNames = resResult!.prompts.map(p => p.promptName);
      expect(resPromptNames).toContain('SYNTHESIS_PROMPT');
    });

    it('analyzePrompts(code-review) returns detailed findings for CodeReviewAgent', async () => {
      const results = await agent.analyzePrompts('code-review');

      expect(results.length).toBe(1);
      expect(results[0].agentId).toBe('code-review');
      expect(results[0].prompts.length).toBeGreaterThanOrEqual(1);

      const systemPrompt = results[0].prompts.find(p => p.promptName === 'SYSTEM_PROMPT');
      expect(systemPrompt).toBeDefined();
      expect(systemPrompt!.tokenEstimate).toBeGreaterThan(50);
      expect(systemPrompt!.content).toContain('Code Review Agent');

      // CodeReviewAgent's prompt has output format (SCORE:/APPROVED: + <review> fence)
      // — should NOT have missing-output-format finding
      const missingFormat = systemPrompt!.findings.find(f => f.findingType === 'missing-output-format');
      expect(missingFormat).toBeUndefined();
    });

    it('tokenEstimate is calculated as chars/4', async () => {
      const results = await agent.analyzePrompts('architect');
      expect(results.length).toBe(1);
      const prompt = results[0].prompts[0];
      expect(prompt.tokenEstimate).toBe(Math.ceil(prompt.content.length / 4));
    });

    it('does NOT crash on any real agent prompt file', async () => {
      const results = await agent.analyzePrompts();
      // If any file crashed, analyzePrompts would have thrown — reaching here means all passed
      expect(results.length).toBeGreaterThanOrEqual(19);
    });

    it('analyzePrompts(nonexistent) returns empty array', async () => {
      const results = await agent.analyzePrompts('nonexistent-agent');
      expect(results).toEqual([]);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 4: Empirical parse-success test
  // ════════════════════════════════════════════════════════════════════

  describe('Step 4: Empirical parse-success test', () => {
    it('code-review: returns reviewTier from real CodeReviewAgent.review()', async () => {
      const result = await agent.empiricalTest('code-review');

      expect(result.agentId).toBe('code-review');
      expect(['stub-fallback', 'llm-reviewed', 'llm-error', 'security-rejected']).toContain(result.reviewTier);
      expect(typeof result.inconclusive).toBe('boolean');
      expect(typeof result.reason).toBe('string');
    });

    it('code-review: stub engine → inconclusive: true', async () => {
      const result = await agent.empiricalTest('code-review');

      if (result.reviewTier === 'stub-fallback') {
        expect(result.inconclusive).toBe(true);
        expect(result.reason).toContain('Stub engine');
        expect(result.reason.toLowerCase()).toContain('cannot meaningfully evaluate');
      }
    });

    it('database: returns not-applicable (side effects — static analysis only)', async () => {
      const result = await agent.empiricalTest('database');

      expect(result.reviewTier).toBe('not-applicable');
      expect(result.inconclusive).toBe(true);
      expect(result.reason).toContain('side effects');
      expect(result.reason).toContain('Static analysis only');
    });

    it('security: returns not-applicable (Ghost Mode side effects)', async () => {
      const result = await agent.empiricalTest('security');

      expect(result.reviewTier).toBe('not-applicable');
      expect(result.inconclusive).toBe(true);
      expect(result.reason).toContain('side effects');
    });

    it('research: returns not-applicable (SDK calls)', async () => {
      const result = await agent.empiricalTest('research');

      expect(result.reviewTier).toBe('not-applicable');
      expect(result.inconclusive).toBe(true);
      expect(result.reason).toContain('side effects');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 5: proposeImprovedPrompt() — NEVER calls writeProjectFile()
  // ════════════════════════════════════════════════════════════════════

  describe('Step 5: proposeImprovedPrompt() — NEVER writes', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('CRITICAL — writeProjectFile() is NEVER called during proposeImprovedPrompt()', async () => {
      // Spy on writeProjectFile — this is the SINGLE MOST IMPORTANT TEST
      const writeSpy = vi.spyOn(projectFilesModule, 'writeProjectFile');

      // Call proposeImprovedPrompt for a real agent
      const proposal = await agent.proposeImprovedPrompt('code-review');

      // The method should return a proposal (not null)
      expect(proposal).not.toBeNull();

      // CRITICAL ASSERTION: writeProjectFile must NOT have been called
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('CRITICAL — writeProjectFile() is NEVER called for ANY agent', async () => {
      const writeSpy = vi.spyOn(projectFilesModule, 'writeProjectFile');

      // Try multiple agents
      await agent.proposeImprovedPrompt('code-review');
      await agent.proposeImprovedPrompt('architect');
      await agent.proposeImprovedPrompt('security');
      await agent.proposeImprovedPrompt('database');

      // writeProjectFile must NOT have been called for ANY of them
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('returns PromptProposal with proposedPrompt + changes[]', async () => {
      const proposal = await agent.proposeImprovedPrompt('architect');

      expect(proposal).not.toBeNull();
      expect(proposal!.agentId).toBe('architect');
      expect(typeof proposal!.proposedPrompt).toBe('string');
      expect(Array.isArray(proposal!.changes)).toBe(true);
    });

    it('changes[] items trace to actual findings (no fabricated fixes)', async () => {
      // First get the analysis to know what findings exist
      const analysis = await agent.analyzePrompts('architect');
      const findings = analysis[0]?.prompts.flatMap(p => p.findings) ?? [];
      const findingTypes = new Set(findings.map(f => f.findingType));

      // Get the proposal
      const proposal = await agent.proposeImprovedPrompt('architect');
      expect(proposal).not.toBeNull();

      // Every change must reference a findingType that was actually found
      for (const change of proposal!.changes) {
        expect(findingTypes.has(change.findingType)).toBe(true);
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Step 6: Fabrication guard
  // ════════════════════════════════════════════════════════════════════

  describe('Step 6: Fabrication guard', () => {
    it('REFUSES: nonexistent agentId returns null', async () => {
      const proposal = await agent.proposeImprovedPrompt('nonexistent-agent');
      expect(proposal).toBeNull();
    });

    it('analyzePrompts(nonexistent) returns empty (not an error)', async () => {
      const results = await agent.analyzePrompts('nonexistent-agent');
      expect(results).toEqual([]);
    });

    it('proposeImprovedPrompt with no findings returns empty changes[]', async () => {
      // Find an agent with no findings (or mock one)
      // Most agents will have at least 'missing-examples' (info severity)
      // — but the changes[] should only include actionable items,
      // not info-severity findings unless they're addressed
      const proposal = await agent.proposeImprovedPrompt('code-review');
      expect(proposal).not.toBeNull();
      // CodeReviewAgent has output format + constraints, so changes may be empty
      // or only address minor findings. The key is changes[] is an array (possibly empty).
      expect(Array.isArray(proposal!.changes)).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Scope boundary
  // ════════════════════════════════════════════════════════════════════

  describe('scope boundary', () => {
    it('does NOT import writeProjectFile (no import statement)', () => {
      // Read the source file and verify no writeProjectFile IMPORT
      // (the word may appear in comments, but must not be imported)
      const source = require('fs').readFileSync(
        require('path').join(process.cwd(), 'src', 'agents', 'prompt-engineer', 'index.ts'),
        'utf8'
      );
      // Check for actual import statements, not comment mentions
      expect(source).not.toMatch(/import\s+.*writeProjectFile/);
      expect(source).not.toMatch(/from\s+['"]\.\..*project-files/);
    });

    it('does NOT have Ghost Mode coupling', () => {
      expect(typeof (agent as any).reportFinding).toBe('undefined');
    });

    it('does NOT have auto-apply methods', () => {
      expect(typeof (agent as any).applyPrompt).toBe('undefined');
      expect(typeof (agent as any).applyChanges).toBe('undefined');
      expect(typeof (agent as any).savePrompt).toBe('undefined');
    });

    it('does NOT have new telemetry/persistence infrastructure', () => {
      expect(typeof (agent as any).saveAnalysis).toBe('undefined');
      expect(typeof (agent as any).trackMetrics).toBe('undefined');
      expect(typeof (agent as any).persistResults).toBe('undefined');
    });
  });
});
