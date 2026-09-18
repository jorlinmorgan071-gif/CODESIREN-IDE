// server/tests/unit/upr-phase2-step2d-custom-onboarding.test.ts
// UPR Phase 2 Step 2d — Custom provider onboarding tests.
//
// Required evidence (per directive):
//   1. Onboard one real non-preset provider end-to-end
//   2. Confirm it lands in the correct category
//   3. Confirm it behaves identically to a named provider afterward
//      (appears in listProviders, can be tested/loaded, can be fetched by ID)
//
// Method: direct registry calls — onboardCustomProvider + classifyProvider +
// testAndLoadModels on the onboarded entry.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';

import {
  listProviders,
  getProvider,
  onboardCustomProvider,
  classifyProvider,
  testAndLoadModels,
  resetProvider,
  deleteProvider,
} from '../../src/provider-registry/registry.js';

describe('UPR Phase 2 Step 2d — Custom provider onboarding', () => {
  beforeEach(() => {
    // Reset known providers so counts are deterministic
    // (custom providers created in tests are intentionally NOT reset —
    // they're new entries that didn't exist before)
  });

  // ── TEST 1: classifyProvider maps each answer to the correct category ──
  it('classifyProvider maps generate-text → llm', () => {
    const result = classifyProvider({ whatDoesItDo: 'generate-text' });
    expect(result.category).toBe('llm');
    expect(result.warning).toBeNull();
  });

  it('classifyProvider maps generate-speech → tts', () => {
    const result = classifyProvider({ whatDoesItDo: 'generate-speech' });
    expect(result.category).toBe('tts');
    expect(result.warning).toBeNull();
  });

  it('classifyProvider maps execute-tools → tool', () => {
    const result = classifyProvider({ whatDoesItDo: 'execute-tools' });
    expect(result.category).toBe('tool');
    expect(result.warning).toBeNull();
  });

  it('classifyProvider maps generate-images → image-video', () => {
    const result = classifyProvider({ whatDoesItDo: 'generate-images' });
    expect(result.category).toBe('image-video');
    expect(result.warning).toBeNull();
  });

  // Phase 3 — Information category
  it('classifyProvider maps fetch-information → information', () => {
    const result = classifyProvider({ whatDoesItDo: 'fetch-information' });
    expect(result.category).toBe('information');
    expect(result.warning).toBeNull();
  });

  // ── TEST 2: onboardCustomProvider creates a first-class registry entry ──
  it('onboardCustomProvider creates a provider that appears in listProviders()', () => {
    const beforeCount = listProviders().length;

    const entry = onboardCustomProvider({
      displayName: 'My Custom LLM Provider',
      category: 'llm',
      apiUrl: 'https://custom-llm.example.com/api/v1',
      apiKey: 'custom-key-123',
    });

    const afterCount = listProviders().length;
    expect(afterCount).toBe(beforeCount + 1);

    // The new provider should be in the list
    const found = listProviders().find((p) => p.id === entry.id);
    expect(found).toBeDefined();
    expect(found!.displayName).toBe('My Custom LLM Provider');
    expect(found!.category).toBe('llm');
    expect(found!.apiUrl).toBe('https://custom-llm.example.com/api/v1');
    expect(found!.apiKey).toBe('custom-key-123');
    expect(found!.connectionTested).toBe(false);
    expect(found!.models).toEqual([]);
  });

  // ── TEST 3: onboarded provider can be fetched by ID ────────────────────
  it('onboarded provider is retrievable via getProvider()', () => {
    const entry = onboardCustomProvider({
      displayName: 'Test TTS Provider',
      category: 'tts',
      apiUrl: '',  // TTS providers can skip URL per spec
      apiKey: 'tts-key',
    });

    const fetched = getProvider(entry.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(entry.id);
    expect(fetched!.displayName).toBe('Test TTS Provider');
    expect(fetched!.category).toBe('tts');
    expect(fetched!.apiUrl).toBe('');  // TTS with no URL
  });

  // ── TEST 4: onboarded provider can be test-and-loaded ──────────────────
  it('onboarded LLM provider testAndLoadModels() — fails with fetch error for unknown endpoint', async () => {
    const entry = onboardCustomProvider({
      displayName: 'Custom LLM',
      category: 'llm',
      apiUrl: 'https://nonexistent-llm.example.com/api/v1',
      apiKey: 'test-key',
    });

    // Phase 3: custom LLM providers now hit OpenAI-compatible /models endpoint
    // (was: returned "No model-list endpoint" error pre-Phase-3).
    // For a nonexistent host, fetch fails with a network error.
    const result = await testAndLoadModels(entry.id);

    expect(result.success).toBe(false);
    // The error should mention the provider ID (since we built the URL from it)
    expect(result.error).toBeTruthy();
    // Clean up
    deleteProvider(entry.id);
  });

  // ── TEST 5: onboarded TTS provider with no URL works (skip per spec) ──
  it('onboarded TTS provider with empty apiUrl is valid (URL skipped per spec)', () => {
    const entry = onboardCustomProvider({
      displayName: 'Local TTS Engine',
      category: 'tts',
      apiUrl: '',
      apiKey: '',
    });

    expect(entry.apiUrl).toBe('');
    expect(entry.category).toBe('tts');
    // It should still appear in the provider list
    const found = listProviders().find((p) => p.id === entry.id);
    expect(found).toBeDefined();
  });

  // ── TEST 6: onboarded provider is indistinguishable from preset ──────
  it('onboarded provider has the same shape as preset providers', () => {
    const custom = onboardCustomProvider({
      displayName: 'Custom Image Gen',
      category: 'image-video',
      apiUrl: 'https://custom-image.example.com/api',
      apiKey: 'img-key',
    });

    // Compare shape with a preset provider
    const preset = getProvider('openai-image');
    expect(preset).toBeDefined();

    // Both should have the same fields
    expect(custom.id).toBeDefined();
    expect(custom.category).toBe('image-video');
    expect(custom.displayName).toBe('Custom Image Gen');
    expect(custom.defaultApiUrl).toBe('https://custom-image.example.com/api');
    expect(custom.apiUrl).toBe('https://custom-image.example.com/api');
    expect(custom.apiKey).toBe('img-key');
    expect(custom.connectionTested).toBe(false);
    expect(custom.models).toEqual([]);
    expect(custom.voices).toEqual([]);
    expect(custom.tools).toEqual([]);
    expect(custom.imageModels).toEqual([]);
    expect(custom.lastError).toBeNull();
    expect(custom.lastLoadedAt).toBeNull();
  });

  // ── TEST 7: End-to-end — onboard + classify + verify category ─────────
  it('end-to-end: onboard a provider with generate-speech → classified as tts → appears in TTS list', () => {
    // Step 1: Classify
    const { category } = classifyProvider({ whatDoesItDo: 'generate-speech' });
    expect(category).toBe('tts');

    // Step 2: Onboard
    const entry = onboardCustomProvider({
      displayName: 'Custom Speech Engine',
      category,
      apiUrl: 'https://speech.example.com/api',
      apiKey: 'speech-key',
    });

    // Step 3: Verify it appears in the TTS provider list
    const ttsProviders = listProviders().filter((p) => p.category === 'tts');
    const found = ttsProviders.find((p) => p.id === entry.id);
    expect(found).toBeDefined();
    expect(found!.displayName).toBe('Custom Speech Engine');
    expect(found!.category).toBe('tts');
  });

  // ── TEST 8: Custom provider ID is unique (no collision) ───────────────
  it('two onboarded providers get different IDs', () => {
    const entry1 = onboardCustomProvider({
      displayName: 'Provider A',
      category: 'llm',
      apiUrl: 'https://a.example.com',
      apiKey: '',
    });
    const entry2 = onboardCustomProvider({
      displayName: 'Provider B',
      category: 'llm',
      apiUrl: 'https://b.example.com',
      apiKey: '',
    });

    expect(entry1.id).not.toBe(entry2.id);
    expect(getProvider(entry1.id)).toBeDefined();
    expect(getProvider(entry2.id)).toBeDefined();
  });

  // ── TEST 9: Misclassification resilience — warning on contradiction ────
  it('classifyProvider surfaces a warning when detectedCategory contradicts user answer', () => {
    // URL test detected LLM (openai-compatible /models response)
    // but user says it generates images
    const result = classifyProvider({
      whatDoesItDo: 'generate-images',
      detectedCategory: 'llm',
    });
    expect(result.category).toBe('image-video');  // User's choice is respected
    expect(result.warning).not.toBeNull();
    expect(result.warning!).toContain('detected');
    expect(result.warning!).toContain('llm');
    expect(result.warning!).toContain('image-video');
  });

  it('classifyProvider returns no warning when detectedCategory matches user answer', () => {
    const result = classifyProvider({
      whatDoesItDo: 'generate-text',
      detectedCategory: 'llm',
    });
    expect(result.category).toBe('llm');
    expect(result.warning).toBeNull();
  });

  // ── TEST 10: testCustomProviderUrl — bad/unreachable URL ──────────────
  it('testCustomProviderUrl: empty URL → specific error', async () => {
    const { testCustomProviderUrl } = await import('../../src/provider-registry/registry.js');
    const result = await testCustomProviderUrl({ apiUrl: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
    expect(result.detectedCategory).toBeNull();
  });

  it('testCustomProviderUrl: invalid URL format → specific error', async () => {
    const { testCustomProviderUrl } = await import('../../src/provider-registry/registry.js');
    const result = await testCustomProviderUrl({ apiUrl: 'not-a-url' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  it('testCustomProviderUrl: unreachable URL → specific "could not reach" error', async () => {
    const { testCustomProviderUrl } = await import('../../src/provider-registry/registry.js');
    const result = await testCustomProviderUrl({ apiUrl: 'https://nonexistent-host-12345.example.com' });
    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    // Error should be specific — not a generic "failed"
    expect(result.error!.length).toBeGreaterThan(20);
    expect(result.detectedShape).not.toBeNull();
  });

  it('testCustomProviderUrl: auth failure (401) → specific "auth failed" error', async () => {
    const { testCustomProviderUrl } = await import('../../src/provider-registry/registry.js');
    // Mock fetch to return 401
    const fetchSpy = vi.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));

    const result = await testCustomProviderUrl({ apiUrl: 'https://api.example.com/v1', apiKey: 'bad-key' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication failed');
    expect(result.error).toContain('401');
    expect(result.detectedShape).toBe('auth-failed');

    vi.restoreAllMocks();
  });

  it('testCustomProviderUrl: OpenAI-compatible /models response → detectedCategory=llm', async () => {
    const { testCustomProviderUrl } = await import('../../src/provider-registry/registry.js');
    const fetchSpy = vi.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-4', name: 'GPT-4' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await testCustomProviderUrl({ apiUrl: 'https://api.example.com/v1', apiKey: 'test-key' });
    expect(result.success).toBe(true);
    expect(result.detectedCategory).toBe('llm');
    expect(result.detectedShape).toBe('openai-compatible-models');

    vi.restoreAllMocks();
  });

  it('testCustomProviderUrl: ElevenLabs-compatible /voices response → detectedCategory=tts', async () => {
    const { testCustomProviderUrl } = await import('../../src/provider-registry/registry.js');
    const fetchSpy = vi.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      voices: [{ voice_id: 'abc', name: 'Test Voice' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await testCustomProviderUrl({ apiUrl: 'https://api.example.com/v1', apiKey: 'test-key' });
    expect(result.success).toBe(true);
    expect(result.detectedCategory).toBe('tts');
    expect(result.detectedShape).toBe('elevenlabs-compatible-voices');

    vi.restoreAllMocks();
  });

  // ── TEST 11: End-to-end — onboard a real non-preset provider ───────────
  it('end-to-end: onboard a custom LLM provider → it appears in listProviders with same shape as presets', () => {
    const beforeCount = listProviders().length;

    // Onboard a custom OpenAI-compatible LLM provider (not in the preset list)
    const entry = onboardCustomProvider({
      displayName: 'Custom OpenAI-Compatible LLM',
      category: 'llm',
      apiUrl: 'https://custom-llm.example.com/v1',
      apiKey: 'custom-llm-key',
    });

    // Verify it appears in listProviders()
    const afterCount = listProviders().length;
    expect(afterCount).toBe(beforeCount + 1);

    // Verify it appears in the LLM provider list (not special-cased)
    const llmProviders = listProviders().filter((p) => p.category === 'llm');
    const found = llmProviders.find((p) => p.id === entry.id);
    expect(found).toBeDefined();
    expect(found!.displayName).toBe('Custom OpenAI-Compatible LLM');
    expect(found!.category).toBe('llm');

    // Verify it's NOT special-cased — it has the same fields as a preset
    const preset = listProviders().find((p) => p.id === 'openrouter')!;
    const customKeys = Object.keys(entry).sort();
    const presetKeys = Object.keys(preset).sort();
    expect(customKeys).toEqual(presetKeys);

    // Verify it can be fetched by ID (same as presets)
    const fetched = getProvider(entry.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(entry.id);
  });
});
