// server/tests/unit/web-search.test.ts
// Step 2b — Real web search via the SearchProvider interface + Tavily.
//
// Covers:
//   1. TavilySearchProvider — mocked HTTP contract (POST api.tavily.com/search,
//      Bearer auth, parses results[] into {title,url,snippet,score}).
//   2. No API key → SearchProviderNotConfiguredError (no fabricated results).
//   3. web_search tool — success path returns cited results (title/URL/snippet);
//      no-key path returns the clear "Model Router" message + success:false.
//   4. fetch_page tool — extracts <title> + visible text behind the egress
//      policy; unsafe (private/non-HTTPS) URL is blocked.
//   5. Live Tavily search — runs only when TAVILY_API_KEY is set (skipped
//      otherwise, never fabricated).

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TavilySearchProvider,
  SearchProviderNotConfiguredError,
  getTavilySearchProvider,
} from '../../src/orchestration/search-provider.js';
import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';
import { getProvider } from '../../src/provider-registry/registry.js';

// Importing getProvider seeds the registry singleton with apiKey from env. In
// this file TAVILY_API_KEY is unset at import time, so entry.apiKey === '' and
// the env var controls whether the provider has a key (via the || fallback).
void getProvider;

const TAVILY_RESPONSE = JSON.stringify({
  query: 'TypeScript',
  answer: 'TypeScript is a programming language.',
  results: [
    {
      title: 'TypeScript',
      url: 'https://www.typescriptlang.org/',
      content: 'TypeScript is a strongly typed programming language that builds on JavaScript.',
      score: 0.91,
    },
    {
      title: 'TypeScript - Wikipedia',
      url: 'https://en.wikipedia.org/wiki/TypeScript',
      content: 'TypeScript is a free and open-source high-level programming language.',
      score: 0.82,
    },
  ],
  response_time: 0.42,
});

function mockTavilyFetch() {
  vi.stubGlobal(
    'fetch',
    async (url: string) => {
      if (String(url).includes('api.tavily.com/search')) {
        return new Response(TAVILY_RESPONSE, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  );
}

describe('TavilySearchProvider — mocked HTTP contract', () => {
  beforeEach(() => mockTavilyFetch());
  afterEach(() => vi.unstubAllGlobals());

  test('POSTs to /search with Bearer auth and parses results[] into {title,url,snippet,score}', async () => {
    const seen: { url: string; init?: any }[] = [];
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: any) => {
        seen.push({ url: String(url), init });
        if (String(url).includes('api.tavily.com/search')) {
          return new Response(TAVILY_RESPONSE, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    );

    const provider = new TavilySearchProvider(
      () => 'tvly-test-key',
      () => 'https://api.tavily.com',
    );
    const results = await provider.search('TypeScript', { maxResults: 5 });

    // One call, to the right endpoint, with Bearer auth in the header (not the body)
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://api.tavily.com/search');
    expect(seen[0].init.method).toBe('POST');
    const authHeader = seen[0].init.headers.Authorization;
    expect(authHeader).toBe('Bearer tvly-test-key');
    const body = JSON.parse(seen[0].init.body);
    expect(body.query).toBe('TypeScript');
    expect(body.max_results).toBe(5);
    expect(JSON.stringify(body)).not.toContain('tvly-test-key'); // key never in the body

    // Results parsed verbatim from the response shape
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'TypeScript',
      url: 'https://www.typescriptlang.org/',
      snippet: expect.stringContaining('strongly typed'),
      score: 0.91,
    });
    expect(results[1].url).toBe('https://en.wikipedia.org/wiki/TypeScript');
  });

  test('non-2xx (401) throws a clear error mentioning the key — no fabricated results', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('{"error":"invalid key"}', { status: 401, statusText: 'Unauthorized' }),
    );
    const provider = new TavilySearchProvider(() => 'tvly-bad', () => 'https://api.tavily.com');
    await expect(provider.search('some query')).rejects.toThrow(/HTTP 401.*API key/i);
  });

  test('non-JSON 200 response throws (no fabrication)', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('<<not json>>', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    const provider = new TavilySearchProvider(() => 'tvly-test-key', () => 'https://api.tavily.com');
    await expect(provider.search('some query')).rejects.toThrow(/not valid JSON/);
  });
});

