// tests/unit/context/manager.test.ts
//
// Phase B Step 3 — Unit tests for ContextManager.assemble().
//
// Per directive Section 5 Step 3: "Verify: assemble() returns real memory
// results for a known seeded memory row"
//
// We seed MemoryEngine with a known entry, then call assemble() and verify
// the relevantMemory field contains it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contextManager } from '../../../src/context/manager.js';
import { memoryEngine } from '../../../src/memory/engine.js';
import type { AgentTask } from '../../../src/types.js';

// Helper: build a minimal AgentTask for testing
function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'test-task-' + Math.random().toString(36).slice(2),
    projectId: '00000000-0000-0000-0000-000000000000', // default project
    sessionId: 'test-session',
    agentId: 'architect-agent',
    type: 'chat',
    description: 'How do I implement a red-black tree?',
    context: {
      projectId: '00000000-0000-0000-0000-000000000000',
      rootPath: '/tmp/nonexistent-project-root', // overridden per-test
      techStack: {},
      activeFiles: [],
    },
    priority: 'normal',
    executionMode: 'single-shot',
    origin: 'api',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('Phase B — ContextManager.assemble() memory + history wiring', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cs-mgr-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('assemble: returns a ContextBundle with all 5 source fields present', async () => {
    const task = makeTask({
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: [],
        recentMessages: [],
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: '', // triggers 32K fallback
    });

    // All 5 fields are present (even if empty)
    expect(bundle).toHaveProperty('openFiles');
    expect(bundle).toHaveProperty('selection');
    expect(bundle).toHaveProperty('projectGraph');
    expect(bundle).toHaveProperty('conversationHistory');
    expect(bundle).toHaveProperty('relevantMemory');
    expect(bundle).toHaveProperty('tokenBudget');

    // tokenBudget has all sub-fields
    expect(bundle.tokenBudget).toHaveProperty('max');
    expect(bundle.tokenBudget).toHaveProperty('used');
    expect(bundle.tokenBudget).toHaveProperty('truncated');
  });

  it('assemble: empty task → bundle with empty sources, used=0, no truncation', async () => {
    const task = makeTask({
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: [],
        recentMessages: [],
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: '',
    });

    expect(bundle.openFiles).toEqual([]);
    expect(bundle.selection).toBeNull();
    expect(bundle.projectGraph).toEqual([]);
    expect(bundle.conversationHistory).toEqual([]);
    expect(bundle.relevantMemory).toEqual([]);
    expect(bundle.tokenBudget.used).toBe(0);
    expect(bundle.tokenBudget.truncated).toEqual([]);
    // 32K fallback * 0.75 = 24K
    expect(bundle.tokenBudget.max).toBe(24_000);
  });

  // ── THE BIG ONE: real memory seeded → real memory returned ────────

  it('CRITICAL — assemble: seeded memory is returned in relevantMemory', async () => {
    // Seed MemoryEngine with a known entry that's semantically related
    // to the task description. The MemoryEngine uses pseudo-embeddings in
    // test mode (no Ollama/OpenAI), which are hash-based — so we need to
    // use the SAME text in both the seed and the query to get a high score.
    const memoryContent = 'red-black tree insertion involves rotating nodes to maintain balance';
    await memoryEngine.memorize(
      memoryContent,
      { sourceType: 'agent', sourceRef: 'architect-agent', tags: ['data-structures'] },
      'architect-agent',
      { userId: 'test-user', projectId: '00000000-0000-0000-0000-000000000000' },
    );

    const task = makeTask({
      description: memoryContent, // query EXACTLY matches the seeded memory
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: [],
        recentMessages: [],
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: '',
    });

    // The seeded memory should appear in relevantMemory
    expect(bundle.relevantMemory.length).toBeGreaterThanOrEqual(1);
    const found = bundle.relevantMemory.find(m => m.content === memoryContent);
    expect(found).toBeDefined();
    expect(found!.source).toBe('agent'); // mapped from metadata.sourceType
    expect(found!.score).toBeGreaterThan(0);
    expect(found!.score).toBeLessThanOrEqual(1);
  });

  it('assemble: conversation history is sourced from recentMessages (last N)', async () => {
    const recentMessages = [
      'Hello, can you help me?',
      'Sure, what do you need?',
      'I need to implement a red-black tree.',
      'Let me think about that.',
      'OK here is my approach.',
      'That looks good.',
      'Now let me write the code.',
      'I see an issue with the rotation logic.',
      'Let me fix that.',
      'The fix is to check the uncle color first.',
      'That worked!',
      'Thanks for the help.',
    ];

    const task = makeTask({
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: [],
        recentMessages,
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: '',
    });

    // DEFAULT_HISTORY_TURNS is 10, so we should get the last 10 messages
    expect(bundle.conversationHistory.length).toBe(10);
    // All turns have role='user' (limitation documented in manager.ts)
    expect(bundle.conversationHistory.every(t => t.role === 'user')).toBe(true);
    // The FIRST kept turn is the 3rd message (index 2) — last 10 of 12
    expect(bundle.conversationHistory[0].content).toBe('I need to implement a red-black tree.');
    // The LAST kept turn is the 12th message
    expect(bundle.conversationHistory[9].content).toBe('Thanks for the help.');
  });

  it('assemble: open files are loaded from disk with content + language', async () => {
    // Create a fake project with 2 open files
    mkdirSync(join(tmpRoot, 'src'), { recursive: true });
    writeFileSync(join(tmpRoot, 'src', 'foo.ts'), `export const foo = 42;\n`);
    writeFileSync(join(tmpRoot, 'src', 'bar.json'), `{"name": "bar"}\n`);

    const task = makeTask({
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: ['src/foo.ts', 'src/bar.json'],
        recentMessages: [],
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: '',
    });

    expect(bundle.openFiles.length).toBe(2);
    const fooFile = bundle.openFiles.find(f => f.path === 'src/foo.ts');
    expect(fooFile).toBeDefined();
    expect(fooFile!.language).toBe('typescript');
    expect(fooFile!.content).toBe('export const foo = 42;\n');

    const barFile = bundle.openFiles.find(f => f.path === 'src/bar.json');
    expect(barFile).toBeDefined();
    expect(barFile!.language).toBe('json');
    expect(barFile!.content).toBe('{"name": "bar"}\n');
  });

  it('assemble: project graph is built from open files (directive Step 4 verify)', async () => {
    // Create file A that imports file B
    mkdirSync(join(tmpRoot, 'src'), { recursive: true });
    writeFileSync(join(tmpRoot, 'src', 'A.ts'), `import { foo } from './B';\nimport React from 'react';\n`);
    writeFileSync(join(tmpRoot, 'src', 'B.ts'), `export const foo = () => 42;\n`);

    const task = makeTask({
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: ['src/A.ts', 'src/B.ts'],
        recentMessages: [],
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: '',
    });

    // Project graph has one node per open file
    expect(bundle.projectGraph.length).toBe(2);
    const nodeA = bundle.projectGraph.find(n => n.file === 'src/A.ts');
    expect(nodeA).toBeDefined();
    expect(nodeA!.imports).toContain(join('src', 'B.ts'));
    expect(nodeA!.imports).toContain('react');

    const nodeB = bundle.projectGraph.find(n => n.file === 'src/B.ts');
    expect(nodeB).toBeDefined();
    expect(nodeB!.imports).toEqual([]);
  });

  it('assemble: nonexistent open file is skipped (not fatal)', async () => {
    const task = makeTask({
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: ['src/nonexistent.ts'], // doesn't exist
        recentMessages: [],
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: '',
    });

    // File is skipped — openFiles is empty, not an error
    expect(bundle.openFiles).toEqual([]);
    // projectGraph still has an entry for the file (with empty imports)
    expect(bundle.projectGraph.length).toBe(1);
    expect(bundle.projectGraph[0].file).toBe('src/nonexistent.ts');
    expect(bundle.projectGraph[0].imports).toEqual([]);
  });

  it('assemble: budget is enforced — large bundle triggers truncation', async () => {
    // Create a huge open file + many recent messages to force over-budget.
    // Budget = 32K fallback * 0.75 = 24K tokens.
    // Open file content: 100K chars = 25K tokens ALONE (already exceeds budget).
    // This forces the budget module to drop conversation history entirely.
    mkdirSync(join(tmpRoot, 'src'), { recursive: true });
    const hugeContent = 'x'.repeat(100_000); // 100K chars = ~25K tokens
    writeFileSync(join(tmpRoot, 'src', 'huge.ts'), hugeContent);

    const manyMessages = Array.from({ length: 50 }, (_, i) => `Message ${i}: ${'y'.repeat(200)}`);

    const task = makeTask({
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: ['src/huge.ts'],
        recentMessages: manyMessages,
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: '', // 32K fallback → 24K budget
    });

    // Open file is preserved (highest priority — never truncated)
    expect(bundle.openFiles.length).toBe(1);
    expect(bundle.openFiles[0].content).toBe(hugeContent);

    // Conversation history is dropped entirely (the open file alone exceeds
    // the 24K budget — budget module drops ALL lower-priority sources and
    // dispatches over-budget rather than dropping the open file).
    expect(bundle.conversationHistory.length).toBe(0);

    // Truncation list records what was dropped
    expect(bundle.tokenBudget.truncated.length).toBeGreaterThan(0);
    expect(bundle.tokenBudget.truncated.some(t => t.startsWith('history:'))).toBe(true);

    // used > max (over-budget dispatch — the honest behavior)
    expect(bundle.tokenBudget.used).toBeGreaterThan(bundle.tokenBudget.max);
  });

  it('assemble: modelId "anthropic/claude-3.5-sonnet" → budget is 150K (200K * 0.75)', async () => {
    const task = makeTask({
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: [],
        recentMessages: [],
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: 'anthropic/claude-3.5-sonnet',
    });

    expect(bundle.tokenBudget.max).toBe(150_000);
  });

  it('assemble: memory search failure is non-fatal (returns empty memory, bundle still assembled)', async () => {
    // Mock memoryEngine.search to throw
    const searchSpy = vi.spyOn(memoryEngine, 'search').mockRejectedValue(new Error('simulated DB failure'));

    const task = makeTask({
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: tmpRoot,
        techStack: {},
        activeFiles: [],
        recentMessages: [],
      },
    });

    const bundle = await contextManager.assemble({
      userId: 'test-user',
      agentId: 'architect-agent',
      task,
      modelId: '',
    });

    // Memory is empty but the rest of the bundle is still assembled
    expect(bundle.relevantMemory).toEqual([]);
    expect(bundle).toHaveProperty('openFiles'); // other fields still present
    expect(bundle).toHaveProperty('tokenBudget');

    searchSpy.mockRestore();
  });
});
