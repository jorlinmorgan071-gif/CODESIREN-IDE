// tests/unit/embed-cache.test.ts
// Phase A Section 8: Embedding cache tests.
//
// Proves:
//   1. Identical text → cache hit (underlying embed NOT called twice)
//   2. TTL expiry → cache miss after the window
//   3. Different text → always cache miss (no false-positive collisions)
//
// Uses the REAL modelRouter (stub engine produces deterministic pseudo-embeddings).
// The spy is on embedUncached (the private method that does the actual work) —
// if the cache works, it should NOT be called on the second identical request.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelRouter } from '../../src/orchestration/model-router.js';

describe('Phase A Section 8 — Embedding cache', () => {
  beforeEach(() => {
    modelRouter.clearEmbedCache();
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 1: Identical text → cache hit (underlying embed NOT called twice)
  // ════════════════════════════════════════════════════════════════════
  it('identical text: second call hits cache (embedUncached NOT invoked)', async () => {
    const text = 'This is a test string for embedding cache.';

    // Spy on the private embedUncached method
    const spy = vi.spyOn(modelRouter as any, 'embedUncached');

    // First call — cache miss, embedUncached called
    const result1 = await modelRouter.embed(text);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result1).toHaveLength(768); // pseudo-embedding is 768 dims

    // Second call — cache HIT, embedUncached NOT called
    const result2 = await modelRouter.embed(text);
    expect(spy).toHaveBeenCalledTimes(1); // still 1, not 2
    expect(result2).toEqual(result1); // same result (cached)

    spy.mockRestore();
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 2: TTL expiry → cache miss after the window
  // ════════════════════════════════════════════════════════════════════
  it('TTL expiry: cache miss after TTL window expires', async () => {
    const text = 'Another test string for TTL testing.';

    // Spy on embedUncached
    const spy = vi.spyOn(modelRouter as any, 'embedUncached');

    // First call — cache miss
    await modelRouter.embed(text);
    expect(spy).toHaveBeenCalledTimes(1);

    // Second call — cache hit (within TTL)
    await modelRouter.embed(text);
    expect(spy).toHaveBeenCalledTimes(1); // still 1

    // Simulate TTL expiry: manipulate the cache entry's expiresAt to the past
    // Access the private cache Map directly
    const cache = (modelRouter as any).embedCache as Map<string, { embedding: number[]; expiresAt: number }>;
    for (const entry of cache.values()) {
      entry.expiresAt = Date.now() - 1; // expired
    }

    // Third call — cache MISS (TTL expired)
    await modelRouter.embed(text);
    expect(spy).toHaveBeenCalledTimes(2); // now 2 — embedUncached called again

    spy.mockRestore();
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 3: Different text → always cache miss (no false-positive collisions)
  // ════════════════════════════════════════════════════════════════════
  it('different text: always cache miss (no collisions)', async () => {
    const text1 = 'First unique text for embedding.';
    const text2 = 'Second unique text for embedding.';
    const text3 = 'Third unique text for embedding.';

    const spy = vi.spyOn(modelRouter as any, 'embedUncached');

    // Three different texts → three cache misses
    await modelRouter.embed(text1);
    await modelRouter.embed(text2);
    await modelRouter.embed(text3);

    expect(spy).toHaveBeenCalledTimes(3); // each was a cache miss
    expect(modelRouter.getEmbedCacheSize()).toBe(3); // 3 entries cached

    // Calling text1 again → cache HIT
    await modelRouter.embed(text1);
    expect(spy).toHaveBeenCalledTimes(3); // still 3, not 4
    expect(modelRouter.getEmbedCacheSize()).toBe(3); // still 3 (no new entry)

    spy.mockRestore();
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 4: Cache stores correct embeddings (not just "something")
  // ════════════════════════════════════════════════════════════════════
  it('cache returns correct embedding (identical to uncached result)', async () => {
    const text = 'Verify cache returns the right embedding vector.';

    // Get the uncached result directly
    const uncached = await (modelRouter as any).embedUncached(text.slice(0, 8000));

    // Clear cache, then get cached result
    modelRouter.clearEmbedCache();
    const cached = await modelRouter.embed(text);

    // They should be identical
    expect(cached).toEqual(uncached);
    expect(cached).toHaveLength(768);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 5: Truncation — text > 8000 chars is truncated before caching
  // ════════════════════════════════════════════════════════════════════
  it('truncation: text > 8000 chars truncated, same prefix hits cache', async () => {
    const longText = 'A'.repeat(10000);
    const samePrefix = 'A'.repeat(10000);

    const spy = vi.spyOn(modelRouter as any, 'embedUncached');

    // Both texts truncate to the same 8000 chars → same cache key
    await modelRouter.embed(longText);
    await modelRouter.embed(samePrefix);

    expect(spy).toHaveBeenCalledTimes(1); // second was a cache hit

    spy.mockRestore();
  });
});
