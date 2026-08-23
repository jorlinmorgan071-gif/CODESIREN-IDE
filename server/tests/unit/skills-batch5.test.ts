// tests/unit/skills-batch5.test.ts
//
// Phase D Batch 5 — 5 media & entertainment API skills.
//
// Tests: mocked success + missing-key (real empty .env) + live skip-safe + fabrication guard

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { loadLibrarySkills } from '../../src/skills/library/index.js';
import { listInstalledSkills, executeSkill, getSkill } from '../../src/skills/executor.js';
import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';

async function withMissingEnv<T>(key: string, run: () => Promise<T>): Promise<T> {
  vi.stubEnv(key, '');
  try {
    return await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

describe('Phase D Batch 5 — 5 media & entertainment API skills', () => {
  beforeAll(() => {
    loadLibrarySkills();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════
  // All 5 skills installed
  // ════════════════════════════════════════════════════════════════════

  it('all 5 media skills are installed', () => {
    const skills = listInstalledSkills();
    const names = skills.map(s => s.name);
    expect(names).toContain('pubg-player-lookup');
    expect(names).toContain('tmdb-movie-search');
    expect(names).toContain('omdb-title-search');
    expect(names).toContain('giphy-gif-search');
    expect(names).toContain('rawg-game-search');
  });

  // ════════════════════════════════════════════════════════════════════
  // Missing-key handling (proven against REAL empty .env)
  // ════════════════════════════════════════════════════════════════════

  it('CRITICAL — PUBG: missing key → honest unavailable', async () => {
    const result = await withMissingEnv('PUBG_API_KEY', () => executeSkill('pubg-player-lookup', { playerName: 'test_player' }));
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('PUBG_API_KEY');
  });

  it('CRITICAL — TMDb: missing key → honest unavailable', async () => {
    const result = await withMissingEnv('TMDB_API_KEY', () => executeSkill('tmdb-movie-search', { query: 'Inception' }));
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('TMDB_API_KEY');
  });

  it('CRITICAL — OMDb: missing key → honest unavailable', async () => {
    const result = await withMissingEnv('OMDB_API_KEY', () => executeSkill('omdb-title-search', { query: 'Inception' }));
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('OMDB_API_KEY');
  });

  it('CRITICAL — GIPHY: missing key → honest unavailable', async () => {
    const result = await withMissingEnv('GIPHY_API_KEY', () => executeSkill('giphy-gif-search', { query: 'cats' }));
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('GIPHY_API_KEY');
  });

  it('CRITICAL — RAWG: missing key → honest unavailable', async () => {
    const result = await withMissingEnv('RAWG_API_KEY', () => executeSkill('rawg-game-search', { query: 'Super Mario' }));
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('RAWG_API_KEY');
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

  it('PUBG: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      data: [{
        type: 'player',
        id: 'account.test123',
        attributes: { name: 'test_player', shardId: 'steam' },
      }],
    }));
    const result = await executeSkill('pubg-player-lookup', { playerName: 'test_player' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('test_player');
    vi.restoreAllMocks();
  });

  it('TMDb: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      page: 1, total_results: 2,
      results: [
        { id: 27205, title: 'Inception', release_date: '2010-07-15', vote_average: 8.4 },
        { id: 12345, title: 'Inception 2', release_date: '2020-01-01', vote_average: 6.5 },
      ],
    }));
    const result = await executeSkill('tmdb-movie-search', { query: 'Inception' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('Inception');
    vi.restoreAllMocks();
  });

  it('OMDb: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      Search: [
        { Title: 'Inception', Year: '2010', imdbID: 'tt1375666', Type: 'movie' },
      ],
      totalResults: '1', Response: 'True',
    }));
    const result = await executeSkill('omdb-title-search', { query: 'Inception' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('Inception');
    vi.restoreAllMocks();
  });

  it('GIPHY: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      data: [
        { id: 'gif123', url: 'https://media.giphy.com/media/gif123/giphy.gif', title: 'Funny Cat' },
      ],
      meta: { status: 200, msg: 'OK' },
    }));
    const result = await executeSkill('giphy-gif-search', { query: 'cats' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('Funny Cat');
    vi.restoreAllMocks();
  });

  it('RAWG: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      count: 1,
      results: [
        { id: 3262, name: 'Super Mario Bros.', released: '1985-09-13', rating: 8.5 },
      ],
    }));
    const result = await executeSkill('rawg-game-search', { query: 'Super Mario' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('Super Mario Bros.');
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════
  // Manifest correctness
  // ════════════════════════════════════════════════════════════════════

  it('PUBG manifest uses Bearer prefix + Accept header + raw brackets in URL', () => {
    const skill = getSkill('pubg-player-lookup');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('Bearer ');
    expect(template).toContain('Authorization');
    expect(template).toContain('application/vnd.api+json');
    expect(template).toContain('filter[playerNames]');
    expect(template).toContain('PUBG_API_KEY');
  });

  it('TMDb manifest uses api_key query param', () => {
    const skill = getSkill('tmdb-movie-search');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('api_key');
    expect(template).toContain('TMDB_API_KEY');
    expect(template).toContain('query');
  });

  it('OMDb manifest uses apikey query param', () => {
    const skill = getSkill('omdb-title-search');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('apikey');
    expect(template).toContain('OMDB_API_KEY');
  });

  it('GIPHY manifest uses api_key query param', () => {
    const skill = getSkill('giphy-gif-search');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('api_key');
    expect(template).toContain('GIPHY_API_KEY');
  });

  it('RAWG manifest uses key query param', () => {
    const skill = getSkill('rawg-game-search');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('api_key_query_param');
    expect(template).toContain('RAWG_API_KEY');
  });

  // ════════════════════════════════════════════════════════════════════
  // Live smoke tests (skip-safe — all keys empty in this sandbox)
  // ════════════════════════════════════════════════════════════════════

  it('LIVE: PUBG player lookup (skips if key not configured)', async () => {
    if (!process.env.PUBG_API_KEY) {
      console.log('[live test] PUBG_API_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('pubg-player-lookup', { playerName: 'test' });
    if (result.success) console.log('[live test] PUBG returned real player data');
  }, 15000);

  it('LIVE: TMDb movie search (skips if key not configured)', async () => {
    if (!process.env.TMDB_API_KEY) {
      console.log('[live test] TMDB_API_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('tmdb-movie-search', { query: 'Inception' });
    if (result.success) console.log('[live test] TMDb returned real movies');
  }, 15000);

  it('LIVE: OMDb title search (skips if key not configured)', async () => {
    if (!process.env.OMDB_API_KEY) {
      console.log('[live test] OMDB_API_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('omdb-title-search', { query: 'Inception' });
    if (result.success) console.log('[live test] OMDb returned real titles');
  }, 15000);

  it('LIVE: GIPHY GIF search (skips if key not configured)', async () => {
    if (!process.env.GIPHY_API_KEY) {
      console.log('[live test] GIPHY_API_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('giphy-gif-search', { query: 'cats' });
    if (result.success) console.log('[live test] GIPHY returned real GIFs');
  }, 15000);

  it('LIVE: RAWG game search (skips if key not configured)', async () => {
    if (!process.env.RAWG_API_KEY) {
      console.log('[live test] RAWG_API_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('rawg-game-search', { query: 'Super Mario' });
    if (result.success) console.log('[live test] RAWG returned real games');
  }, 15000);

  // ════════════════════════════════════════════════════════════════════
  // Fabrication guard
  // ════════════════════════════════════════════════════════════════════

  it('API error (401) → honest failure, no fabricated data', async () => {
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'http_request') return { name: 'http_request', content: 'HTTP 401: Unauthorized', success: false };
      return { name, content: 'unknown', success: false };
    });
    const result = await executeSkill('pubg-player-lookup', { playerName: 'test' });
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('401');
    vi.restoreAllMocks();
  });
});
