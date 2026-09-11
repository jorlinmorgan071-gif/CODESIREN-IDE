// server/src/provider-registry/registry.ts
// UPR Phase 1 Step 3 — ProviderRegistry singleton + "Test & load models" action.
//
// This is the single source of truth for provider configuration + loaded model
// metadata. Phase 1 scope: 2 providers (OpenRouter + Anthropic), LLM category.
//
// The "Test & load models" action hits each provider's REAL /models endpoint:
//   - OpenRouter: GET https://openrouter.ai/api/v1/models (returns JSON array)
//   - Anthropic:  GET https://api.anthropic.com/v1/models (returns JSON array,
//                  requires x-api-key + anthropic-version headers)
//
// On success, the models[] array is populated with real current data from the
// provider — NOT a hardcoded list, NOT a cached/stale one.
// On failure (bad key, network error, etc.), lastError is set to a specific,
// visible error message — NOT a silent empty dropdown.

import { config } from '../config.js';
import type { ProviderRegistryEntry, ProviderModel, TestAndLoadResult, CostTier } from './types.js';

// ── Provider defaults ────────────────────────────────────────────────────
// These are the seed values. The user can override apiUrl + apiKey via the
// settings panel. models[] starts empty and is populated by "Test & load".

const OPENROUTER_DEFAULT_URL = 'https://openrouter.ai/api/v1';
const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com/v1';

function seedEntries(): ProviderRegistryEntry[] {
  return [
    {
      id: 'openrouter',
      category: 'llm',
      displayName: 'OpenRouter (Cloud Gateway)',
      defaultApiUrl: OPENROUTER_DEFAULT_URL,
      apiUrl: OPENROUTER_DEFAULT_URL,
      apiKey: config.OPENROUTER_API_KEY ?? '',
      connectionTested: false,
      models: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'anthropic',
      category: 'llm',
      displayName: 'Anthropic (Direct API)',
      defaultApiUrl: ANTHROPIC_DEFAULT_URL,
      apiUrl: ANTHROPIC_DEFAULT_URL,
      apiKey: config.ANTHROPIC_API_KEY ?? '',
      connectionTested: false,
      models: [],
      lastError: null,
      lastLoadedAt: null,
    },
  ];
}

// ── Registry singleton ───────────────────────────────────────────────────
// In-memory only for Phase 1. A future phase may persist to DB or config file.
// The registry is per-server-process; settings changes are not shared across
// server instances (acceptable for Phase 1's single-server dev model).

const entries = new Map<string, ProviderRegistryEntry>();

// Initialize from seed on first import
for (const entry of seedEntries()) {
  entries.set(entry.id, entry);
}

export function listProviders(): ProviderRegistryEntry[] {
  return [...entries.values()];
}

export function getProvider(id: string): ProviderRegistryEntry | undefined {
  return entries.get(id);
}

export function updateProviderConfig(id: string, patch: { apiUrl?: string; apiKey?: string }): ProviderRegistryEntry | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;
  if (patch.apiUrl !== undefined) entry.apiUrl = patch.apiUrl;
  if (patch.apiKey !== undefined) entry.apiKey = patch.apiKey;
  // If config changed, mark as not-tested (models are now stale)
  if (patch.apiUrl !== undefined || patch.apiKey !== undefined) {
    entry.connectionTested = false;
    entry.models = [];
    entry.lastError = null;
    entry.lastLoadedAt = null;
  }
  return entry;
}

/**
 * Reset a provider entry to its seed state — for testing.
 * Clears models[], connectionTested, lastError, lastLoadedAt.
 * Restores apiKey from env (so tests that cleared it can restore it).
 */
export function resetProvider(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.connectionTested = false;
  entry.models = [];
  entry.lastError = null;
  entry.lastLoadedAt = null;
  // Restore API key from config (env) — falls back to process.env directly
  // in case config.ts was parsed before env vars were set (test ordering issue)
  if (id === 'openrouter') {
    entry.apiKey = config.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '';
  }
  if (id === 'anthropic') {
    entry.apiKey = config.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
  }
  entry.apiUrl = entry.defaultApiUrl;
}

// ── "Test & load models" ────────────────────────────────────────────────
// Hits the real provider /models endpoint. On success, populates models[].
// On failure, sets lastError to a specific, visible error.

export async function testAndLoadModels(providerId: string): Promise<TestAndLoadResult> {
  const entry = entries.get(providerId);
  if (!entry) {
    return { providerId, success: false, models: [], error: `Unknown provider: ${providerId}`, durationMs: 0 };
  }

  const start = Date.now();
  try {
    let models: ProviderModel[] = [];

    if (providerId === 'openrouter') {
      models = await fetchOpenRouterModels(entry.apiUrl, entry.apiKey);
    } else if (providerId === 'anthropic') {
      models = await fetchAnthropicModels(entry.apiUrl, entry.apiKey);
    } else {
      return { providerId, success: false, models: [], error: `No model-list endpoint for provider: ${providerId}`, durationMs: Date.now() - start };
    }

    // Success — update the registry entry
    entry.models = models;
    entry.connectionTested = true;
    entry.lastError = null;
    entry.lastLoadedAt = Date.now();

    return { providerId, success: true, models, error: null, durationMs: Date.now() - start };
  } catch (err: any) {
    // Failure — set a specific, visible error (NOT silent)
    const errorMsg = err?.message ?? String(err);
    entry.lastError = errorMsg;
    entry.connectionTested = false;
    // Keep any previously-loaded models (so the dropdown isn't empty if the
    // user had a successful load before). But mark as not-tested so the UI
    // shows the error state.
    return { providerId, success: false, models: entry.models, error: errorMsg, durationMs: Date.now() - start };
  }
}

