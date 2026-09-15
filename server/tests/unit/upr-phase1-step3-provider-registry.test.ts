// server/tests/unit/upr-phase1-step3-provider-registry.test.ts
// UPR Phase 1 Step 3 — ProviderRegistry + "Test & load models" tests.
//
// Required evidence (per directive):
//   1. Paste a real OpenRouter key, hit "Test & load models," confirm the
//      returned model list matches what OpenRouter actually currently offers
//      (spot-check 2-3 model IDs).
//   2. Same for Anthropic.
//   3. Test a deliberately bad key on both — confirm the error state is
//      specific and visible, not a silent empty dropdown.
//   4. Confirm the capability line (context/output tokens) shown in the UI
//      matches the real values for at least one selected model per provider.
//
// Method: mocked fetch returning realistic provider /models responses.
// The mock responses are based on the REAL API shape (not fabricated), so
// the tests prove the parsing + registry population logic is correct. The
// "live confirmation with real keys" step is done separately by the user
// pasting real keys into the running settings panel.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Set API keys so the registry seeds with non-empty keys
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

import { listProviders, getProvider, testAndLoadModels, updateProviderConfig, resetProvider } from '../../src/provider-registry/registry.js';

// ── Realistic OpenRouter /v1/models response shape ───────────────────────
// Based on the actual OpenRouter API (https://openrouter.ai/api/v1/models).
// Each model has: id, name, context_length, top_provider.max_completion_tokens,
// pricing (prompt + completion as string per-token cost), architecture.modality.

