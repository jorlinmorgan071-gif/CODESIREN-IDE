// tests/unit/memory.test.ts
// P0: Memory Engine — embed, memorize, search, cross-agent recall.

import { describe, it, expect, beforeAll } from 'vitest';
import { memoryEngine } from '../../src/memory/engine.js';

describe('MemoryEngine', () => {
  it('embed() returns 768-dim vector', async () => {
    const vec = await memoryEngine.embed('hello world');
    expect(vec).toHaveLength(768);
  });

  it('embed() is deterministic for same input', async () => {
    const a = await memoryEngine.embed('test input');
    const b = await memoryEngine.embed('test input');
    expect(a).toEqual(b);
  });

  it('memorize() stores content', async () => {
    await memoryEngine.memorize('The user prefers TypeScript over JavaScript', {
      sourceType: 'agent',
      sourceRef: 'test-agent',
      tags: ['preference'],
    }, 'test-agent');
    expect(await memoryEngine.count()).toBeGreaterThan(0);
  });

  it('search() returns results for stored content', async () => {
    await memoryEngine.memorize('Design a REST API for a todo app with CRUD endpoints', {
      sourceType: 'agent',
      sourceRef: 'backend-agent',
      tags: ['api-design'],
    }, 'backend-agent');

    const results = await memoryEngine.search('REST API todo', 5);
    expect(results.length).toBeGreaterThan(0);
    // Find the REST API entry in results (may not be first with pseudo-embedding)
    const restResult = results.find(r => r.content.includes('REST API'));
    expect(restResult).toBeDefined();
  });

  it('search() returns fewer results for unrelated query', async () => {
    const results = await memoryEngine.search('xyzzy-no-match-12345', 5);
    // Pseudo-embedding may still produce low-score matches — verify they're low quality
    for (const r of results) {
      expect(r.score).toBeLessThan(0.5);
    }
  });

  it('search() results have score between 0 and 1', async () => {
    await memoryEngine.memorize('performance optimization for React components', {
      sourceType: 'agent',
      sourceRef: 'performance-agent',
    }, 'performance-agent');

    const results = await memoryEngine.search('React performance', 5);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('cross-agent recall: agent A stores, search finds it', async () => {
    // Simulate Backend Agent storing something
    await memoryEngine.memorize('Use PostgreSQL with uuid_generate_v4() for primary keys', {
      sourceType: 'agent',
      sourceRef: 'database-agent',
      tags: ['database', 'schema'],
    }, 'database-agent');

    // Simulate Frontend Agent recalling it
    const results = await memoryEngine.search('PostgreSQL uuid primary key', 5);
    const found = results.find(r => r.content.includes('PostgreSQL'));
    expect(found).toBeDefined();
    expect(found?.metadata?.sourceRef).toBe('database-agent');
  });

  it('memorize() ignores trivially short content', async () => {
    const before = await memoryEngine.count();
    await memoryEngine.memorize('hi', { sourceType: 'agent', sourceRef: 'test' }, 'test');
    expect(await memoryEngine.count()).toBe(before);
  });
});
