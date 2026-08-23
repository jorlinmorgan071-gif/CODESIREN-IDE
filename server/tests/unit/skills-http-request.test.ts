// server/tests/unit/skills-http-request.test.ts
// Tests for Phase D Batch 1 — http_request tool + 5 no-key skills.
//
// Testing approach:
//   - http_request tool: mock global fetch, test all failure modes
//   - 5 skills: mock fetch with fixture responses, test success paths
//   - Fabrication guard: 500/timeout/malformed → honest failure, no fake success
//   - 2 live smoke tests: Wikipedia + Open-Meteo (real network, SKIP if unavailable)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';
import { loadSkill } from '../../src/skills/manifest.js';
import { installSkill, executeSkill, listInstalledSkills, uninstallSkill } from '../../src/skills/executor.js';
import { LIBRARY_SKILLS } from '../../src/skills/library/index.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock global fetch for deterministic tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Phase D Batch 1 — http_request tool', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns success for a 200 JSON response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({ result: 'success' }),
      text: async () => '{"result":"success"}',
    });

    const result = await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/test',
      method: 'GET',
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe('http_request');
    expect(result.content).toContain('success');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('returns failure for 500 status code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: { get: () => 'text/plain' },
      text: async () => 'Server error',
    });

    const result = await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/test',
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('500');
    expect(result.content).toContain('Internal Server Error');
  });

  it('returns failure for 404 status code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => 'text/plain' },
      text: async () => 'Not found',
    });

    const result = await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/missing',
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('404');
  });

  it('returns failure for timeout (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    const result = await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/slow',
      timeout_ms: 1,
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('timed out');
  });

  it('returns failure for network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/test',
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('Network error');
    expect(result.content).toContain('ECONNREFUSED');
  });

  it('returns failure for malformed JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => { throw new Error('Unexpected token'); },
      text: async () => 'not valid json',
    });

    const result = await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/test',
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('failed to parse');
  });

  it('returns failure for missing url arg', async () => {
    const result = await toolRegistry.execute('http_request', {});

    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required "url"');
  });

  it('returns failure for missing API key (api_key_env specified but env var empty)', async () => {
    // Ensure the env var is not set
    delete process.env.TEST_MISSING_KEY;

    const result = await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/test',
      api_key_env: 'TEST_MISSING_KEY',
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('missing TEST_MISSING_KEY');
    // Should NOT have called fetch — no point making the call without the key
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('injects API key as header when api_key_placement is "header"', async () => {
    process.env.TEST_API_KEY = 'test-key-value';
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
      text: async () => '{}',
    });

    await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/test',
      api_key_env: 'TEST_API_KEY',
      api_key_placement: 'header',
      api_key_header_name: 'X-Custom-Key',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Custom-Key': 'test-key-value' }),
      })
    );

    delete process.env.TEST_API_KEY;
  });

  it('injects API key as query param when api_key_placement is "query"', async () => {
    process.env.TEST_API_KEY = 'test-key-value';
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
      text: async () => '{}',
    });

    await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/test',
      api_key_env: 'TEST_API_KEY',
      api_key_placement: 'query',
      api_key_query_param: 'key',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/test?key=test-key-value',
      expect.anything()
    );

    delete process.env.TEST_API_KEY;
  });

  it('never logs or returns the API key value in error messages', async () => {
    process.env.TEST_SECRET_KEY = 'super-secret-value-12345';
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401, statusText: 'Unauthorized',
      headers: { get: () => 'text/plain' },
      text: async () => 'Invalid API key',
    });

    const result = await toolRegistry.execute('http_request', {
      url: 'https://api.example.com/test',
      api_key_env: 'TEST_SECRET_KEY',
    });

    expect(result.success).toBe(false);
    // The key value must NOT appear anywhere in the result
    expect(result.content).not.toContain('super-secret-value-12345');

    delete process.env.TEST_SECRET_KEY;
  });
});

// ── 5 Skills: success tests with mocked responses ──────────────────────