describe('SearchProvider — no API key', () => {
  test('empty key → SearchProviderNotConfiguredError (never returns fake results)', async () => {
    const provider = new TavilySearchProvider(() => '', () => 'https://api.tavily.com');
    await expect(provider.search('anything')).rejects.toBeInstanceOf(SearchProviderNotConfiguredError);
    const err = await provider.search('anything').catch((e) => e);
    expect(err.providerId).toBe('tavily');
    expect(err.message).toMatch(/Model Router/i);
  });

  test('query too short → empty results (no call made)', async () => {
    const provider = new TavilySearchProvider(() => 'tvly-test-key', () => 'https://api.tavily.com');
    await expect(provider.search('a')).resolves.toEqual([]);
  });
});

describe('web_search tool', () => {
  const savedEnv = process.env.TAVILY_API_KEY;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedEnv === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedEnv;
  });

  test('returns cited results (title, URL, snippet) and structured meta.results', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    mockTavilyFetch();
    const r = await toolRegistry.execute('web_search', { query: 'TypeScript', max_results: 5 });
    expect(r.success).toBe(true);
    expect(r.content).toContain('TypeScript');
    expect(r.content).toContain('https://www.typescriptlang.org/');
    expect(r.content).toContain('strongly typed');
    const meta = r.meta as { provider: string; count: number; results: any[] };
    expect(meta.provider).toBe('tavily');
    expect(meta.count).toBe(2);
    expect(meta.results).toHaveLength(2);
    expect(meta.results[0].url).toBe('https://www.typescriptlang.org/');
  });

  test('no key → clear "Model Router" message, success:false, notConfigured flag, no results', async () => {
    delete process.env.TAVILY_API_KEY;
    mockTavilyFetch(); // would return results if called — but must NOT be called
    const r = await toolRegistry.execute('web_search', { query: 'TypeScript' });
    expect(r.success).toBe(false);
    expect((r.meta as { notConfigured?: boolean }).notConfigured).toBe(true);
    expect(r.content).toMatch(/Model Router/i);
    // No fabricated results in meta
    expect(((r.meta as any).results ?? [])).toHaveLength(0);
  });

  test('missing query arg → success:false', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    const r = await toolRegistry.execute('web_search', {});
    expect(r.success).toBe(false);
    expect(r.content).toMatch(/query/);
  });
});

describe('fetch_page tool — behind the egress policy', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('extracts <title> + visible text, strips scripts/styles, returns meta.text', async () => {
    const html =
      '<html><head><title>Example Page</title></head><body>' +
      '<script>console.log("secret")</script><style>body{color:red}</style>' +
      '<p>Hello world from the page.</p></body></html>';
    vi.stubGlobal(
      'fetch',
      async (url: string) =>
        String(url).startsWith('https://example.com/')
          ? new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
          : new Response('not found', { status: 404 }),
    );
    const r = await toolRegistry.execute('fetch_page', { url: 'https://example.com/article' });
    expect(r.success).toBe(true);
    const meta = r.meta as { title: string; finalUrl: string; text: string };
    expect(meta.title).toBe('Example Page');
    expect(meta.finalUrl).toBe('https://example.com/article');
    expect(meta.text).toContain('Hello world from the page');
    expect(meta.text).not.toContain('console.log');
    expect(meta.text).not.toContain('color:red');
  });

  test('non-HTTPS / private-IP URL is blocked by the egress policy', async () => {
    // fetch is NOT stubbed to answer — the egress policy must reject before any fetch.
    const r = await toolRegistry.execute('fetch_page', { url: 'http://127.0.0.1/admin' });
    expect(r.success).toBe(false);
    expect((r.meta as { violation?: string }).violation).toBeTruthy();
    expect(r.content).toMatch(/Egress/i);
  });

  test('missing url arg → success:false', async () => {
    const r = await toolRegistry.execute('fetch_page', {});
    expect(r.success).toBe(false);
    expect(r.content).toMatch(/url/);
  });
});

describe('live Tavily search', () => {
  test.skipIf(!process.env.TAVILY_API_KEY)('returns real results for a live query', async () => {
    const provider = await getTavilySearchProvider();
    const results = await provider.search('Node.js latest LTS release', { maxResults: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toMatch(/^https?:\/\//);
    expect(results[0].title.length).toBeGreaterThan(0);
  });
});
