// server/src/agents/research/index.ts
// Research Agent — Real web search + page reading + LLM synthesis with
// mandatory source citation.
//
// Phase C Agent 8: HARDENED from 33-line chat-only stub to real IAgent with
// 3 programmatic capabilities:
//   1. search(query, numResults) — calls z-ai SDK's web_search function
//   2. fetchPage(url) — calls z-ai SDK's page_reader function
//   3. research(query) — orchestrates search → fetch → LLM synthesis with
//      ENFORCED source citation
//
// ARCHITECTURAL FABRICATION GUARD (directive Section 2):
//   If search fails, the LLM call for synthesis literally DOES NOT HAPPEN.
//   This is an architectural guard, not a post-hoc label — the code path
//   that calls modelRouter.stream() is inside the `if (searchResults.length > 0)`
//   block, unreachable when search returns empty. Proven by test (spy on
//   modelRouter.stream, confirm it's not called on search failure).
//
// ENVIRONMENTAL DEPENDENCY (documented per user directive):
//   The z-ai SDK authenticates via /etc/.z-ai-config — a system-level file
//   baked into the sandbox image (root:root, 0444 permissions). It is MORE
//   DURABLE than .git/ or node_modules/ (which live on the user data volume
//   and get wiped on sandbox resets), but it is NOT guaranteed permanent —
//   if the sandbox image itself is rebuilt without the z-ai SDK pre-installed,
//   both the CLI binary and the config would vanish.
//
//   At runtime, search() and fetchPage() check for SDK availability. If the
//   SDK can't be initialized (package missing, config missing, or network
//   failure), they return { mode: 'no-search-available', reason: '...' }
//   immediately — same fabrication-guard path as a search failure.
//
// MODE FIELD (directive Section 2):
//   Only TWO values, both with real, tested code paths:
//     'web-search' — search succeeded, real results fetched, LLM synthesis ran
//     'no-search-available' — search failed or SDK unavailable, no LLM call
//   NO third mode (no 'general-knowledge' or 'partial' — per the original
//   build's vestigial-field incident lesson).

import type {
  AgentChunk,
  AgentTask,
  AgentDomain,
  SearchResult,
  PageContent,
  ResearchResult,
} from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { modelRouter } from '../../orchestration/model-router.js';

const SYSTEM_PROMPT = `You are the Research Agent of Zero Two: Code Siren.
Your role: real web search + page reading + LLM synthesis with mandatory source citation.
When researching:
1. Search the web for relevant sources.
2. Fetch the top results to get full page content.
3. Synthesize findings with ENFORCED source citation — every factual claim must
   trace to a fetched source URL, or be explicitly marked [UNSOURCED].
4. Do NOT fabricate information. If a source doesn't mention something, don't
   claim it does.
Be precise, cite sources, and flag uncertainty honestly.`;

const SYNTHESIS_PROMPT = `You are synthesizing research findings from real web sources.
You will be given search results and fetched page content. Your job:

1. Synthesize the key findings into a coherent summary.
2. EVERY factual claim MUST be followed by a source citation in the format [Source N]
   where N corresponds to the source number in the sources list.
3. If you make a claim that NONE of the sources support, mark it [UNSOURCED].
4. Do NOT fabricate information that isn't in the sources.
5. Do NOT hallucinate URLs or source numbers.
6. List all sources at the end with their full URLs.

Format:
## Summary
[Your synthesis with [Source N] citations]

## Sources
1. [Title](URL)
2. [Title](URL)
...`;

export class ResearchAgent extends IAgent {
  readonly id = 'research-agent';
  readonly name = 'Research Agent';
  readonly domain: AgentDomain = 'RESEARCH';
  readonly icon = 'search';
  readonly color = '#84CC16';
  constructor() { super(0.81); }

  // Cached SDK instance (lazy-initialized, same pattern as tts-provider.ts)
  private zaiInstance: any | null = null;

  /**
   * Initialize the z-ai SDK. Returns null if unavailable.
   *
   * ENVIRONMENTAL DEPENDENCY: The SDK authenticates via /etc/.z-ai-config
   * (system-level, part of the sandbox image). If this file or the SDK
   * package is missing, returns null — callers handle this as
   * 'no-search-available'.
   */
  private async ensureSdk(): Promise<any | null> {
    if (this.zaiInstance) return this.zaiInstance;

    try {
      const ZAI = (await import('z-ai-web-dev-sdk')).default;
      this.zaiInstance = await ZAI.create();
      return this.zaiInstance;
    } catch {
      // SDK not installed, config missing, or init failed
      return null;
    }
  }

  // ── 1. search() — real web search via z-ai SDK ─────────────────────
  /**
   * Search the web for results matching the query.
   *
   * Calls zai.functions.invoke('web_search', { query, num }).
   * Returns normalized SearchResult[] with { url, title, snippet, hostName, rank }.
   * Returns empty array if SDK unavailable or search fails.
   */
  async search(query: string, numResults: number = 5): Promise<SearchResult[]> {
    if (!query || query.trim().length < 2) return [];

    const zai = await this.ensureSdk();
    if (!zai) return [];

    try {
      const raw = await zai.functions.invoke('web_search', {
        query: query.trim(),
        num: numResults,
      });

      if (!Array.isArray(raw)) return [];

      return raw.map((item: any, index: number) => ({
        url: String(item.url ?? ''),
        title: String(item.name ?? item.title ?? ''),
        snippet: String(item.snippet ?? ''),
        hostName: String(item.host_name ?? ''),
        rank: Number(item.rank ?? index),
      })).filter((r: SearchResult) => r.url.length > 0);
    } catch {
      return [];
    }
  }

