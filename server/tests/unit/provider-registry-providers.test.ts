// server/tests/unit/provider-registry-providers.test.ts
//
// Tests the per-category provider seed files extracted from registry.ts.
//
// Each file under server/src/provider-registry/providers/ exports a
// seed<Category>Providers() function that returns ProviderRegistryEntry[].
// This test verifies:
//   1. Each file exports the expected number of entries
//   2. Every entry has a unique id within its category
//   3. Every entry's category matches the file's category
//   4. The total across all 5 files matches the registry's listProviders()

import { describe, it, expect } from 'vitest';
import { seedLlmProviders } from '../../src/provider-registry/providers/llm.js';
import { seedTtsProviders } from '../../src/provider-registry/providers/tts.js';
import { seedToolProviders } from '../../src/provider-registry/providers/tool.js';
import { seedImageVideoProviders } from '../../src/provider-registry/providers/image-video.js';
import { seedInformationProviders } from '../../src/provider-registry/providers/information.js';
import { listProviders } from '../../src/provider-registry/registry.js';

describe('provider-registry/providers (per-category seed files)', () => {
  const cases = [
    { name: 'llm', fn: seedLlmProviders, expected: 16, category: 'llm' as const },
    { name: 'tts', fn: seedTtsProviders, expected: 11, category: 'tts' as const },
    { name: 'tool', fn: seedToolProviders, expected: 4, category: 'tool' as const },
    { name: 'image-video', fn: seedImageVideoProviders, expected: 5, category: 'image-video' as const },
    { name: 'information', fn: seedInformationProviders, expected: 3, category: 'information' as const },
  ];

  for (const { name, fn, expected, category } of cases) {
    it(`${name}.ts exports ${expected} entries with category='${category}' and unique IDs`, () => {
      const entries = fn();
      expect(entries.length).toBe(expected);

      // Every entry's category matches
      for (const e of entries) {
        expect(e.category).toBe(category);
      }

      // IDs are unique within the category
      const ids = entries.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);

      // Every entry has the required fields (not undefined)
      for (const e of entries) {
        expect(e.id).toBeTruthy();
        expect(e.displayName).toBeTruthy();
        expect(e.defaultApiUrl).toBeDefined();
        expect(e.apiKey).toBeDefined();
        expect(Array.isArray(e.models)).toBe(true);
      }
    });
  }

  it('all 5 files together produce the same count as registry.listProviders()', () => {
    const all = [
      ...seedLlmProviders(),
      ...seedTtsProviders(),
      ...seedToolProviders(),
      ...seedImageVideoProviders(),
      ...seedInformationProviders(),
    ];
    // listProviders() returns the seeded entries (plus any runtime additions,
    // but in a fresh test process there are none).
    const registry = listProviders();
    expect(all.length).toBe(registry.length);

    // Every seed entry should appear in the registry by ID
    const registryIds = new Set(registry.map((p) => p.id));
    for (const e of all) {
      expect(registryIds.has(e.id)).toBe(true);
    }
  });
});
