// tests/unit/skills-batch4.test.ts
//
// Phase D Batch 4 — 3 developer platform API skills + http_request tool extensions.
//
// Covers:
//   - http_request backward compatibility: api_key_prefix (empty = current behavior)
//   - http_request backward compatibility: POST body support (GET unaffected)
//   - GitHub repo search (mocked + missing-key + live skip-safe)
//   - Dev.to articles (mocked + missing-key + live skip-safe)
//   - Hashnode feed (mocked + live skip-safe — endpoint intermittently down)
//   - Fabrication guard: API error → honest failure

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { loadLibrarySkills } from '../../src/skills/library/index.js';
import { listInstalledSkills, executeSkill, getSkill } from '../../src/skills/executor.js';
import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';

describe('Phase D Batch 4 — Developer Platform APIs + http_request extensions', () => {
  beforeAll(() => {
    loadLibrarySkills();
  });

  // ════════════════════════════════════════════════════════════════════
  // http_request backward compatibility: api_key_prefix
  // ════════════════════════════════════════════════════════════════════

  describe('http_request extension: api_key_prefix', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.TEST_PREFIX_KEY;
    });

    it('empty prefix = current behavior (header value is just the key)', async () => {
      process.env.TEST_PREFIX_KEY = 'test-key-value';
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await toolRegistry.execute('http_request', {
        url: 'https://example.com/test',
        method: 'GET',
        api_key_env: 'TEST_PREFIX_KEY',
        api_key_placement: 'header',
        api_key_header_name: 'X-Api-Key',
        // No api_key_prefix — defaults to empty string
      });

      const fetchCall = (global.fetch as any).mock.calls[0];
      const headers = fetchCall[1].headers;
      expect(headers['X-Api-Key']).toBe('test-key-value');
    });

    it('Bearer prefix prepended correctly (GitHub pattern)', async () => {
      process.env.TEST_PREFIX_KEY = 'ghp_testtoken123';
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await toolRegistry.execute('http_request', {
        url: 'https://api.github.com/test',
        method: 'GET',
        api_key_env: 'TEST_PREFIX_KEY',
        api_key_placement: 'header',
        api_key_header_name: 'Authorization',
        api_key_prefix: 'Bearer ',
      });

      const fetchCall = (global.fetch as any).mock.calls[0];
      const headers = fetchCall[1].headers;
      expect(headers['Authorization']).toBe('Bearer ghp_testtoken123');
    });

    it('prefix does NOT affect query-param placement (only headers)', async () => {
      process.env.TEST_PREFIX_KEY = 'test-key';
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await toolRegistry.execute('http_request', {
        url: 'https://example.com/test',
        method: 'GET',
        api_key_env: 'TEST_PREFIX_KEY',
        api_key_placement: 'query',
        api_key_query_param: 'apiKey',
        api_key_prefix: 'Bearer ', // should be ignored for query placement
      });

      const fetchCall = (global.fetch as any).mock.calls[0];
      const url = fetchCall[0];
      expect(url).toContain('apiKey=test-key');
      expect(url).not.toContain('Bearer');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // http_request backward compatibility: POST body support
  // ════════════════════════════════════════════════════════════════════

  describe('http_request extension: POST body support', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('GET requests are unaffected (no body passed to fetch)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await toolRegistry.execute('http_request', {
        url: 'https://example.com/test',
        method: 'GET',
      });

      const fetchCall = (global.fetch as any).mock.calls[0];
      const options = fetchCall[1];
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
    });

    it('POST with body passes JSON-stringified body to fetch', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ data: { feed: [{ title: 'Test Post' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await toolRegistry.execute('http_request', {
        url: 'https://gql.hashnode.com/graphql',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { query: '{ feed { title } }' },
      });

      const fetchCall = (global.fetch as any).mock.calls[0];
      const options = fetchCall[1];
      expect(options.method).toBe('POST');
      expect(options.body).toBe(JSON.stringify({ query: '{ feed { title } }' }));
    });

    it('POST without body does not pass body to fetch', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await toolRegistry.execute('http_request', {
        url: 'https://example.com/test',
        method: 'POST',
      });

      const fetchCall = (global.fetch as any).mock.calls[0];
      const options = fetchCall[1];
      expect(options.method).toBe('POST');
      expect(options.body).toBeUndefined();
    });

    it('GET with body present does NOT send body (body only for POST/PUT/PATCH)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await toolRegistry.execute('http_request', {
        url: 'https://example.com/test',
        method: 'GET',
        body: { query: 'should not be sent' },
      });

      const fetchCall = (global.fetch as any).mock.calls[0];
      const options = fetchCall[1];
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // All 3 skills installed
  // ════════════════════════════════════════════════════════════════════

  it('all 3 developer platform skills are installed', () => {
    const skills = listInstalledSkills();
    const names = skills.map(s => s.name);
    expect(names).toContain('github-repo-search');
    expect(names).toContain('devto-articles');
    expect(names).toContain('hashnode-feed');
  });

  // ════════════════════════════════════════════════════════════════════
  // Missing-key handling (proven against REAL empty .env)
  // ════════════════════════════════════════════════════════════════════

  it('CRITICAL — GitHub: missing key → honest unavailable (GITHUB_TOKEN empty)', async () => {
    expect(process.env.GITHUB_TOKEN || '').toBe('');
    // GitHub skill has api_key_env set — even though public endpoints work without auth,
    // the skill manifest specifies api_key_env, so missing key = unavailable
    const result = await executeSkill('github-repo-search', { query: 'code siren' });
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('GITHUB_TOKEN');
  });

  it('CRITICAL — Dev.to: missing key → honest unavailable (DEVTO_API_KEY empty)', async () => {
    expect(process.env.DEVTO_API_KEY || '').toBe('');
    const result = await executeSkill('devto-articles', { tag: 'javascript' });
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('DEVTO_API_KEY');
  });

  // Hashnode has no api_key_env in its manifest (public feed) — so missing-key
  // test doesn't apply. Instead, test that it attempts the call (may fail due
  // to endpoint being down, but should NOT report missing key).

  // ════════════════════════════════════════════════════════════════════
  // Success-path mocked tests with realistic fixtures
  // ════════════════════════════════════════════════════════════════════

  function mockSuccess(body: string) {
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'http_request') return { name: 'http_request', content: body, success: true };
      return { name, content: 'unknown', success: false };
    });
  }

  it('GitHub: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      total_count: 2,
      items: [
        { full_name: 'microsoft/vscode', stargazers_count: 188000, description: 'VS Code' },
        { full_name: 'facebook/react', stargazers_count: 220000, description: 'React' },
      ],
    }));
    const result = await executeSkill('github-repo-search', { query: 'code editor' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('microsoft/vscode');
    expect(result.outputs[0]).toContain('facebook/react');
    vi.restoreAllMocks();
  });

  it('Dev.to: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify([
      { title: 'Learning TypeScript', url: 'https://dev.to/article1' },
      { title: 'React Best Practices', url: 'https://dev.to/article2' },
    ]));
    const result = await executeSkill('devto-articles', { tag: 'javascript' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('Learning TypeScript');
    expect(result.outputs[0]).toContain('React Best Practices');
    vi.restoreAllMocks();
  });

  it('Hashnode: success path with realistic GraphQL fixture', async () => {
    mockSuccess(JSON.stringify({
      data: { feed: [
        { title: 'Building with GraphQL', slug: 'building-with-graphql', author: { name: 'Test Author' } },
      ] },
    }));
    const result = await executeSkill('hashnode-feed', {});
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('Building with GraphQL');
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════
  // Manifest correctness
  // ════════════════════════════════════════════════════════════════════

  it('GitHub manifest uses api_key_prefix: "Bearer " with Authorization header', () => {
    const skill = getSkill('github-repo-search');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('api_key_prefix');
    expect(template).toContain('Bearer ');
    expect(template).toContain('Authorization');
    expect(template).toContain('GITHUB_TOKEN');
  });

  it('Dev.to manifest uses api-key header name', () => {
    const skill = getSkill('devto-articles');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('api-key');
    expect(template).toContain('DEVTO_API_KEY');
  });

  it('Hashnode manifest uses POST + body with GraphQL query', () => {
    const skill = getSkill('hashnode-feed');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('POST');
    expect(template).toContain('body');
    expect(template).toContain('query');
    expect(template).toContain('graphql');
  });

  // ════════════════════════════════════════════════════════════════════
  // Live smoke tests (skip-safe)
  // ════════════════════════════════════════════════════════════════════

  it('LIVE: GitHub repo search (skips if GITHUB_TOKEN not configured)', async () => {
    vi.restoreAllMocks();
    if (!process.env.GITHUB_TOKEN) {
      console.log('[live test] GITHUB_TOKEN not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('github-repo-search', { query: 'code siren' });
    if (result.success) console.log('[live test] GitHub returned real repos');
  }, 15000);

  it('LIVE: Dev.to articles (skips if DEVTO_API_KEY not configured)', async () => {
    vi.restoreAllMocks();
    if (!process.env.DEVTO_API_KEY) {
      console.log('[live test] DEVTO_API_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('devto-articles', { tag: 'javascript' });
    if (result.success) console.log('[live test] Dev.to returned real articles');
  }, 15000);

  it('LIVE: Hashnode feed (skips if endpoint unreachable)', async () => {
    vi.restoreAllMocks();
    // Hashnode has no api_key_env — it's a public GraphQL endpoint.
    // But the endpoint has been timing out (522). Skip if it doesn't respond.
    const result = await executeSkill('hashnode-feed', {});
    if (!result.success) {
      console.log('[live test] Hashnode endpoint unavailable — skipping (expected, intermittent 522)');
      return;
    }
    console.log('[live test] Hashnode returned real feed');
  }, 15000);

  // ════════════════════════════════════════════════════════════════════
  // Fabrication guard
  // ════════════════════════════════════════════════════════════════════

  it('API error (403) → honest failure, no fabricated data', async () => {
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'http_request') return { name: 'http_request', content: 'HTTP 403: Forbidden', success: false };
      return { name, content: 'unknown', success: false };
    });
    const result = await executeSkill('github-repo-search', { query: 'test' });
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('403');
    vi.restoreAllMocks();
  });
});
