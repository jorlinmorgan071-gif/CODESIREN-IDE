// server/tests/unit/upr-phase3-api-hub.test.ts
// Phase 3 — API Hub tests:
//   - Information category (NewsAPI, OpenWeather, AlphaVantage)
//   - deleteProvider (built-ins cannot be deleted; custom can)
//   - clearProviderKey (fully clears the key — user's directive)
//   - testCustomProviderUrl (pre-onboarding probe with shape detection)
//   - runHealthCheckNow (single-provider health check)
//
// Tests run with DISABLE_HEALTH_CHECK=1 to prevent the background cycle
// from interfering with assertions about lastHealthCheckAt.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  listProviders,
  getProvider,
  testAndLoadModels,
  onboardCustomProvider,
  deleteProvider,
  clearProviderKey,
  resetProvider,
  testCustomProviderUrl,
} from '../../src/provider-registry/registry.js';
import { runHealthCheckNow } from '../../src/provider-registry/health-check.js';

describe('UPR Phase 3 — API Hub (Information category + delete + reset-key + test-url + health-check)', () => {
  beforeEach(() => {
    // Reset all providers to clean state before each test
    for (const p of listProviders()) {
      resetProvider(p.id);
    }
  });

  // ── Information category ──────────────────────────────────────────────

  it('seed registry includes 3 Information providers (newsapi, openweather, alphavantage)', () => {
    const infoProviders = listProviders().filter((p) => p.category === 'information');
    expect(infoProviders.length).toBe(3);
    expect(infoProviders.map((p) => p.id).sort()).toEqual(['alphavantage', 'newsapi', 'openweather']);
  });

  it('newsapi seed entry has correct defaults', () => {
    const newsapi = getProvider('newsapi')!;
    expect(newsapi.category).toBe('information');
    expect(newsapi.displayName).toBe('NewsAPI (News Headlines)');
    expect(newsapi.defaultApiUrl).toBe('https://newsapi.org/v2');
    expect(newsapi.infoEndpoints).toEqual([]);
    expect(newsapi.connectionTested).toBe(false);
    expect(newsapi.healthy).toBe(false);
    expect(newsapi.isCustom).toBe(false);
  });

  it('testAndLoadModels for newsapi fails with no API key + sets suggestedAction', async () => {
    // Explicitly clear the API key (resetProvider may restore from env)
    const newsapi = getProvider('newsapi')!;
    newsapi.apiKey = '';
    const result = await testAndLoadModels('newsapi');
    expect(result.success).toBe(false);
    expect(result.error).toContain('API key is not set');
    const entry = getProvider('newsapi')!;
    expect(entry.healthy).toBe(false);
    expect(entry.suggestedAction).not.toBeNull();
  });

  it('testAndLoadModels for newsapi with a bad key returns 401 + suggestedAction', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"code":"apiKeyInvalid","message":"Your API key is invalid"}', { status: 401 }),
    );
    const newsapi = getProvider('newsapi')!;
    newsapi.apiKey = 'bad-key';
    const result = await testAndLoadModels('newsapi');
    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(entry().suggestedAction).toContain('invalid');
    fetchSpy.mockRestore();
    function entry() { return getProvider('newsapi')!; }
  });

  it('testAndLoadModels for newsapi with a valid key loads endpoints + sets healthy=true', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"status":"ok","articles":[]}', { status: 200 }),
    );
    const newsapi = getProvider('newsapi')!;
    newsapi.apiKey = 'valid-key';
    const result = await testAndLoadModels('newsapi');
    expect(result.success).toBe(true);
    expect(result.infoEndpoints.length).toBe(3); // top-headlines, everything, sources
    expect(entry().healthy).toBe(true);
    expect(entry().lastHealthCheckAt).not.toBeNull();
    expect(entry().suggestedAction).toBeNull();
    fetchSpy.mockRestore();
    function entry() { return getProvider('newsapi')!; }
  });

  // ── deleteProvider ────────────────────────────────────────────────────

  it('deleteProvider on a built-in provider returns an error', () => {
    const result = deleteProvider('openrouter');
    expect(result.success).toBe(false);
    expect(result.error).toContain('built-in');
    // The provider is still there
    expect(getProvider('openrouter')).toBeDefined();
  });

  it('deleteProvider on a custom provider removes it from the registry', () => {
    const beforeCount = listProviders().length;
    const entry = onboardCustomProvider({
      displayName: 'My Custom News',
      category: 'information',
      apiUrl: 'https://example.com',
      apiKey: 'key',
    });
    expect(listProviders().length).toBe(beforeCount + 1);
    const result = deleteProvider(entry.id);
    expect(result.success).toBe(true);
    expect(listProviders().length).toBe(beforeCount);
    expect(getProvider(entry.id)).toBeUndefined();
  });

  it('deleteProvider on an unknown id returns an error', () => {
    const result = deleteProvider('does-not-exist');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown');
  });

  // ── clearProviderKey ─────────────────────────────────────────────────

  it('clearProviderKey fully clears the key (user directive: "key is fully gone")', () => {
    // Set a key first
    const openrouter = getProvider('openrouter')!;
    openrouter.apiKey = 'sk-test-12345';
    expect(openrouter.apiKey).toBe('sk-test-12345');

    const result = clearProviderKey('openrouter');
    expect(result.success).toBe(true);

    const after = getProvider('openrouter')!;
    expect(after.apiKey).toBe(''); // FULLY cleared — no env restore
    expect(after.connectionTested).toBe(false);
    expect(after.healthy).toBe(false);
    expect(after.suggestedAction).toContain('cleared');
    expect(after.models).toEqual([]);
  });

  it('clearProviderKey on an unknown id returns an error', () => {
    const result = clearProviderKey('does-not-exist');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown');
  });

  it('clearProviderKey does NOT restore the key from env (key is fully gone)', () => {
    // Even if process.env.OPENROUTER_API_KEY is set, clearProviderKey should
    // leave the key empty. (resetProvider restores from env; clearProviderKey
    // does not.)
    process.env.OPENROUTER_API_KEY = 'sk-from-env';
    const openrouter = getProvider('openrouter')!;
    openrouter.apiKey = 'sk-from-env';
    clearProviderKey('openrouter');
    expect(getProvider('openrouter')!.apiKey).toBe('');
    delete process.env.OPENROUTER_API_KEY;
  });

  // ── testCustomProviderUrl ────────────────────────────────────────────

  it('testCustomProviderUrl rejects an invalid URL', async () => {
    const result = await testCustomProviderUrl({ apiUrl: 'not-a-url' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL format');
  });

  it('testCustomProviderUrl rejects a non-HTTP protocol', async () => {
    const result = await testCustomProviderUrl({ apiUrl: 'ftp://example.com' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP');
  });

  it('testCustomProviderUrl detects LLM shape from { data: [{ id }] }', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4', name: 'GPT-4' }] }), { status: 200 }),
    );
    const result = await testCustomProviderUrl({ apiUrl: 'https://api.example.com/v1/models' });
    expect(result.success).toBe(true);
    expect(result.detectedCategory).toBe('llm');
    expect(result.detectedShape).toBe('openai-compatible-models');
    fetchSpy.mockRestore();
  });

  it('testCustomProviderUrl detects TTS shape from { voices: [{ voice_id }] }', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ voices: [{ voice_id: 'v1', name: 'Voice 1' }] }), { status: 200 }),
    );
    const result = await testCustomProviderUrl({ apiUrl: 'https://api.example.com/v1/voices' });
    expect(result.success).toBe(true);
    expect(result.detectedCategory).toBe('tts');
    expect(result.detectedShape).toBe('elevenlabs-compatible-voices');
    fetchSpy.mockRestore();
  });

  it('testCustomProviderUrl detects Information shape from { articles: [] }', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', articles: [{ title: 'Headline' }] }), { status: 200 }),
    );
    const result = await testCustomProviderUrl({ apiUrl: 'https://api.example.com/v2/top-headlines' });
    expect(result.success).toBe(true);
    expect(result.detectedCategory).toBe('information');
    expect(result.detectedShape).toContain('news');
    fetchSpy.mockRestore();
  });

  it('testCustomProviderUrl flags mismatch when claimed ≠ detected', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4' }] }), { status: 200 }),
    );
    const result = await testCustomProviderUrl({
      apiUrl: 'https://api.example.com/v1/models',
      claimedCategory: 'information', // wrong — actual is llm
    });
    expect(result.success).toBe(true);
    expect(result.detectedCategory).toBe('llm');
    expect(result.suggestedAction).toContain('⚠'); // mismatch warning
    fetchSpy.mockRestore();
  });

  it('testCustomProviderUrl on 401 returns suggestedAction about the key', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid key"}', { status: 401 }),
    );
    const result = await testCustomProviderUrl({
      apiUrl: 'https://api.example.com/v1/models',
      apiKey: 'bad-key',
    });
    expect(result.success).toBe(false);
    expect(result.suggestedAction).toContain('key');
    fetchSpy.mockRestore();
  });

  it('testCustomProviderUrl on HTML response flags as docs page', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('<!DOCTYPE html><html><body>Docs</body></html>', { status: 200 }),
    );
    const result = await testCustomProviderUrl({ apiUrl: 'https://example.com/docs' });
    expect(result.success).toBe(false);
    expect(result.detectedShape).toContain('html-not-json');
    expect(result.suggestedAction).toContain('docs');
    fetchSpy.mockRestore();
  });

  // ── Health-check cycle ──────────────────────────────────────────────

  it('runHealthCheckNow on a provider with no API key sets suggestedAction', async () => {
    const openrouter = getProvider('openrouter')!;
    openrouter.apiKey = ''; // no key
    await runHealthCheckNow('openrouter');
    const after = getProvider('openrouter')!;
    expect(after.healthy).toBe(false);
    expect(after.suggestedAction).toContain('No API key');
    expect(after.lastHealthCheckAt).not.toBeNull();
  });

  it('runHealthCheckNow on a provider with a valid key marks it healthy', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4', name: 'GPT-4' }] }), { status: 200 }),
    );
    const openrouter = getProvider('openrouter')!;
    openrouter.apiKey = 'valid-key';
    await runHealthCheckNow('openrouter');
    const after = getProvider('openrouter')!;
    expect(after.healthy).toBe(true);
    expect(after.lastHealthCheckAt).not.toBeNull();
    expect(after.suggestedAction).toBeNull();
    fetchSpy.mockRestore();
  });

  it('runHealthCheckNow on an unknown provider is a no-op', async () => {
    // Should not throw
    await runHealthCheckNow('does-not-exist');
    // No provider was added
    expect(getProvider('does-not-exist')).toBeUndefined();
  });

  // ── Suggested-action classifier ─────────────────────────────────────

  it('testAndLoadModels failure sets suggestedAction based on error type', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":"rate limit"}', { status: 429 }),
    );
    const newsapi = getProvider('newsapi')!;
    newsapi.apiKey = 'valid-key';
    const result = await testAndLoadModels('newsapi');
    expect(result.success).toBe(false);
    expect(getProvider('newsapi')!.suggestedAction).toContain('Rate limit');
    fetchSpy.mockRestore();
  });

  // ── Custom LLM provider — OpenAI-compatible shape ────────────────

  it('testAndLoadModels for a custom LLM provider hits OpenAI-compatible /models', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'custom-model', name: 'Custom Model' }] }), { status: 200 }),
    );
    const entry = onboardCustomProvider({
      displayName: 'My Custom LLM',
      category: 'llm',
      apiUrl: 'https://custom-llm.example.com/v1',
      apiKey: 'custom-key',
    });
    const result = await testAndLoadModels(entry.id);
    expect(result.success).toBe(true);
    expect(result.models.length).toBe(1);
    expect(result.models[0].id).toBe('custom-model');
    // Verify the fetch URL ended with /models
    expect(fetchSpy.mock.calls[0][0]).toContain('/models');
    fetchSpy.mockRestore();
    deleteProvider(entry.id);
  });
});
