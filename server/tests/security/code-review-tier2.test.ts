// tests/security/code-review-tier2.test.ts
//
// Phase C Agent 1 — Tier 2 hardening tests (reviewTier + fence extraction).
//
// Per directive Section 2:
//   - reviewTier field distinguishes 'security-rejected' | 'stub-fallback' |
//     'llm-reviewed' | 'llm-error'
//   - Fence-based <review>JSON</review> extraction is the FIRST parse attempt
//   - Existing SCORE:/APPROVED: text-parse is the SECOND
//   - Stub-fallback is the FINAL fallback (unchanged, now tagged)
//
// These tests verify the parse chain by calling parseReviewResponse
// indirectly via review(). Since the stub engine produces unstructured
// output (no fences, no SCORE:/APPROVED:), most tests will hit the
// stub-fallback path. We test the fence-extraction path by mocking
// modelRouter.stream to return fenced JSON.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { CodeReviewAgent } from '../../src/agents/code-review/index.js';
import { modelRouter } from '../../src/orchestration/model-router.js';
import type { ReviewResult } from '../../src/types.js';

describe('Phase C — CodeReviewAgent Tier 2 hardening (reviewTier + fence extraction)', () => {
  let agent: CodeReviewAgent;

  beforeAll(() => {
    agent = new CodeReviewAgent();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Helper: mock modelRouter.stream to return a fixed string ────────
  function mockLlmResponse(text: string) {
    vi.spyOn(modelRouter, 'stream').mockReturnValue(
      (async function* () {
        yield { delta: text, done: false };
        yield { delta: '', done: true };
      })(),
    );
  }

  // ════════════════════════════════════════════════════════════════════
  // reviewTier field — all 4 values must be distinguishable
  // ════════════════════════════════════════════════════════════════════

  describe('reviewTier field distinguishes all 4 states', () => {
    it('security-rejected: Tier 1 regex catches a security issue', async () => {
      const result = await agent.review({
        content: 'const password = "supersecret123";',
        files: ['test.ts'],
      });
      expect(result.approved).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reviewTier).toBe('security-rejected');
    });

    it('stub-fallback: stub engine produces unstructured output, no security issues', async () => {
      // Don't mock — let the real stub engine run (it produces unstructured text)
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      expect(result.approved).toBe(true);
      expect(result.score).toBe(75);
      expect(result.reviewTier).toBe('stub-fallback');
    });

    it('llm-reviewed: LLM produces <review>JSON</review> fence (fence extraction)', async () => {
      mockLlmResponse(
        'Here is my review:\n<review>\n{"score": 92, "approved": true, "summary": "Excellent code.", "issues": ["[LOW] Consider adding a comment"]}\n</review>\nDone.',
      );
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      expect(result.approved).toBe(true);
      expect(result.score).toBe(92);
      expect(result.notes).toBe('Excellent code.');
      expect(result.issues).toContain('[LOW] Consider adding a comment');
      expect(result.reviewTier).toBe('llm-reviewed');
    });

    it('llm-reviewed: LLM produces SCORE:/APPROVED: text format (text-parse fallback)', async () => {
      mockLlmResponse(
        'SCORE: 88\nAPPROVED: true\n- [LOW] Missing JSDoc\nSUMMARY: Good code quality.',
      );
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      expect(result.approved).toBe(true);
      expect(result.score).toBe(88);
      expect(result.reviewTier).toBe('llm-reviewed');
    });

    it('llm-error: LLM call throws an error (fail-closed)', async () => {
      vi.spyOn(modelRouter, 'stream').mockImplementation(() => {
        throw new Error('simulated LLM failure');
      });
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      expect(result.approved).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reviewTier).toBe('llm-error');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Fence extraction — three-tier parse chain
  // ════════════════════════════════════════════════════════════════════

  describe('Three-tier parse chain (fence → text → stub-fallback)', () => {
    it('FIRST: <review>JSON</review> fence is extracted when present', async () => {
      mockLlmResponse(
        'Analysis complete.\n<review>\n{"score": 70, "approved": false, "summary": "Issues found.", "issues": ["[HIGH] Missing error handling"]}\n</review>',
      );
      const result = await agent.review({
        content: 'export function risky() { return data.value; }',
        files: ['test.ts'],
      });
      expect(result.reviewTier).toBe('llm-reviewed');
      expect(result.score).toBe(70);
      expect(result.approved).toBe(false);
      expect(result.issues).toContain('[HIGH] Missing error handling');
    });

    it('SECOND: SCORE:/APPROVED: text-parse works when no fences present', async () => {
      mockLlmResponse('SCORE: 95\nAPPROVED: true\nSUMMARY: Clean code.');
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      expect(result.reviewTier).toBe('llm-reviewed');
      expect(result.score).toBe(95);
      expect(result.approved).toBe(true);
    });

    it('FINAL: stub-fallback when LLM produces neither fences nor SCORE:/APPROVED:', async () => {
      // The stub engine produces generic unstructured text
      mockLlmResponse('I am the agent for domain REVIEW. I received your request...');
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      expect(result.reviewTier).toBe('stub-fallback');
      expect(result.score).toBe(75);
      expect(result.approved).toBe(true);
    });

    it('fence extraction handles multi-line JSON', async () => {
      mockLlmResponse(
        '<review>\n{\n  "score": 80,\n  "approved": true,\n  "summary": "Decent.",\n  "issues": [\n    "[LOW] Comment missing",\n    "[LOW] Test missing"\n  ]\n}\n</review>',
      );
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      expect(result.reviewTier).toBe('llm-reviewed');
      expect(result.score).toBe(80);
      expect(result.issues.length).toBe(2);
    });

    it('fence extraction falls through to text-parse if JSON is malformed', async () => {
      mockLlmResponse(
        '<review>\n{bad json missing quotes}\n</review>\nSCORE: 90\nAPPROVED: true\nSUMMARY: Good.',
      );
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      // Fence JSON parse failed → fell through to SCORE:/APPROVED: text-parse
      expect(result.reviewTier).toBe('llm-reviewed');
      expect(result.score).toBe(90);
    });

    it('fence extraction falls through if required fields are missing', async () => {
      mockLlmResponse(
        '<review>\n{"summary": "Missing score and approved fields"}\n</review>',
      );
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      // Fence JSON parsed but missing score/approved → fell through to stub-fallback
      expect(result.reviewTier).toBe('stub-fallback');
    });

    it('fence extraction does NOT match <review> without closing tag', async () => {
      mockLlmResponse(
        '<review>\n{"score": 50, "approved": false}\n(no closing tag)',
      );
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });
      // No closing </review> → fence regex doesn't match → stub-fallback
      expect(result.reviewTier).toBe('stub-fallback');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Security-rejected still takes priority over LLM output
  // ════════════════════════════════════════════════════════════════════

  describe('Security-rejected priority over LLM output', () => {
    it('Tier 1 security check fires BEFORE LLM call (no LLM invoked)', async () => {
      const streamSpy = vi.spyOn(modelRouter, 'stream');
      const result = await agent.review({
        content: 'const password = "supersecret123";',
        files: ['test.ts'],
      });
      expect(result.reviewTier).toBe('security-rejected');
      // modelRouter.stream should NOT have been called — Tier 1 short-circuits
      expect(streamSpy).not.toHaveBeenCalled();
    });

    it('Even if LLM approves, security issues override to reject', async () => {
      // Mock the LLM to approve — but the content has a security issue
      mockLlmResponse(
        '<review>\n{"score": 100, "approved": true, "summary": "Perfect!", "issues": []}\n</review>',
      );
      const result = await agent.review({
        content: 'const password = "supersecret123";',
        files: ['test.ts'],
      });
      // Tier 1 catches the hardcoded secret BEFORE the LLM is even called
      expect(result.reviewTier).toBe('security-rejected');
      expect(result.approved).toBe(false);
    });
  });
});
