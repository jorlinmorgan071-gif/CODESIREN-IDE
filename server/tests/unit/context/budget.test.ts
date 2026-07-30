// tests/unit/context/budget.test.ts
//
// Phase B Step 2 — Unit tests for the token budgeting + truncation logic.
//
// Per directive Section 5 Step 2: "Verify: unit test with a fake oversized
// bundle, confirm correct truncation order and that selection/open-file are
// never dropped."

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeBundleBudget,
  lookupContextWindow,
  estimateTokens,
  estimateOpenFileTokens,
  estimateSelectionTokens,
  estimateConversationTurnTokens,
  estimateMemoryTokens,
  estimateProjectGraphNodeTokens,
  applyBudget,
  DEFAULT_FALLBACK_CONTEXT_WINDOW,
  RESPONSE_RESERVE_FRACTION,
} from '../../../src/context/budget.js';
import type {
  ContextBundle,
  OpenFile,
  ActiveSelection,
  ConversationTurn,
  RelevantMemory,
  ProjectGraphNode,
} from '../../../src/context/types.js';

describe('Phase B — budget.ts token estimator', () => {
  it('estimateTokens: empty string → 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimateTokens: returns at least 1 for any non-empty string', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('ab')).toBe(1); // 2/4 = 0.5 → ceil = 1
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // 5/4 = 1.25 → ceil = 2
  });

  it('estimateTokens: ~chars/4 for typical strings', () => {
    // 40 chars → 10 tokens
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    // 100 chars → 25 tokens
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  it('estimateOpenFileTokens: includes path + language + content + header overhead', () => {
    const file: OpenFile = {
      path: 'src/foo.ts',           // 10 chars → 3 tokens (ceil 10/4)
      language: 'typescript',       // 10 chars → 3 tokens
      content: 'export const x = 1;', // 20 chars → 5 tokens
    };
    // 3 + 3 + 5 + 8 (header overhead) = 19
    expect(estimateOpenFileTokens(file)).toBe(19);
  });

  it('estimateSelectionTokens: includes path + text + header overhead', () => {
    const sel: ActiveSelection = {
      path: 'src/bar.ts',  // 10 chars → 3
      startLine: 1,
      endLine: 5,
      text: 'const y = 2;', // 12 chars → 3
    };
    // 3 + 3 + 12 (selection header overhead) = 18
    expect(estimateSelectionTokens(sel)).toBe(18);
  });

  it('estimateConversationTurnTokens: includes role + content + header overhead', () => {
    const turn: ConversationTurn = {
      role: 'user',     // 4 chars → 1
      content: 'hello world', // 11 chars → 3
    };
    // 1 + 3 + 8 (header overhead) = 12
    expect(estimateConversationTurnTokens(turn)).toBe(12);
  });

  it('estimateMemoryTokens: includes content + source + header overhead', () => {
    const mem: RelevantMemory = {
      content: 'remember this', // 13 chars → 4
      score: 0.92,
      source: 'agent', // 5 chars → 2
    };
    // 4 + 2 + 12 (header overhead) = 18
    expect(estimateMemoryTokens(mem)).toBe(18);
  });

  it('estimateProjectGraphNodeTokens: file + each import + overhead', () => {
    const node: ProjectGraphNode = {
      file: 'src/index.ts', // 12 chars → 3
      imports: [
        './foo', // 5 chars → 2
        'react', // 5 chars → 2
        './utils/bar', // 12 chars → 3
      ],
    };
    // 3 (file) + 8 (node overhead) + (2+4) + (2+4) + (3+4) = 30
    expect(estimateProjectGraphNodeTokens(node)).toBe(30);
  });
});

