// server/src/orchestration/search-provider.ts
// SearchProvider abstraction for web search. Step 2b.
//
// The chat web-search toggle and the Research Agent both call the `web_search`
// tool (registered in agents/_shared/tool-registry.ts), which delegates to a
// SearchProvider. Only Tavily is built now; the interface lets future providers
// (e.g. Brave, Serper) be added behind the same tool.
//
// Hard rules enforced here:
//   - No API key configured → throw SearchProviderNotConfiguredError. The tool
//     turns this into a clear "Add a search provider in the Model Router"
//     message. NEVER return fabricated/fake results and NEVER silently fall
//     back to another source (Wikipedia is not a fallback unless explicitly
//     labelled as a separate "Wikipedia lookup").
//   - Every request goes through requestExternalHttp (the egress policy), so
//     SSRF/private-IP/non-HTTPS destinations are rejected.

import { requestExternalHttp } from '../security/egress-policy.js';

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  score?: number;
}

export interface SearchOptions {
  maxResults?: number;
}

export interface SearchProvider {
  readonly id: string;
  /**
   * Run a web search. Throws `SearchProviderNotConfiguredError` if no API key
   * is configured. Never returns fabricated results — on failure it throws.
   */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

/** Thrown when a search provider has no API key. Surfaces as a clear UI message. */
export class SearchProviderNotConfiguredError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Web search is not configured — add a search provider (Tavily) in the Model Router to enable it.`,
    );
    this.name = 'SearchProviderNotConfiguredError';
  }
}

// ── Tavily provider ────────────────────────────────────────────────────
// API reference (verified against docs.tavily.com/api-reference/endpoint/search):
//   POST https://api.tavily.com/search
//   Authorization: Bearer tvly-<key>   (header only; never in the body)
//   body: { "query": "...", "max_results": N }   (max_results: 1..20, default 10)
//   200 → { query, answer?, results: [{ title, url, content, score, ... }], ... }
//   401 → missing/invalid key; 429 → rate-limited; 432/433/434 → plan limits.

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}
interface TavilyResponse {
  results?: TavilyResult[];
  answer?: string;
}

export class TavilySearchProvider implements SearchProvider {
  readonly id = 'tavily';

  constructor(
    private readonly getApiKey: () => string,
    private readonly getApiUrl: () => string,
  ) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const apiKey = this.getApiKey();
    if (!apiKey) throw new SearchProviderNotConfiguredError('tavily');

    const apiUrl = (this.getApiUrl() || 'https://api.tavily.com').replace(/\/$/, '');
    const maxResults = clamp(Math.round(opts.maxResults ?? 5), 1, 20);

    const egress = await requestExternalHttp({
      url: `${apiUrl}/search`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: trimmed, max_results: maxResults }),
      timeoutMs: 15_000,
      sensitiveHeaderNames: ['Authorization'],
    });

    if (!egress.ok || !egress.response) {
      throw new Error(
        `Tavily search failed: ${egress.reason ?? egress.violation ?? 'request could not be completed'}`,
      );
    }
    const { status, statusText, body } = egress.response;
    if (status < 200 || status >= 300) {
      const hint = status === 401
        ? ' — missing or invalid API key. Add a Tavily key in the Model Router.'
        : status === 429
          ? ' — rate limited.'
          : '';
      throw new Error(`Tavily search failed: HTTP ${status} ${statusText}${hint}`);
    }

    let data: TavilyResponse;
    try {
      data = JSON.parse(body) as TavilyResponse;
    } catch {
      throw new Error('Tavily search failed: response was not valid JSON');
    }

    const raw = Array.isArray(data.results) ? data.results : [];
    return raw
      .map((r) => ({
        url: String(r.url ?? ''),
        title: String(r.title ?? '(untitled)'),
        snippet: String(r.content ?? ''),
        score: typeof r.score === 'number' ? r.score : undefined,
      }))
      .filter((r) => r.url.length > 0);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Resolve the Tavily provider from the ProviderRegistry. The registry entry is
 * read lazily (captured by reference), so a key saved via PATCH /api/hub/tavily
 * (updateProviderConfig) is picked up on the next search without a restart.
 * Falls back to process.env.TAVILY_API_KEY / TAVILY_API_URL.
 */
export async function getTavilySearchProvider(): Promise<TavilySearchProvider> {
  const { getProvider } = await import('../provider-registry/registry.js');
  const entry = getProvider('tavily');
  return new TavilySearchProvider(
    () => entry?.apiKey || process.env.TAVILY_API_KEY || '',
    () => entry?.apiUrl || process.env.TAVILY_API_URL || 'https://api.tavily.com',
  );
}
