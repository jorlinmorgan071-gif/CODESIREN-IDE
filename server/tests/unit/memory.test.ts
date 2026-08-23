// tests/unit/memory.test.ts
// P0: Memory Engine — embed, memorize, search, cross-agent recall.

import { describe, it, expect, beforeAll } from 'vitest';
import { memoryEngine } from '../../src/memory/engine.js';

const SCOPE_A = { userId: 'memory-user-a', projectId: 'memory-project-a', sessionId: '6d88076f-096e-4d8f-9b42-bf1d493bcf11' };
const SCOPE_A_OTHER_SESSION = { ...SCOPE_A, sessionId: '3d534d3a-e7fa-4e1c-9a1b-09bfc1fc92b4' };
const SCOPE_B = { userId: 'memory-user-b', projectId: 'memory-project-b', sessionId: '2a4a4aa8-8262-4d92-81ba-3d33141e88f1' };

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
    }, 'test-agent', SCOPE_A);
    expect(await memoryEngine.count(SCOPE_A)).toBeGreaterThan(0);
  });

  it('search() returns results for stored content', async () => {
    await memoryEngine.memorize('Design a REST API for a todo app with CRUD endpoints', {
      sourceType: 'agent',
      sourceRef: 'backend-agent',
      tags: ['api-design'],
    }, 'backend-agent', SCOPE_A);

    const results = await memoryEngine.search('REST API todo', 5, SCOPE_A);
    expect(results.length).toBeGreaterThan(0);
    // Find the REST API entry in results (may not be first with pseudo-embedding)
    const restResult = results.find(r => r.content.includes('REST API'));
    expect(restResult).toBeDefined();
    expect(restResult?.quality).toBe('degraded');
    expect(restResult?.provenance).toMatchObject({
      organizationPolicy: 'single-owner', userId: SCOPE_A.userId, projectId: SCOPE_A.projectId,
      sessionId: SCOPE_A.sessionId, policy: 'exact-session', storage: 'ephemeral',
    });
  });

  it('search() returns fewer results for unrelated query', async () => {
    const results = await memoryEngine.search('xyzzy-no-match-12345', 5, SCOPE_A);
    // Pseudo-embedding may still produce low-score matches — verify they're low quality
    for (const r of results) {
      expect(r.score).toBeLessThan(0.5);
    }
  });

  it('search() results have score between 0 and 1', async () => {
    await memoryEngine.memorize('performance optimization for React components', {
      sourceType: 'agent',
      sourceRef: 'performance-agent',
    }, 'performance-agent', SCOPE_A);

    const results = await memoryEngine.search('React performance', 5, SCOPE_A);
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
    }, 'database-agent', SCOPE_A);

    // Simulate Frontend Agent recalling it
    const results = await memoryEngine.search('PostgreSQL uuid primary key', 5, SCOPE_A);
    const found = results.find(r => r.content.includes('PostgreSQL'));
    expect(found).toBeDefined();
    expect(found?.metadata?.sourceRef).toBe('database-agent');
  });

  it('memorize() ignores trivially short content', async () => {
    const before = await memoryEngine.count(SCOPE_A);
    await memoryEngine.memorize('hi', { sourceType: 'agent', sourceRef: 'test' }, 'test', SCOPE_A);
    expect(await memoryEngine.count(SCOPE_A)).toBe(before);
  });

  it('never recalls a different user or project memory', async () => {
    const secret = 'P0 tenant-only architectural secret';
    await memoryEngine.memorize(secret, { sourceType: 'agent', sourceRef: 'security-agent' }, 'security-agent', SCOPE_A);
    const foreignResults = await memoryEngine.search(secret, 10, SCOPE_B);
    expect(foreignResults.some(result => result.content === secret)).toBe(false);
  });

  it('never recalls a memory from a different session in the same project', async () => {
    const secret = 'P1 exact-session memory boundary secret';
    await memoryEngine.memorize(secret, { sourceType: 'agent', sourceRef: 'security-agent' }, 'security-agent', SCOPE_A);
    const results = await memoryEngine.search(secret, 10, SCOPE_A_OTHER_SESSION);
    expect(results.some(result => result.content === secret)).toBe(false);
  });

  it('does not reveal or delete a memory entry across tenant scopes', async () => {
    const content = 'P0 direct lookup and delete isolation record';
    await memoryEngine.memorize(content, { sourceType: 'agent', sourceRef: 'security-agent' }, 'security-agent', SCOPE_A);
    const entry = (await memoryEngine.list(100, 0, SCOPE_A)).find(item => item.content === content);
    expect(entry).toBeDefined();
    expect(await memoryEngine.get(entry!.id, SCOPE_B)).toBeNull();
    expect(await memoryEngine.delete(entry!.id, SCOPE_B)).toBe(false);
    expect(await memoryEngine.get(entry!.id, SCOPE_A)).not.toBeNull();
  });
});