describe('Phase B — budget.ts context window lookup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lookupContextWindow: returns known value for "anthropic/claude-3.5-sonnet"', () => {
    expect(lookupContextWindow('anthropic/claude-3.5-sonnet')).toBe(200_000);
  });

  it('lookupContextWindow: returns known value for "deepseek/deepseek-coder"', () => {
    expect(lookupContextWindow('deepseek/deepseek-coder')).toBe(128_000);
  });

  it('lookupContextWindow: returns known value for "openai/gpt-4o"', () => {
    expect(lookupContextWindow('openai/gpt-4o')).toBe(128_000);
  });

  it('lookupContextWindow: unknown modelId → fallback 32K + WARN log', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = lookupContextWindow('some/fake-model');
    expect(result).toBe(DEFAULT_FALLBACK_CONTEXT_WINDOW);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('some/fake-model');
    expect(warnSpy.mock.calls[0][0]).toContain('fail-closed');
  });

  it('lookupContextWindow: empty modelId → fallback 32K + INFO log (expected in Phase B)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = lookupContextWindow('');
    expect(result).toBe(DEFAULT_FALLBACK_CONTEXT_WINDOW);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('no modelId provided');
    expect(logSpy.mock.calls[0][0]).toContain('expected in Phase B');
  });

  it('computeBundleBudget: 25% reserve subtracted from full window', () => {
    // claude-3.5-sonnet: 200K full → 150K bundle budget (75%)
    expect(computeBundleBudget('anthropic/claude-3.5-sonnet')).toBe(150_000);
    // deepseek-coder: 128K → 96K
    expect(computeBundleBudget('deepseek/deepseek-coder')).toBe(96_000);
    // fallback 32K → 24K
    expect(computeBundleBudget('')).toBe(24_000);
  });

  it('RESPONSE_RESERVE_FRACTION is exactly 0.25', () => {
    expect(RESPONSE_RESERVE_FRACTION).toBe(0.25);
  });
});