// ── OpenRouter /v1/models ────────────────────────────────────────────────
// GET https://openrouter.ai/api/v1/models
// Returns: { data: [{ id, name, context_length, top_provider?, pricing?, architecture? }] }
// No auth required for the models list endpoint, but we send the key if available.

async function fetchOpenRouterModels(apiUrl: string, apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('OpenRouter API key is not set. Enter your OpenRouter API key and try again.');
  }

  const url = `${apiUrl.replace(/\/+$/, '')}/models`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no response body)');
    if (res.status === 401) {
      throw new Error(`OpenRouter rejected the API key (401 Unauthorized). Verify your key is valid. Response: ${body.slice(0, 200)}`);
    }
    throw new Error(`OpenRouter models request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    data?: Array<{
      id: string;
      name?: string;
      context_length?: number;
      top_provider?: { max_completion_tokens?: number };
      pricing?: { prompt?: string; completion?: string };
      architecture?: { modality?: string; input_modalities?: string[] };
    }>;
  };

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('OpenRouter returned unexpected response shape — no "data" array. The API may have changed.');
  }

  return data.data.map((m) => {
    const promptCost = m.pricing?.prompt ?? '0';
    const completionCost = m.pricing?.completion ?? '0';
    const isFree = promptCost === '0' && completionCost === '0';
    const costTier: CostTier = isFree ? 'free' : 'paid';
    const modalities = m.architecture?.input_modalities ?? (m.architecture?.modality ? [m.architecture.modality] : []);
    const supportsVision = modalities.some((mod) => mod?.toLowerCase().includes('image'));

    return {
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.context_length ?? 0,
      maxOutputTokens: m.top_provider?.max_completion_tokens ?? 0,
      costTier,
      freeOrPaid: isFree ? 'free' as const : 'paid' as const,
      supportsVision,
      supportsToolUse: false,  // OpenRouter doesn't report tool-use in /models — would need per-model docs
      pricingNote: isFree ? 'Free' : `$${promptCost}/MTok in, $${completionCost}/MTok out`,
    };
  });
}

// ── Anthropic /v1/models ─────────────────────────────────────────────────
// GET https://api.anthropic.com/v1/models
// Returns: { data: [{ id, display_name, created_at, type }] }
// Requires x-api-key + anthropic-version headers.

async function fetchAnthropicModels(apiUrl: string, apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Anthropic API key is not set. Enter your Anthropic API key and try again.');
  }

  const url = `${apiUrl.replace(/\/+$/, '')}/models`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no response body)');
    if (res.status === 401) {
      throw new Error(`Anthropic rejected the API key (401 Unauthorized). Verify your key is valid. Response: ${body.slice(0, 200)}`);
    }
    throw new Error(`Anthropic models request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    data?: Array<{
      id: string;
      display_name?: string;
      created_at?: string;
      type?: string;
    }>;
  };

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Anthropic returned unexpected response shape — no "data" array. The API may have changed.');
  }

  // Anthropic's /v1/models endpoint returns model IDs + display names but does
  // NOT report context window, max output tokens, or pricing. We populate what
  // the provider gives us and leave the rest at 0/empty — the UI will show
  // "not reported" for those fields rather than fabricating values.
  return data.data.map((m) => {
    const id = m.id;
    const name = m.display_name ?? m.id;

    // Anthropic's model naming convention tells us about capabilities:
    // - Models with "vision" in the ID support image input
    // - Claude 3+ and Claude 4+ models all support tool use + vision
    // The naming convention is: claude-3-*, claude-3.5-*, claude-4-*, claude-sonnet-4-*,
    // claude-opus-4-*, etc. All Claude 3+ models support vision + tool-use.
    const supportsVision = id.includes('vision') || id.startsWith('claude-3') || id.startsWith('claude-4') || /^claude-(sonnet|opus|haiku)-(3|4)/.test(id);
    const supportsToolUse = id.startsWith('claude-3') || id.startsWith('claude-4') || /^claude-(sonnet|opus|haiku)-(3|4)/.test(id);

    return {
      id,
      name,
      contextWindow: 0,       // Anthropic /models doesn't report this
      maxOutputTokens: 0,     // Anthropic /models doesn't report this
      costTier: 'paid' as CostTier,  // All Anthropic models are paid
      freeOrPaid: 'paid' as const,
      supportsVision,
      supportsToolUse,
      pricingNote: '',         // Not reported by /models — see Anthropic's pricing page
    };
  });
}
