// tests/unit/skills-batch6.test.ts
//
// Phase D Batch 6 — 3 maps & location API skills.
//
// Tests: mocked success + missing-key (real empty .env) + live skip-safe + fabrication guard

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { loadLibrarySkills } from '../../src/skills/library/index.js';
import { listInstalledSkills, executeSkill, getSkill } from '../../src/skills/executor.js';
import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';

describe('Phase D Batch 6 — 3 maps & location API skills', () => {
  beforeAll(() => {
    loadLibrarySkills();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════
  // All 3 skills installed
  // ════════════════════════════════════════════════════════════════════

  it('all 3 maps skills are installed', () => {
    const skills = listInstalledSkills();
    const names = skills.map(s => s.name);
    expect(names).toContain('maptiler-geocode');
    expect(names).toContain('ors-driving-directions');
    expect(names).toContain('owm-current-weather');
  });

  // ════════════════════════════════════════════════════════════════════
  // Missing-key handling (proven against REAL empty .env)
  // ════════════════════════════════════════════════════════════════════

  it('CRITICAL — MapTiler: missing key → honest unavailable', async () => {
    expect(process.env.MAPTILER_API_KEY || '').toBe('');
    const result = await executeSkill('maptiler-geocode', { query: 'Eiffel Tower' });
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('MAPTILER_API_KEY');
  });

  it('CRITICAL — OpenRouteService: missing key → honest unavailable', async () => {
    expect(process.env.OPENROUTESERVICE_KEY || '').toBe('');
    const result = await executeSkill('ors-driving-directions', {
      startLon: '8.681495', startLat: '49.414599', endLon: '8.687872', endLat: '49.420318',
    });
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('OPENROUTESERVICE_KEY');
  });

  it('CRITICAL — OpenWeatherMap: missing key → honest unavailable', async () => {
    expect(process.env.OPENWEATHERMAP_KEY || '').toBe('');
    const result = await executeSkill('owm-current-weather', { city: 'London' });
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('OPENWEATHERMAP_KEY');
  });

  // ════════════════════════════════════════════════════════════════════
  // Success-path mocked tests with realistic fixtures
  // ════════════════════════════════════════════════════════════════════

  function mockSuccess(body: string) {
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'http_request') return { name: 'http_request', content: body, success: true };
      return { name, content: 'unknown', success: false };
    });
  }

  it('MapTiler: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [2.2945, 48.8584] },
        properties: { name: 'Eiffel Tower', place_type: ['poi'] },
      }],
    }));
    const result = await executeSkill('maptiler-geocode', { query: 'Eiffel Tower' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('Eiffel Tower');
    vi.restoreAllMocks();
  });

  it('OpenRouteService: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { segments: [{ distance: 1.2, duration: 180 }] },
        geometry: { type: 'LineString', coordinates: [[8.681, 49.414], [8.687, 49.420]] },
      }],
    }));
    const result = await executeSkill('ors-driving-directions', {
      startLon: '8.681495', startLat: '49.414599', endLon: '8.687872', endLat: '49.420318',
    });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('distance');
    vi.restoreAllMocks();
  });

  it('OpenWeatherMap: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      coord: { lon: -0.13, lat: 51.51 },
      weather: [{ id: 800, main: 'Clear', description: 'clear sky' }],
      main: { temp: 15.2, feels_like: 14.5, humidity: 72 },
      name: 'London',
    }));
    const result = await executeSkill('owm-current-weather', { city: 'London' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('London');
    expect(result.outputs[0]).toContain('Clear');
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════
  // Manifest correctness
  // ════════════════════════════════════════════════════════════════════

  it('MapTiler manifest uses key query param', () => {
    const skill = getSkill('maptiler-geocode');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('api_key_query_param');
    expect(template).toContain('MAPTILER_API_KEY');
  });

  it('ORS manifest uses Authorization header WITHOUT Bearer prefix (raw key)', () => {
    const skill = getSkill('ors-driving-directions');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('Authorization');
    expect(template).toContain('OPENROUTESERVICE_KEY');
    // CRITICAL: must NOT contain api_key_prefix with Bearer (ORS uses raw key)
    expect(template).not.toContain('Bearer');
    expect(template).not.toContain('api_key_prefix');
  });

  it('OpenWeatherMap manifest uses appid query param', () => {
    const skill = getSkill('owm-current-weather');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('appid');
    expect(template).toContain('OPENWEATHERMAP_KEY');
  });

  // ════════════════════════════════════════════════════════════════════
  // Live smoke tests (skip-safe — all keys empty)
  // ════════════════════════════════════════════════════════════════════

  it('LIVE: MapTiler geocoding (skips if key not configured)', async () => {
    if (!process.env.MAPTILER_API_KEY) {
      console.log('[live test] MAPTILER_API_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('maptiler-geocode', { query: 'Eiffel Tower' });
    if (result.success) console.log('[live test] MapTiler returned real geocoding');
  }, 15000);

  it('LIVE: OpenRouteService directions (skips if key not configured)', async () => {
    if (!process.env.OPENROUTESERVICE_KEY) {
      console.log('[live test] OPENROUTESERVICE_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('ors-driving-directions', {
      startLon: '8.681495', startLat: '49.414599', endLon: '8.687872', endLat: '49.420318',
    });
    if (result.success) console.log('[live test] ORS returned real directions');
  }, 15000);

  it('LIVE: OpenWeatherMap current weather (skips if key not configured)', async () => {
    if (!process.env.OPENWEATHERMAP_KEY) {
      console.log('[live test] OPENWEATHERMAP_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('owm-current-weather', { city: 'London' });
    if (result.success) console.log('[live test] OWM returned real weather');
  }, 15000);

  // ════════════════════════════════════════════════════════════════════
  // Fabrication guard
  // ════════════════════════════════════════════════════════════════════

  it('API error (403) → honest failure, no fabricated data', async () => {
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'http_request') return { name: 'http_request', content: 'HTTP 403: Forbidden', success: false };
      return { name, content: 'unknown', success: false };
    });
    const result = await executeSkill('maptiler-geocode', { query: 'test' });
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('403');
    vi.restoreAllMocks();
  });
});