describe('Phase B — budget.ts applyBudget truncation logic', () => {
  /**
   * Build a fake bundle for testing. Each source can be sized independently
   * via the optional params.
   */
  function makeBundle(opts: {
    openFiles?: OpenFile[];
    selection?: ActiveSelection | null;
    projectGraph?: ProjectGraphNode[];
    conversationHistory?: ConversationTurn[];
    relevantMemory?: RelevantMemory[];
  }): ContextBundle {
    return {
      openFiles: opts.openFiles ?? [],
      selection: opts.selection ?? null,
      projectGraph: opts.projectGraph ?? [],
      conversationHistory: opts.conversationHistory ?? [],
      relevantMemory: opts.relevantMemory ?? [],
      tokenBudget: { max: 0, used: 0, truncated: [] }, // recomputed by applyBudget
    };
  }

  it('applyBudget: bundle already under budget → no truncation, clean tokenBudget', () => {
    const bundle = makeBundle({
      openFiles: [{ path: 'foo.ts', language: 'typescript', content: 'const x = 1;' }],
      selection: { path: 'foo.ts', startLine: 1, endLine: 1, text: 'const x = 1;' },
    });
    const result = applyBudget(bundle, 1000);
    expect(result.tokenBudget.used).toBeLessThanOrEqual(1000);
    expect(result.tokenBudget.truncated).toEqual([]);
    expect(result.bundle.openFiles.length).toBe(1);
    expect(result.bundle.selection).not.toBeNull();
  });

  it('applyBudget: empty bundle → used=0, no truncation', () => {
    const bundle = makeBundle({});
    const result = applyBudget(bundle, 1000);
    expect(result.tokenBudget.used).toBe(0);
    expect(result.tokenBudget.truncated).toEqual([]);
  });

  // ── Truncation order tests (the directive's Section 5 Step 2 verify) ──

  it('applyBudget: drops projectGraph FIRST when over budget', () => {
    // Build a bundle that's over budget due to projectGraph alone
    const hugeGraph: ProjectGraphNode[] = Array.from({ length: 50 }, (_, i) => ({
      file: `src/file${i}.ts`,
      imports: [`./dep${i}a`, `./dep${i}b`, `./dep${i}c`, 'react'],
    }));
    const bundle = makeBundle({
      openFiles: [{ path: 'main.ts', language: 'typescript', content: 'const x = 1;' }],
      selection: { path: 'main.ts', startLine: 1, endLine: 1, text: 'const x = 1;' },
      projectGraph: hugeGraph,
    });
    // Use a small budget to force truncation
    const result = applyBudget(bundle, 200);

    expect(result.bundle.projectGraph).toEqual([]);
    expect(result.tokenBudget.truncated.length).toBeGreaterThanOrEqual(1);
    expect(result.tokenBudget.truncated[0]).toContain('projectGraph');
    expect(result.tokenBudget.truncated[0]).toContain('50 nodes');
    // Selection and openFiles are preserved
    expect(result.bundle.selection).not.toBeNull();
    expect(result.bundle.openFiles.length).toBe(1);
  });

  it('applyBudget: after dropping projectGraph, drops OLDEST conversation turns next', () => {
    // Build a bundle where projectGraph is empty (already small) but
    // conversationHistory is huge — turns should be dropped oldest-first.
    const turns: ConversationTurn[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `This is conversation turn number ${i}. `.repeat(5), // ~40 chars * 5 = 200 chars = 50 tokens each
    }));
    const bundle = makeBundle({
      openFiles: [{ path: 'main.ts', language: 'typescript', content: 'const x = 1;' }],
      selection: { path: 'main.ts', startLine: 1, endLine: 1, text: 'const x = 1;' },
      conversationHistory: turns,
    });
    // Budget = 200 tokens. openFiles + selection alone is ~50 tokens. Each turn is ~58 tokens.
    // Should drop ~3 turns (the OLDEST 3) to get under 200.
    const result = applyBudget(bundle, 200);

    expect(result.bundle.conversationHistory.length).toBeLessThan(20);
    // The kept turns should be the MOST RECENT ones (last N of the original array)
    const lastKept = result.bundle.conversationHistory[result.bundle.conversationHistory.length - 1];
    expect(lastKept.content).toContain('turn number 19'); // most recent
    // The truncated list should mention history entries
    expect(result.tokenBudget.truncated.some(t => t.startsWith('history:'))).toBe(true);
    // Selection and openFiles are preserved
    expect(result.bundle.selection).not.toBeNull();
    expect(result.bundle.openFiles.length).toBe(1);
  });

  it('applyBudget: after dropping history, drops LOWEST-SCORING memory entries next', () => {
    // Build a bundle where projectGraph and history are empty but memory is
    // huge — memory entries should be dropped lowest-score-first.
    const mems: RelevantMemory[] = Array.from({ length: 10 }, (_, i) => ({
      content: `Memory content for entry ${i}. `.repeat(5), // ~150 chars = 38 tokens
      score: 0.95 - (i * 0.05), // 0.95, 0.90, 0.85, ..., 0.50 (HIGHEST FIRST)
      source: 'agent',
    }));
    const bundle = makeBundle({
      openFiles: [{ path: 'main.ts', language: 'typescript', content: 'const x = 1;' }],
      selection: { path: 'main.ts', startLine: 1, endLine: 1, text: 'const x = 1;' },
      relevantMemory: mems,
    });
    const result = applyBudget(bundle, 200);

    expect(result.bundle.relevantMemory.length).toBeLessThan(10);
    // The KEPT entries should be the HIGHEST-SCORING ones (front of original array)
    const firstKept = result.bundle.relevantMemory[0];
    expect(firstKept.score).toBe(0.95); // highest score preserved
    // The truncated list should mention memory entries with their scores
    const memTruncations = result.tokenBudget.truncated.filter(t => t.startsWith('memory:'));
    expect(memTruncations.length).toBeGreaterThan(0);
    // The LAST memory truncation entry should be the lowest-scored that was dropped
    expect(memTruncations.some(t => t.includes('score=0.500'))).toBe(true);
    // Selection and openFiles are preserved
    expect(result.bundle.selection).not.toBeNull();
    expect(result.bundle.openFiles.length).toBe(1);
  });

  // ── THE BIG ONE: never drop selection or openFiles ──────────────────

  it('CRITICAL — applyBudget: NEVER truncates selection, even when bundle is way over budget', () => {
    // Selection alone is larger than the budget
    const hugeSelection: ActiveSelection = {
      path: 'huge.ts',
      startLine: 1,
      endLine: 1000,
      text: 'x'.repeat(10000), // 10K chars = 2500 tokens
    };
    const bundle = makeBundle({
      openFiles: [{ path: 'huge.ts', language: 'typescript', content: 'x'.repeat(5000) }],
      selection: hugeSelection,
      projectGraph: [{ file: 'dep.ts', imports: ['react'] }],
      conversationHistory: [{ role: 'user', content: 'hi' }],
      relevantMemory: [{ content: 'mem', score: 0.9, source: 'agent' }],
    });
    // Budget = 100 tokens. Selection alone is 2500+. Everything else should
    // be dropped, and the bundle is dispatched OVER budget (used > max).
    const result = applyBudget(bundle, 100);

    // Selection is preserved
    expect(result.bundle.selection).not.toBeNull();
    expect(result.bundle.selection?.text).toBe('x'.repeat(10000));
    // OpenFile is preserved
    expect(result.bundle.openFiles.length).toBe(1);
    expect(result.bundle.openFiles[0].content).toBe('x'.repeat(5000));
    // Everything else is dropped
    expect(result.bundle.projectGraph).toEqual([]);
    expect(result.bundle.conversationHistory).toEqual([]);
    expect(result.bundle.relevantMemory).toEqual([]);
    // truncated list records everything that was dropped + the hard-floor notice
    expect(result.tokenBudget.truncated.length).toBeGreaterThanOrEqual(4);
    expect(result.tokenBudget.truncated.some(t => t.includes('projectGraph'))).toBe(true);
    expect(result.tokenBudget.truncated.some(t => t.startsWith('history:'))).toBe(true);
    expect(result.tokenBudget.truncated.some(t => t.startsWith('memory:'))).toBe(true);
    expect(result.tokenBudget.truncated.some(t => t.includes('HARD FLOOR'))).toBe(true);
    // used > max (over-budget dispatch — the honest behavior)
    expect(result.tokenBudget.used).toBeGreaterThan(result.tokenBudget.max);
  });

  it('CRITICAL — applyBudget: NEVER truncates openFiles, even when bundle is over budget', () => {
    // Multiple large open files
    const hugeFiles: OpenFile[] = Array.from({ length: 5 }, (_, i) => ({
      path: `file${i}.ts`,
      language: 'typescript',
      content: 'y'.repeat(4000), // 4K chars = 1000 tokens each
    }));
    const bundle = makeBundle({
      openFiles: hugeFiles,
      selection: null,
      projectGraph: [{ file: 'dep.ts', imports: ['react'] }],
    });
    // Budget = 1000 tokens. 5 files * 1000 tokens = 5000. projectGraph should
    // be dropped, files preserved, dispatched over budget.
    const result = applyBudget(bundle, 1000);

    expect(result.bundle.openFiles.length).toBe(5); // ALL preserved
    expect(result.bundle.projectGraph).toEqual([]);
    expect(result.tokenBudget.truncated.some(t => t.includes('projectGraph'))).toBe(true);
    expect(result.tokenBudget.used).toBeGreaterThan(result.tokenBudget.max);
  });

  it('applyBudget: exact-budget bundle (used == max) is NOT truncated', () => {
    // Craft a bundle that lands exactly on the budget line.
    // Per-turn token count = content tokens + role tokens + header overhead
    //   = ceil(100/4) + ceil(4/4) + 8 = 25 + 1 + 8 = 34
    const turnContent = 'a'.repeat(100); // 25 tokens
    const bundle = makeBundle({
      conversationHistory: [{ role: 'user', content: turnContent }], // 34 tokens total
    });
    // Budget = 34 exactly
    const result = applyBudget(bundle, 34);
    expect(result.tokenBudget.used).toBe(34);
    expect(result.tokenBudget.truncated).toEqual([]);
    expect(result.bundle.conversationHistory.length).toBe(1);
  });

  it('applyBudget: 1-token-over-budget triggers exactly one truncation', () => {
    // Per-turn = 34 tokens (see previous test for breakdown).
    const turnContent = 'a'.repeat(100);
    const bundle = makeBundle({
      conversationHistory: [
        { role: 'user', content: turnContent },      // 34
        { role: 'assistant', content: turnContent }, // 34
      ],
    });
    // Total = 68. Budget = 67. Should drop 1 turn (the oldest).
    const result = applyBudget(bundle, 67);
    expect(result.bundle.conversationHistory.length).toBe(1);
    expect(result.tokenBudget.truncated.length).toBe(1);
    expect(result.tokenBudget.truncated[0]).toContain('history:');
    // The kept turn is the most recent (the assistant one)
    expect(result.bundle.conversationHistory[0].role).toBe('assistant');
  });
});
