// tests/security/research-agent.test.ts
// Tests for the ResearchAgent — verifies web search via the shared `web_search`
// tool (Tavily SearchProvider) + page reading via `fetch_page`, and the
// architectural fabrication guard.
//
// Step 2b: the agent was migrated from direct DuckDuckGo/raw-fetch calls to the
// shared web_search/fetch_page tools. These tests spy on toolRegistry.execute
// to feed controlled tool results (the tool's own HTTP behavior is covered by
// tests/unit/web-search.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResearchAgent } from '../../src/agents/research/index.js';
import { toolRegistry, type ToolResult } from '../../src/agents/_shared/tool-registry.js';
import { modelRouter } from '../../src/orchestration/model-router.js';

// Shape the web_search tool returns on success (meta.results is the structured
// SearchResult[] from the SearchProvider).
function webSearchResult(results: Array<{ url: string; title: string; snippet: string }>): ToolResult {
  return {
    name: 'web_search',
    content: results.map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`).join('\n\n'),
    success: true,
    meta: { provider: 'tavily', count: results.length, results },
  };
}

function fetchPageResult(title: string, url: string, text: string): ToolResult {
  return {
    name: 'fetch_page',
    content: `${title}\n${url}\n\n${text}`,
    success: true,
    meta: { title, finalUrl: url, text, chars: text.length },
  };
}

const SEARCH_RESULTS = [
  {
    url: 'https://en.wikipedia.org/wiki/TypeScript',
    title: 'TypeScript',
    snippet: 'Test abstract about TypeScript',
  },
  {
    url: 'https://www.typescriptlang.org/',
    title: 'TypeScript is a strongly typed programming language',
    snippet: 'TypeScript is a strongly typed programming language',
  },
];

const PAGE = {
  title: 'TypeScript - Wikipedia',
  url: 'https://en.wikipedia.org/wiki/TypeScript',
  text: 'TypeScript is a programming language developed by Microsoft. It adds static typing to JavaScript.',
};

describe('Phase C Agent 8 — ResearchAgent (via web_search / fetch_page tools)', () => {
  let agent: ResearchAgent;

  beforeEach(() => {
    agent = new ResearchAgent();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: spy on toolRegistry.execute and route web_search / fetch_page.
  function spyTools(opts: { search?: ToolResult; fetchPage?: ToolResult } = {}) {
    const searchResult = opts.search ?? webSearchResult(SEARCH_RESULTS);
    const fetchPage = opts.fetchPage ?? fetchPageResult(PAGE.title, PAGE.url, PAGE.text);
    return vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name) => {
      if (name === 'web_search') return searchResult;
      if (name === 'fetch_page') return fetchPage;
      return { name: String(name), content: 'unknown tool in spy', success: false };
    });
  }

  // ── search() tests ──────────────────────────────────────────────────

  describe('search() — via the web_search tool', () => {
    it('returns normalized SearchResult[] from the tool, with hostName + rank', async () => {
      spyTools();
      const results = await agent.search('TypeScript', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].url).toContain('wikipedia.org');
      expect(results[0].title).toBe('TypeScript');
      expect(results[0].snippet).toContain('Test abstract');
      expect(results[0].hostName).toContain('wikipedia.org');
      expect(results[0].rank).toBe(0);
    });

    it('returns empty array when query is too short', async () => {
      const spy = spyTools();
      const results = await agent.search('a', 5);
      expect(results).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns empty array when the tool fails (no key / network)', async () => {
      spyTools({
        search: { name: 'web_search', content: 'Web search unavailable — add a search provider in the Model Router.', success: false, meta: { notConfigured: true } },
      });
      const results = await agent.search('TypeScript', 5);
      expect(results).toEqual([]);
    });

    it('returns empty array when the tool returns no results', async () => {
      spyTools({ search: webSearchResult([]) });
      const results = await agent.search('TypeScript', 5);
      expect(results).toEqual([]);
    });
  });

  // ── fetchPage() tests ───────────────────────────────────────────────

  describe('fetchPage() — via the fetch_page tool', () => {
    it('returns PageContent from the tool result', async () => {
      spyTools();
      const page = await agent.fetchPage('https://en.wikipedia.org/wiki/TypeScript');
      expect(page).not.toBeNull();
      expect(page!.title).toBe('TypeScript - Wikipedia');
      expect(page!.url).toBe('https://en.wikipedia.org/wiki/TypeScript');
      expect(page!.content).toContain('TypeScript is a programming language');
      expect(page!.tokensUsed).toBeGreaterThan(0);
    });

    it('returns null when URL is too short', async () => {
      const spy = spyTools();
      const page = await agent.fetchPage('ab');
      expect(page).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns null when the tool fails (egress blocked / non-2xx)', async () => {
      spyTools({
        fetchPage: { name: 'fetch_page', content: 'Egress blocked: unsafe-destination', success: false, meta: { violation: 'unsafe-destination' } },
      });
      const page = await agent.fetchPage('https://example.com/test');
      expect(page).toBeNull();
    });
  });

  // ── research() orchestration + fabrication guard ────────────────────

  describe('research() — orchestration + fabrication guard', () => {
    it('CRITICAL — LLM is NOT called when search returns empty (architectural guard)', async () => {
      // Tool returns no results → search() returns [] → research() must short-circuit
      // BEFORE modelRouter.stream() is ever called.
      spyTools({ search: webSearchResult([]) });
      const streamSpy = vi.spyOn(modelRouter, 'stream');

      const result = await agent.research('test query that will return no results');

      expect(result.mode).toBe('no-search-available');
      expect(result.searchResults).toEqual([]);
      expect(result.synthesis).toBeNull();
      // The architectural guard: the LLM stream was never invoked because the
      // call site is inside the `if (searchResults.length > 0)` block.
      expect(streamSpy).not.toHaveBeenCalled();
    });

    it('returns full research result when search succeeds', async () => {
      spyTools();
      const result = await agent.research('TypeScript');
      expect(result.searchResults.length).toBeGreaterThan(0);
      expect(result.mode).not.toBe('no-search-available');
      expect(result.sources.length).toBeGreaterThan(0);
    });
  });

  // ── Agent metadata ─────────────────────────────────────────────────

  describe('agent metadata', () => {
    it('has correct id', () => {
      expect(agent.id).toBe('research-agent');
    });

    it('has trust score > 0', () => {
      expect(agent.trustScore).toBeGreaterThan(0);
    });
  });
});