  // ── 2. fetchPage() — real page reading via z-ai SDK ────────────────
  /**
   * Fetch and read the content of a web page.
   *
   * Calls zai.functions.invoke('page_reader', { url }).
   * Returns { title, url, content, tokensUsed } or null if fetch fails.
   */
  async fetchPage(url: string): Promise<PageContent | null> {
    if (!url || url.trim().length < 4) return null;

    const zai = await this.ensureSdk();
    if (!zai) return null;

    try {
      const raw = await zai.functions.invoke('page_reader', { url: url.trim() });

      if (!raw) return null;

      // The page_reader response has a nested structure — extract the content
      const data = raw.data ?? raw;
      return {
        title: String(data.title ?? ''),
        url: String(data.url ?? url),
        content: String(data.content ?? data.text ?? ''),
        tokensUsed: Number(data.usage?.tokens ?? data.tokens ?? 0),
      };
    } catch {
      return null;
    }
  }

  // ── 3. research() — full orchestration with architectural fabrication guard ──
  /**
   * Full research: search → fetch top results → LLM synthesis with citations.
   *
   * ARCHITECTURAL FABRICATION GUARD:
   *   If search() returns empty results (SDK unavailable, network failure, or
   *   no results found), the LLM call for synthesis literally DOES NOT HAPPEN.
   *   The code path that calls modelRouter.stream() is inside the
   *   `if (searchResults.length > 0)` block — unreachable when search fails.
   *   This is architectural, not post-hoc — proven by test.
   *
   * Returns ResearchResult with mode:
   *   'web-search' — search succeeded, synthesis ran
   *   'no-search-available' — search failed, no LLM call, no fabrication
   */
  async research(query: string): Promise<ResearchResult> {
    const trimmedQuery = query.trim();

    // ── Step 1: Search ────────────────────────────────────────────────
    const searchResults = await this.search(trimmedQuery, 5);

    // ── ARCHITECTURAL FABRICATION GUARD ───────────────────────────────
    // If search returned nothing, return immediately. The LLM call below
    // is INSIDE the `if` block — it literally cannot execute when
    // searchResults is empty. This is not a post-hoc label — it's an
    // architectural code-path restriction.
    if (searchResults.length === 0) {
      const sdk = await this.ensureSdk();
      return {
        query: trimmedQuery,
        mode: 'no-search-available',
        searchResults: [],
        fetchedPages: [],
        synthesis: null,
        sources: [],
        reason: sdk === null
          ? 'z-ai SDK not configured (check /etc/.z-ai-config or SDK installation)'
          : 'Search returned no results or search call failed',
      };
    }

    // ── Step 2: Fetch top 3 results ───────────────────────────────────
    const topResults = searchResults.slice(0, 3);
    const fetchedPages: PageContent[] = [];

    for (const result of topResults) {
      const page = await this.fetchPage(result.url);
      if (page) {
        fetchedPages.push(page);
      }
    }

    // ── Step 3: LLM synthesis with enforced source citation ──────────
    // This code is ONLY reachable if searchResults.length > 0 (architectural guard).
    // The LLM CANNOT be called without real search results existing first.
    let synthesis: string | null = null;
    // Populate sources BEFORE the LLM call — if the LLM throws, sources
    // are still available (from the real search results).
    const sources: { url: string; title: string }[] = topResults.map(r => ({
      url: r.url,
      title: r.title,
    }));

    try {
      // Build the LLM input from search results + fetched pages
      const sourceList = topResults.map((r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    Snippet: ${r.snippet}`
      ).join('\n\n');

      const pageContents = fetchedPages.map((p, i) =>
        `--- Page ${i + 1}: ${p.title} ---\nURL: ${p.url}\nContent (first 2000 chars):\n${p.content.slice(0, 2000)}`
      ).join('\n\n');

      const userInput = `Research query: ${trimmedQuery}\n\nSearch results:\n${sourceList}\n\nFetched page contents:\n${pageContents || '(no pages could be fetched — use snippets only)'}`;

      let reviewText = '';
      const stream = modelRouter.stream({
        agentId: this.id,
        domain: this.domain,
        messages: [
          { role: 'system', content: SYNTHESIS_PROMPT },
          { role: 'user', content: userInput },
        ],
        temperature: 0.3,
        maxTokens: 2048,
        executionMode: 'single-shot',
      });

      for await (const chunk of stream) {
        if (chunk.done) break;
        reviewText += chunk.delta;
      }

      synthesis = reviewText;
    } catch {
      // LLM synthesis failed — still return search results + sources, just
      // without synthesis. The search results themselves are real and useful.
      synthesis = null;
    }

    return {
      query: trimmedQuery,
      mode: 'web-search',
      searchResults,
      fetchedPages,
      synthesis,
      sources,
    };
  }

  // ── Chat persona (preserved from original stub) ────────────────────
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.5, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['research', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
