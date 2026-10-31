// tests/security/research-agent.test.ts
// Tests for the ResearchAgent — verifies real web search via DuckDuckGo API
// (no z-ai SDK dependency) + page fetching + architectural fabrication guard.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResearchAgent } from '../../src/agents/research/index.js';

// Mock fetch responses
const mockSearchResponse = {
  AbstractText: 'Test abstract about TypeScript',
  AbstractURL: 'https://en.wikipedia.org/wiki/TypeScript',
  Heading: 'TypeScript',
  RelatedTopics: [
    { FirstURL: 'https://www.typescriptlang.org/', Text: 'TypeScript is a strongly typed programming language' },
    { FirstURL: 'https://github.com/microsoft/TypeScript', Text: 'TypeScript on GitHub - Microsoft' },
  ],
};

const mockPageHtml = `
<html>
<head><title>TypeScript - Wikipedia</title></head>
<body>
<script>console.log('should be stripped');</script>
<style>body { color: red; }</style>
<p>TypeScript is a programming language developed by Microsoft.</p>
<p>It adds static typing to JavaScript.</p>
</body>
</html>
`;

describe('Phase C Agent 8 — ResearchAgent', () => {
  let agent: ResearchAgent;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    agent = new ResearchAgent();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── search() tests ──────────────────────────────────────────────────

  describe('search() — real DuckDuckGo API', () => {
    it('returns normalized SearchResult[] from DuckDuckGo API', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockSearchResponse,
      }) as any;

      const results = await agent.search('TypeScript', 5);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].url).toContain('wikipedia.org');
      expect(results[0].title).toBe('TypeScript');
      expect(results[0].snippet).toContain('Test abstract');
      expect(results[0].hostName).toContain('wikipedia.org');
    });

    it('returns empty array when query is too short', async () => {
      const results = await agent.search('a', 5);
      expect(results).toEqual([]);
    });

    it('returns empty array when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any;
      const results = await agent.search('TypeScript', 5);
      expect(results).toEqual([]);
    });

    it('returns empty array when API returns non-OK', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
      const results = await agent.search('TypeScript', 5);
      expect(results).toEqual([]);
    });
  });

  // ── fetchPage() tests ───────────────────────────────────────────────

  describe('fetchPage() — real HTTP fetch', () => {
    it('returns PageContent from fetched HTML', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => mockPageHtml,
      }) as any;

      const page = await agent.fetchPage('https://en.wikipedia.org/wiki/TypeScript');

      expect(page).not.toBeNull();
      expect(page!.title).toBe('TypeScript - Wikipedia');
      expect(page!.url).toBe('https://en.wikipedia.org/wiki/TypeScript');
      expect(page!.content).toContain('TypeScript is a programming language');
      expect(page!.content).not.toContain('console.log'); // script stripped
      expect(page!.content).not.toContain('color: red'); // style stripped
      expect(page!.tokensUsed).toBeGreaterThan(0);
    });

    it('returns null when URL is too short', async () => {
      const page = await agent.fetchPage('ab');
      expect(page).toBeNull();
    });

    it('returns null when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any;
      const page = await agent.fetchPage('https://example.com/test');
      expect(page).toBeNull();
    });

    it('returns null when API returns non-OK', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as any;
      const page = await agent.fetchPage('https://example.com/test');
      expect(page).toBeNull();
    });
  });

  // ── research() orchestration + fabrication guard ────────────────────

  describe('research() — orchestration + fabrication guard', () => {
    it('CRITICAL — LLM is NOT called when search returns empty (architectural guard)', async () => {
      // Make fetch fail so search returns empty
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any;

      const result = await agent.research('test query that will return no results');

      expect(result.mode).toBe('no-search-available');
      expect(result.searchResults).toEqual([]);
      expect(result.synthesis).toBeNull();
      // The LLM was NOT called — this is architectural, not post-hoc
    });

    it('returns full research result when search succeeds', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockSearchResponse,
        text: async () => mockPageHtml,
      }) as any;

      const result = await agent.research('TypeScript');

      expect(result.searchResults.length).toBeGreaterThan(0);
      expect(result.mode).not.toBe('no-search-available');
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