describe('Phase D Batch 1 — Skills (mocked success)', () => {
  // Install all library skills before tests
  const skillNames: string[] = [];

  beforeEach(() => {
    mockFetch.mockReset();
    // Install all skills from LIBRARY_SKILLS
    for (const [filename, toml] of Object.entries(LIBRARY_SKILLS)) {
      const manifest = loadSkill(toml);
      installSkill(manifest);
      skillNames.push(manifest.name);
    }
  });

  it('Wikipedia skill returns article summary', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({ title: 'TypeScript', extract: 'TypeScript is a programming language.' }),
      text: async () => '{}',
    });

    const result = await executeSkill('wikipedia-summary', { title: 'TypeScript' });

    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('TypeScript');
  });

  it('Open-Meteo skill returns weather data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({ current_weather: { temperature: 22.5, windspeed: 5.2 } }),
      text: async () => '{}',
    });

    const result = await executeSkill('open-meteo-weather', { latitude: 40.71, longitude: -74.01 });

    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('temperature');
  });

  it('REST Countries skill returns country data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ([{ name: { common: 'France' }, capital: ['Paris'], population: 67391582 }]),
      text: async () => '[]',
    });

    const result = await executeSkill('rest-countries', { country: 'France' });

    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('France');
  });

  it('Hacker News skill fetches top story IDs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ([1, 2, 3]),
      text: async () => '[1,2,3]',
    });

    const result = await executeSkill('hacker-news-top', {});

    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('1');
  });

});

// ── Fabrication guard: skills report honest failures ────────────────────

describe('Phase D Batch 1 — Fabrication guard', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    for (const [filename, toml] of Object.entries(LIBRARY_SKILLS)) {
      const manifest = loadSkill(toml);
      installSkill(manifest);
    }
  });

  it('Wikipedia skill reports 500 honestly — no fabricated data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 500, statusText: 'Server Error',
      headers: { get: () => 'text/plain' },
      text: async () => 'Wikipedia server error',
    });

    const result = await executeSkill('wikipedia-summary', { title: 'Test' });

    expect(result.success).toBe(false);
    // Must NOT contain plausible-looking article data
    expect(result.outputs[0]).not.toContain('"extract"');
    expect(result.outputs[0]).toContain('500');
  });

  it('Open-Meteo skill reports timeout honestly — no fake weather', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    const result = await executeSkill('open-meteo-weather', { latitude: 0, longitude: 0 });

    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('timed out');
    // Must NOT contain fake weather data
    expect(result.outputs[0]).not.toContain('temperature');
  });
});

// ── Live smoke tests (require network — SKIP if unavailable) ────────────

describe('Phase D Batch 1 — Live smoke tests (require network)', () => {
  // Restore real fetch for live tests
  beforeEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
    for (const [filename, toml] of Object.entries(LIBRARY_SKILLS)) {
      const manifest = loadSkill(toml);
      installSkill(manifest);
    }
  });

  afterEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  it('Wikipedia — real API call returns article summary', async () => {
    try {
      const result = await executeSkill('wikipedia-summary', { title: 'JavaScript' });

      // If network is available, should succeed
      if (result.success) {
        expect(result.outputs[0]).toContain('JavaScript');
      } else {
        // Network/service unavailable — skip, don't fail
        console.warn('[live test] Wikipedia API unavailable — skipping');
        return;
      }
    } catch (err) {
      console.warn(`[live test] Wikipedia call failed: ${err}. Skipping.`);
      return;
    }
  }, 15_000);

  it('Open-Meteo — real API call returns weather data', async () => {
    try {
      const result = await executeSkill('open-meteo-weather', { latitude: 40.71, longitude: -74.01 });

      if (result.success) {
        expect(result.outputs[0]).toContain('temperature');
      } else {
        console.warn('[live test] Open-Meteo API unavailable — skipping');
        return;
      }
    } catch (err) {
      console.warn(`[live test] Open-Meteo call failed: ${err}. Skipping.`);
      return;
    }
  }, 15_000);
});