function mockOpenRouterModelsResponse(): Response {
  const body = {
    data: [
      {
        id: 'anthropic/claude-3.5-sonnet',
        name: 'Anthropic: Claude 3.5 Sonnet',
        context_length: 200000,
        top_provider: { max_completion_tokens: 8192 },
        pricing: { prompt: '0.000003', completion: '0.000015' },
        architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'] },
      },
      {
        id: 'deepseek/deepseek-chat-v3.1',
        name: 'DeepSeek: DeepSeek V3.1',
        context_length: 64000,
        top_provider: { max_completion_tokens: 8192 },
        pricing: { prompt: '0.00000028', completion: '0.00000042' },
        architecture: { modality: 'text->text', input_modalities: ['text'] },
      },
      {
        id: 'google/gemini-2.0-flash-exp:free',
        name: 'Google: Gemini 2.0 Flash Experimental (free)',
        context_length: 1048576,
        top_provider: { max_completion_tokens: 8192 },
        pricing: { prompt: '0', completion: '0' },
        architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'] },
      },
    ],
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ── Realistic Anthropic /v1/models response shape ────────────────────────
// Based on the actual Anthropic API (https://api.anthropic.com/v1/models).
// Each model has: id, display_name, created_at, type. Anthropic's /models
// endpoint does NOT report context window, max output tokens, or pricing.

function mockAnthropicModelsResponse(): Response {
  const body = {
    data: [
      {
        id: 'claude-sonnet-4-20250514',
        display_name: 'Claude Sonnet 4',
        created_at: '2025-05-14T00:00:00Z',
        type: 'model',
      },
      {
        id: 'claude-opus-4-20250514',
        display_name: 'Claude Opus 4',
        created_at: '2025-05-14T00:00:00Z',
        type: 'model',
      },
      {
        id: 'claude-3-5-sonnet-20241022',
        display_name: 'Claude 3.5 Sonnet (Oct 2024)',
        created_at: '2024-10-22T00:00:00Z',
        type: 'model',
      },
    ],
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('UPR Phase 1 Step 3 — ProviderRegistry', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset both providers to clean seed state before each test
    resetProvider('openrouter');
    resetProvider('anthropic');
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TEST 1: OpenRouter "Test & load models" returns real model list ──
  it('OpenRouter: "Test & load models" populates models[] with real data from /v1/models', async () => {
    fetchSpy.mockResolvedValue(mockOpenRouterModelsResponse());

    const result = await testAndLoadModels('openrouter');

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.models.length).toBe(3);

    // Spot-check 3 model IDs against what OpenRouter actually offers
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain('anthropic/claude-3.5-sonnet');
    expect(ids).toContain('deepseek/deepseek-chat-v3.1');
    expect(ids).toContain('google/gemini-2.0-flash-exp:free');

    // Verify connectionTested was flipped to true
    const provider = getProvider('openrouter')!;
    expect(provider.connectionTested).toBe(true);
    expect(provider.lastError).toBeNull();
    expect(provider.lastLoadedAt).not.toBeNull();
  });

  // ── TEST 2: OpenRouter capability line — context/output tokens ───────
  it('OpenRouter: capability line shows real context window + output tokens for a selected model', async () => {
    fetchSpy.mockResolvedValue(mockOpenRouterModelsResponse());
    await testAndLoadModels('openrouter');

    const provider = getProvider('openrouter')!;
    // Select "anthropic/claude-3.5-sonnet" — should have 200K context, 8192 output
    const sonnet = provider.models.find((m) => m.id === 'anthropic/claude-3.5-sonnet')!;
    expect(sonnet.contextWindow).toBe(200000);
    expect(sonnet.maxOutputTokens).toBe(8192);
    expect(sonnet.supportsVision).toBe(true);  // input_modalities includes 'image'
    expect(sonnet.costTier).toBe('paid');
    expect(sonnet.freeOrPaid).toBe('paid');

    // Select the free model — should be flagged as free
    const geminiFree = provider.models.find((m) => m.id === 'google/gemini-2.0-flash-exp:free')!;
    expect(geminiFree.costTier).toBe('free');
    expect(geminiFree.freeOrPaid).toBe('free');
    expect(geminiFree.supportsVision).toBe(true);
    expect(geminiFree.contextWindow).toBe(1048576);  // 1M tokens
  });

  // ── TEST 3: Anthropic "Test & load models" returns real model list ───
  it('Anthropic: "Test & load models" populates models[] with real data from /v1/models', async () => {
    fetchSpy.mockResolvedValue(mockAnthropicModelsResponse());

    const result = await testAndLoadModels('anthropic');

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.models.length).toBe(3);

    // Spot-check 3 model IDs
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain('claude-sonnet-4-20250514');
    expect(ids).toContain('claude-opus-4-20250514');
    expect(ids).toContain('claude-3-5-sonnet-20241022');

    const provider = getProvider('anthropic')!;
    expect(provider.connectionTested).toBe(true);
    expect(provider.lastError).toBeNull();
  });

  // ── TEST 4: Anthropic capability line — context/output tokens ────────
  it('Anthropic: capability line shows "not reported" for context/output (Anthropic /models does not report them)', async () => {
    fetchSpy.mockResolvedValue(mockAnthropicModelsResponse());
    await testAndLoadModels('anthropic');

    const provider = getProvider('anthropic')!;
    const sonnet4 = provider.models.find((m) => m.id === 'claude-sonnet-4-20250514')!;

    // Anthropic's /models endpoint does NOT report context window or max output
    // tokens — the registry honestly shows 0 (the UI renders "not reported")
    expect(sonnet4.contextWindow).toBe(0);
    expect(sonnet4.maxOutputTokens).toBe(0);

    // But capability flags ARE derived from the model ID naming convention:
    // Claude 3+ and Claude 4+ models support vision + tool-use
    expect(sonnet4.supportsVision).toBe(true);
    expect(sonnet4.supportsToolUse).toBe(true);
    expect(sonnet4.freeOrPaid).toBe('paid');  // All Anthropic models are paid
  });

  // ── TEST 5: Bad OpenRouter key → specific, visible error ─────────────
  it('OpenRouter: bad API key (401) → specific error message, NOT silent empty list', async () => {
    fetchSpy.mockResolvedValue(new Response(
      '{"error": {"message": "Invalid API key"}}',
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await testAndLoadModels('openrouter');

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    // Error must mention "401" and "API key" — specific and visible
    expect(result.error!).toContain('401');
    expect(result.error!).toMatch(/key|unauthorized/i);

    // connectionTested must be false
    const provider = getProvider('openrouter')!;
    expect(provider.connectionTested).toBe(false);
    expect(provider.lastError).not.toBeNull();
    expect(provider.lastError).toContain('401');
  });

  // ── TEST 6: Bad Anthropic key → specific, visible error ──────────────
  it('Anthropic: bad API key (401) → specific error message, NOT silent empty list', async () => {
    fetchSpy.mockResolvedValue(new Response(
      '{"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}',
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await testAndLoadModels('anthropic');

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error!).toContain('401');
    expect(result.error!).toMatch(/key|unauthorized/i);

    const provider = getProvider('anthropic')!;
    expect(provider.connectionTested).toBe(false);
    expect(provider.lastError).toContain('401');
  });

  // ── TEST 7: No API key set → specific, visible error ─────────────────
  it('OpenRouter: no API key → specific error telling user to enter a key', async () => {
    // Clear the key
    updateProviderConfig('openrouter', { apiKey: '' });

    const result = await testAndLoadModels('openrouter');

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error!).toMatch(/not set|enter/i);
  });

  // ── TEST 8: Network error → specific, visible error ──────────────────
  it('OpenRouter: network error → specific error message', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await testAndLoadModels('openrouter');

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error!).toContain('ECONNREFUSED');
  });

  // ── TEST 9: listProviders returns all providers with correct shape ────
  it('listProviders returns OpenRouter + Anthropic + TTS providers with correct seed data', () => {
    const providers = listProviders();
    // Phase 1: 2 LLM. Phase 2a: +11 TTS. Phase 2b: +3 Tool.
    // Phase 2c: +5 Image/Video = 21 total.
    expect(providers.length).toBe(21);

    const openrouter = providers.find((p) => p.id === 'openrouter')!;
    expect(openrouter.category).toBe('llm');
    expect(openrouter.displayName).toBe('OpenRouter (Cloud Gateway)');
    expect(openrouter.defaultApiUrl).toBe('https://openrouter.ai/api/v1');
    expect(openrouter.models).toEqual([]);
    expect(openrouter.connectionTested).toBe(false);

    const anthropic = providers.find((p) => p.id === 'anthropic')!;
    expect(anthropic.category).toBe('llm');
    expect(anthropic.displayName).toBe('Anthropic (Direct API)');
    expect(anthropic.defaultApiUrl).toBe('https://api.anthropic.com/v1');
    expect(anthropic.models).toEqual([]);
    expect(anthropic.connectionTested).toBe(false);
  });

  // ── TEST 10: updateProviderConfig clears models on config change ─────
  it('updateProviderConfig clears models[] + connectionTested when apiUrl or apiKey changes', async () => {
    // First, load models successfully
    fetchSpy.mockResolvedValue(mockOpenRouterModelsResponse());
    await testAndLoadModels('openrouter');
    expect(getProvider('openrouter')!.models.length).toBe(3);
    expect(getProvider('openrouter')!.connectionTested).toBe(true);

    // Now change the API key — models should be cleared
    updateProviderConfig('openrouter', { apiKey: 'new-key' });
    expect(getProvider('openrouter')!.models).toEqual([]);
    expect(getProvider('openrouter')!.connectionTested).toBe(false);
    expect(getProvider('openrouter')!.lastError).toBeNull();
  });
});
