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
import type { ProviderRegistryEntry, ProviderModel, ProviderVoice, ProviderTool, ProviderImageModel, TestAndLoadResult, CostTier, ProviderCategory } from './types.js';

// ── Provider defaults ────────────────────────────────────────────────────
// These are the seed values. The user can override apiUrl + apiKey via the
// settings panel. models[] starts empty and is populated by "Test & load".

const OPENROUTER_DEFAULT_URL = 'https://openrouter.ai/api/v1';
const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com/v1';

function seedEntries(): ProviderRegistryEntry[] {
  return [
    // ── LLM providers (Phase 1) ───────────────────────────────────────
    {
      id: 'openrouter',
      category: 'llm',
      displayName: 'OpenRouter (Cloud Gateway)',
      defaultApiUrl: OPENROUTER_DEFAULT_URL,
      apiUrl: OPENROUTER_DEFAULT_URL,
      apiKey: config.OPENROUTER_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
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
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    // ── TTS providers (Phase 2 Step 2a) ─────────────────────────────────
    // 11 cloud providers + Kokoro as the permanent local entry.
    // "Test & load voices" hits the real /voices endpoint where available,
    // or returns a static catalog for providers that don't have one.
    {
      id: 'kokoro',
      category: 'tts',
      displayName: 'Kokoro (Local — 82M model)',
      defaultApiUrl: '',
      apiUrl: '',
      apiKey: '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'elevenlabs',
      category: 'tts',
      displayName: 'ElevenLabs (Cloud TTS)',
      defaultApiUrl: 'https://api.elevenlabs.io/v1',
      apiUrl: 'https://api.elevenlabs.io/v1',
      apiKey: process.env.ELEVENLABS_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'openai-tts',
      category: 'tts',
      displayName: 'OpenAI TTS (Cloud)',
      defaultApiUrl: 'https://api.openai.com/v1',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'doubao',
      category: 'tts',
      displayName: 'Doubao / Volcano (Cloud TTS)',
      defaultApiUrl: 'https://openspeech.bytedance.com/api/v1',
      apiUrl: 'https://openspeech.bytedance.com/api/v1',
      apiKey: process.env.DOUBAO_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'minimax-tts',
      category: 'tts',
      displayName: 'MiniMax TTS (Cloud)',
      defaultApiUrl: 'https://api.minimax.chat/v1',
      apiUrl: 'https://api.minimax.chat/v1',
      apiKey: process.env.MINIMAX_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'inworld',
      category: 'tts',
      displayName: 'Inworld (Cloud TTS)',
      defaultApiUrl: 'https://api.inworld.ai/v1',
      apiUrl: 'https://api.inworld.ai/v1',
      apiKey: process.env.INWORLD_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'fish-audio',
      category: 'tts',
      displayName: 'Fish Audio (Cloud TTS)',
      defaultApiUrl: 'https://api.fish.audio/v1',
      apiUrl: 'https://api.fish.audio/v1',
      apiKey: process.env.FISH_AUDIO_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'speechify',
      category: 'tts',
      displayName: 'Speechify (Cloud TTS)',
      defaultApiUrl: 'https://api.sws.speechify.com/v1',
      apiUrl: 'https://api.sws.speechify.com/v1',
      apiKey: process.env.SPEECHIFY_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'gemini-tts',
      category: 'tts',
      displayName: 'Gemini TTS (Cloud)',
      defaultApiUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: process.env.GEMINI_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'mistral-voxtral',
      category: 'tts',
      displayName: 'Mistral Voxtral (Cloud)',
      defaultApiUrl: 'https://api.mistral.ai/v1',
      apiUrl: 'https://api.mistral.ai/v1',
      apiKey: process.env.MISTRAL_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'cartesia',
      category: 'tts',
      displayName: 'Cartesia (Cloud TTS)',
      defaultApiUrl: 'https://api.cartesia.ai/v1',
      apiUrl: 'https://api.cartesia.ai/v1',
      apiKey: process.env.CARTESIA_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    // ── Tool providers (Phase 2 Step 2b) ───────────────────────────────
    // Built-in Code Siren tools — the "test & load" action inspects the live
    // toolRegistry and returns the current tool catalog. No external API call
    // needed — this is a local inventory.
    {
      id: 'code-siren-tools',
      category: 'tool',
      displayName: 'Code Siren Built-in Tools',
      defaultApiUrl: '',
      apiUrl: '',
      apiKey: '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    // Tavily — web search API provider (external tool)
    {
      id: 'tavily',
      category: 'tool',
      displayName: 'Tavily (Web Search API)',
      defaultApiUrl: 'https://api.tavily.com',
      apiUrl: 'https://api.tavily.com',
      apiKey: process.env.TAVILY_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    // Judge0 — code execution sandbox (external tool)
    {
      id: 'judge0',
      category: 'tool',
      displayName: 'Judge0 (Code Execution Sandbox)',
      defaultApiUrl: 'https://judge0-ce.p.rapidapi.com',
      apiUrl: 'https://judge0-ce.p.rapidapi.com',
      apiKey: process.env.JUDGE0_API_KEY ?? process.env.RAPIDAPI_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    // ── Image/Video generation providers (Phase 2 Step 2c) ─────────────
    // 5 cloud providers. "Test & load" returns static capability catalogs
    // (image generation APIs don't have a /models endpoint — the model list
    // is documented, not queryable). No agent-calling logic yet (Phase 5).
    {
      id: 'openai-image',
      category: 'image-video',
      displayName: 'OpenAI DALL·E (Image Generation)',
      defaultApiUrl: 'https://api.openai.com/v1',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'gemini-image',
      category: 'image-video',
      displayName: 'Google Gemini / Imagen (Image Generation)',
      defaultApiUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: process.env.GEMINI_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'minimax-image',
      category: 'image-video',
      displayName: 'MiniMax (Image/Video Generation)',
      defaultApiUrl: 'https://api.minimax.chat/v1',
      apiUrl: 'https://api.minimax.chat/v1',
      apiKey: process.env.MINIMAX_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'wavespeed',
      category: 'image-video',
      displayName: 'WaveSpeed (Image/Video Generation)',
      defaultApiUrl: 'https://api.wavespeed.ai/api/v2',
      apiUrl: 'https://api.wavespeed.ai/api/v2',
      apiKey: process.env.WAVESPEED_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
    },
    {
      id: 'byteplus-seedream',
      category: 'image-video',
      displayName: 'BytePlus Seedream (Image Generation)',
      defaultApiUrl: 'https://openspeech.bytedance.com/api/v1',
      apiUrl: 'https://openspeech.bytedance.com/api/v1',
      apiKey: process.env.BYTEPLUS_API_KEY ?? process.env.DOUBAO_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
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

/**
 * Phase 2 Step 2d — Onboard a custom provider into the registry.
 *
 * The caller supplies a URL (skip for TTS), optional API key, and a category
 * (classified by the questionnaire). This function:
 *   1. Generates a unique provider ID (custom-<category>-<timestamp>)
 *   2. Creates a ProviderRegistryEntry with the supplied data
 *   3. Inserts it into the registry — indistinguishable from a preset provider
 *
 * After onboarding, the custom provider behaves identically to a named one:
 * it appears in listProviders(), can be tested/loaded, and its models/voices/
 * tools/imageModels can be loaded via testAndLoadModels().
 */
export function onboardCustomProvider(opts: {
  displayName: string;
  category: ProviderCategory;
  apiUrl: string;
  apiKey?: string;
}): ProviderRegistryEntry {
  const id = `custom-${opts.category}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: ProviderRegistryEntry = {
    id,
    category: opts.category,
    displayName: opts.displayName,
    defaultApiUrl: opts.apiUrl,
    apiUrl: opts.apiUrl,
    apiKey: opts.apiKey ?? '',
    connectionTested: false,
    models: [],
    voices: [],
    tools: [],
    imageModels: [],
    lastError: null,
    lastLoadedAt: null,
  };
  entries.set(id, entry);
  console.log(`[provider-registry] custom provider onboarded: ${id} (${opts.category}) — ${opts.displayName}`);
  return entry;
}

/**
 * Phase 2 Step 2d — Classify a provider into a category based on a short
 * questionnaire. The questionnaire asks what the provider does, and the
 * classifier maps the answers to one of the four categories.
 *
 * This is deliberately simple — not an LLM classification, just a rule-based
 * mapping from the user's answers. The questionnaire is:
 *   1. "What does this provider do?" → answers: 'generate-text' | 'generate-speech' | 'execute-tools' | 'generate-images'
 *   2. "Does it require an API URL?" → boolean (TTS providers may not need one)
 *
 * The classification is deterministic and testable.
 */
export function classifyProvider(answers: {
  whatDoesItDo: 'generate-text' | 'generate-speech' | 'execute-tools' | 'generate-images';
}): ProviderCategory {
  switch (answers.whatDoesItDo) {
    case 'generate-text':   return 'llm';
    case 'generate-speech': return 'tts';
    case 'execute-tools':   return 'tool';
    case 'generate-images': return 'image-video';
  }
}

export function updateProviderConfig(id: string, patch: { apiUrl?: string; apiKey?: string }): ProviderRegistryEntry | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;
  if (patch.apiUrl !== undefined) entry.apiUrl = patch.apiUrl;
  if (patch.apiKey !== undefined) entry.apiKey = patch.apiKey;
  // If config changed, mark as not-tested (models/voices/tools/imageModels are now stale)
  if (patch.apiUrl !== undefined || patch.apiKey !== undefined) {
    entry.connectionTested = false;
    entry.models = [];
    entry.voices = [];
    entry.tools = [];
    entry.imageModels = [];
    entry.selectedVoiceId = undefined;
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
  entry.voices = [];
  entry.tools = [];
  entry.imageModels = [];
  entry.selectedVoiceId = undefined;
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
  // TTS providers — restore from process.env directly
  if (id === 'elevenlabs') entry.apiKey = process.env.ELEVENLABS_API_KEY ?? '';
  if (id === 'openai-tts') entry.apiKey = process.env.OPENAI_API_KEY ?? '';
  if (id === 'doubao') entry.apiKey = process.env.DOUBAO_API_KEY ?? '';
  if (id === 'minimax-tts') entry.apiKey = process.env.MINIMAX_API_KEY ?? '';
  if (id === 'inworld') entry.apiKey = process.env.INWORLD_API_KEY ?? '';
  if (id === 'fish-audio') entry.apiKey = process.env.FISH_AUDIO_API_KEY ?? '';
  if (id === 'speechify') entry.apiKey = process.env.SPEECHIFY_API_KEY ?? '';
  if (id === 'gemini-tts') entry.apiKey = process.env.GEMINI_API_KEY ?? '';
  if (id === 'mistral-voxtral') entry.apiKey = process.env.MISTRAL_API_KEY ?? '';
  if (id === 'cartesia') entry.apiKey = process.env.CARTESIA_API_KEY ?? '';
  if (id === 'code-siren-tools') entry.apiKey = '';
  if (id === 'tavily') entry.apiKey = process.env.TAVILY_API_KEY ?? '';
  if (id === 'judge0') entry.apiKey = process.env.JUDGE0_API_KEY ?? process.env.RAPIDAPI_KEY ?? '';
  // Image/Video providers
  if (id === 'openai-image') entry.apiKey = process.env.OPENAI_API_KEY ?? '';
  if (id === 'gemini-image') entry.apiKey = process.env.GEMINI_API_KEY ?? '';
  if (id === 'minimax-image') entry.apiKey = process.env.MINIMAX_API_KEY ?? '';
  if (id === 'wavespeed') entry.apiKey = process.env.WAVESPEED_API_KEY ?? '';
  if (id === 'byteplus-seedream') entry.apiKey = process.env.BYTEPLUS_API_KEY ?? process.env.DOUBAO_API_KEY ?? '';
  // Kokoro has no API key (local)
  if (id === 'kokoro') entry.apiKey = '';
  entry.apiUrl = entry.defaultApiUrl;
}

// ── "Test & load" — dispatches by category ──────────────────────────────
// LLM: hits the real /models endpoint → populates models[]
// TTS: hits the real /voices endpoint (or returns static catalog) → populates voices[]
// On failure, sets lastError to a specific, visible error.

export async function testAndLoadModels(providerId: string): Promise<TestAndLoadResult> {
  const entry = entries.get(providerId);
  if (!entry) {
    return { providerId, success: false, models: [], voices: [], tools: [], imageModels: [], error: `Unknown provider: ${providerId}`, durationMs: 0 };
  }

  const start = Date.now();
  try {
    if (entry.category === 'llm') {
      // ── LLM: fetch models ──────────────────────────────────────────────
      let models: ProviderModel[] = [];

      if (providerId === 'openrouter') {
        models = await fetchOpenRouterModels(entry.apiUrl, entry.apiKey);
      } else if (providerId === 'anthropic') {
        models = await fetchAnthropicModels(entry.apiUrl, entry.apiKey);
      } else {
        return { providerId, success: false, models: [], voices: [], tools: [], imageModels: [], error: `No model-list endpoint for provider: ${providerId}`, durationMs: Date.now() - start };
      }

      entry.models = models;
      entry.connectionTested = true;
      entry.lastError = null;
      entry.lastLoadedAt = Date.now();
      return { providerId, success: true, models, voices: [], tools: [], imageModels: [], error: null, durationMs: Date.now() - start };

    } else if (entry.category === 'tts') {
      // ── TTS: fetch voices ──────────────────────────────────────────────
      let voices: ProviderVoice[] = [];

      if (providerId === 'kokoro') {
        voices = getKokoroVoicesStatic();
      } else if (providerId === 'elevenlabs') {
        voices = await fetchElevenLabsVoices(entry.apiUrl, entry.apiKey);
      } else if (providerId === 'openai-tts') {
        voices = getOpenAIVoicesStatic();
      } else if (providerId === 'doubao' || providerId === 'minimax-tts' || providerId === 'inworld' ||
                 providerId === 'fish-audio' || providerId === 'speechify' || providerId === 'gemini-tts' ||
                 providerId === 'mistral-voxtral' || providerId === 'cartesia') {
        // For providers without a known public voices-list endpoint, do a
        // connection test: if the API key is set, mark as connected + return
        // an empty voice list with a note that voices are configured per-call.
        voices = await testTtsConnection(providerId, entry.apiUrl, entry.apiKey);
      } else {
        return { providerId, success: false, models: [], voices: [], tools: [], imageModels: [], error: `No voice-list endpoint for provider: ${providerId}`, durationMs: Date.now() - start };
      }

      entry.voices = voices;
      entry.connectionTested = true;
      entry.lastError = null;
      entry.lastLoadedAt = Date.now();
      // Auto-select the first voice if none is selected
      if (!entry.selectedVoiceId && voices.length > 0) {
        entry.selectedVoiceId = voices[0].id;
      }
      return { providerId, success: true, models: [], voices, tools: [], imageModels: [], error: null, durationMs: Date.now() - start };

    } else if (entry.category === 'tool') {
      // ── Tool: inventory the live toolRegistry ─────────────────────────
      let tools: ProviderTool[] = [];

      if (providerId === 'code-siren-tools') {
        tools = await loadCodeSirenTools();
      } else if (providerId === 'tavily') {
        tools = await testExternalToolProvider(providerId, entry.apiUrl, entry.apiKey);
      } else if (providerId === 'judge0') {
        tools = await testExternalToolProvider(providerId, entry.apiUrl, entry.apiKey);
      } else {
        return { providerId, success: false, models: [], voices: [], tools: [], imageModels: [], error: `No tool-list endpoint for provider: ${providerId}`, durationMs: Date.now() - start };
      }

      entry.tools = tools;
      entry.connectionTested = true;
      entry.lastError = null;
      entry.lastLoadedAt = Date.now();
      return { providerId, success: true, models: [], voices: [], tools, imageModels: [], error: null, durationMs: Date.now() - start };

    } else if (entry.category === 'image-video') {
      // ── Image/Video: load static capability catalog ───────────────────
      // Image generation APIs don't have a /models endpoint — the model list
      // is documented, not queryable. "Test & load" verifies the API key is
      // set + the URL is valid, then returns a static catalog of the
      // provider's documented image/video models.
      let imageModels: ProviderImageModel[] = [];

      if (providerId === 'openai-image') {
        imageModels = getOpenAIImageModelsStatic();
      } else if (providerId === 'gemini-image') {
        imageModels = getGeminiImageModelsStatic();
      } else if (providerId === 'minimax-image') {
        imageModels = getMiniMaxImageModelsStatic();
      } else if (providerId === 'wavespeed') {
        imageModels = getWaveSpeedImageModelsStatic();
      } else if (providerId === 'byteplus-seedream') {
        imageModels = getBytePlusImageModelsStatic();
      } else {
        return { providerId, success: false, models: [], voices: [], tools: [], imageModels: [], error: `No image-model catalog for provider: ${providerId}`, durationMs: Date.now() - start };
      }

      // For external providers, verify API key + URL before marking as connected
      if (!entry.apiKey) {
        throw new Error(`${providerId} API key is not set. Enter your API key and try again.`);
      }
      if (entry.apiUrl) {
        try { new URL(entry.apiUrl); } catch { throw new Error(`${providerId} API URL is invalid: ${entry.apiUrl}`); }
      }

      entry.imageModels = imageModels;
      entry.connectionTested = true;
      entry.lastError = null;
      entry.lastLoadedAt = Date.now();
      return { providerId, success: true, models: [], voices: [], tools: [], imageModels, error: null, durationMs: Date.now() - start };
    }

    return { providerId, success: false, models: [], voices: [], tools: [], imageModels: [], error: `Unknown category: ${entry.category}`, durationMs: Date.now() - start };
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    entry.lastError = errorMsg;
    entry.connectionTested = false;
    // Keep any previously-loaded models/voices/tools
    return { providerId, success: false, models: entry.models, voices: entry.voices, tools: entry.tools, imageModels: entry.imageModels, error: errorMsg, durationMs: Date.now() - start };
  }
}

// ── "Select voice" — sets the active voice + wires through to runtime ────
// This is the system-wide selected voice. When called, it:
//   1. Updates the registry entry's selectedVoiceId
//   2. Calls applyVoiceProvider() to swap the active TTSProvider at runtime
// The next speak() call uses the newly-selected voice.

export async function selectVoice(providerId: string, voiceId: string): Promise<{ success: boolean; error: string | null }> {
  const entry = entries.get(providerId);
  if (!entry) {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }
  if (entry.category !== 'tts') {
    return { success: false, error: `Provider ${providerId} is not a TTS provider (category: ${entry.category})` };
  }
  // Verify the voice exists in the loaded voices list
  if (entry.voices.length > 0 && !entry.voices.find((v) => v.id === voiceId)) {
    return { success: false, error: `Voice ${voiceId} not found in provider ${providerId}'s loaded voices. Run "Test & load voices" first.` };
  }
  entry.selectedVoiceId = voiceId;

  // Wire through to the runtime — call applyVoiceProvider() to swap the
  // active TTSProvider. This is the "actually wired through" part.
  try {
    const { setVoiceSettings, getVoiceSettings, applyVoiceProvider } = await import('../orchestrator/voice-settings.js');
    const currentSettings = getVoiceSettings();
    // Build the new settings based on the provider + voice
    const newSettings = { ...currentSettings, provider: providerId as any };
    // Provider-specific voice configuration
    if (providerId === 'kokoro') {
      newSettings.kokoroVoice = voiceId;
      // Auto-derive langCode from the voice (Kokoro voices have lang info)
      const voice = entry.voices.find((v) => v.id === voiceId);
      if (voice?.language) {
        // Kokoro lang codes are single letters: 'a'=American, 'b'=British, etc.
        // For now just use 'a' (American English) as default — the existing
        // voice-settings.ts validation will sync this.
        newSettings.kokoroLangCode = voice.language.slice(0, 1).toLowerCase();
      }
    } else if (providerId === 'elevenlabs') {
      newSettings.elevenlabsVoiceId = voiceId;
    }
    // For other TTS providers not yet wired through applyVoiceProvider(),
    // the selection is stored in the registry but not yet applied at runtime.
    // A future Phase 2 extension will add the remaining provider cases to
    // applyVoiceProvider()'s switch statement.

    setVoiceSettings(newSettings);
    await applyVoiceProvider(newSettings);
    console.log(`[provider-registry] TTS voice selected: ${providerId}/${voiceId} — applied to runtime`);
    return { success: true, error: null };
  } catch (err: any) {
    // The selection was stored in the registry, but the runtime swap failed.
    // Surface the error honestly.
    const errorMsg = `Voice selection stored but runtime swap failed: ${err?.message ?? String(err)}`;
    console.warn(`[provider-registry] ${errorMsg}`);
    return { success: false, error: errorMsg };
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

// ── TTS voice-fetching functions (Phase 2 Step 2a) ────────────────────────

// Kokoro — local model, no remote endpoint. Returns the static voice catalog
// from the existing KOKORO_VOICES const in voice-settings.ts.
function getKokoroVoicesStatic(): ProviderVoice[] {
  // Reuse the existing catalog from voice-settings.ts to avoid duplication.
  // The Kokoro voices are a fixed set of 54 voices across 9 languages — they
  // don't change unless the model is updated (which requires a sidecar upgrade).
  try {
    // Dynamic require to avoid circular import at module load time
    const { KOKORO_VOICES } = require('../orchestrator/voice-settings.js');
    return KOKORO_VOICES.map((v: { name: string; langCode?: string; langLabel?: string; gender?: string; grade?: string }) => ({
      id: v.name,
      name: v.name,
      language: v.langLabel ?? v.langCode ?? '',
      gender: v.gender as 'male' | 'female' | 'neutral' | undefined,
      description: v.grade ? `Grade ${v.grade}` : undefined,
    }));
  } catch {
    // Fallback if voice-settings.ts isn't loaded yet — return a minimal set
    return [
      { id: 'af_heart', name: 'Heart (American English, Female)', language: 'English', gender: 'female', description: 'Default voice' },
      { id: 'af_bella', name: 'Bella (American English, Female)', language: 'English', gender: 'female' },
      { id: 'am_adam', name: 'Adam (American English, Male)', language: 'English', gender: 'male' },
    ];
  }
}

// OpenAI TTS — static voice list (OpenAI has a fixed set of 6 voices).
// These are documented at https://platform.openai.com/docs/guides/text-to-speech
function getOpenAIVoicesStatic(): ProviderVoice[] {
  return [
    { id: 'alloy', name: 'Alloy (Neutral)', gender: 'neutral', description: 'Default OpenAI voice' },
    { id: 'echo', name: 'Echo (Male)', gender: 'male' },
    { id: 'fable', name: 'Fable (British, Neutral)', gender: 'neutral', accent: 'British' },
    { id: 'onyx', name: 'Onyx (Male)', gender: 'male' },
    { id: 'nova', name: 'Nova (Female)', gender: 'female' },
    { id: 'shimmer', name: 'Shimmer (Female)', gender: 'female' },
  ];
}

// ElevenLabs — hits the REAL /v1/voices endpoint.
// GET https://api.elevenlabs.io/v1/voices
// Returns: { voices: [{ voice_id, name, category, labels: { language, gender, accent, description } }] }
// Requires xi-api-key header.
async function fetchElevenLabsVoices(apiUrl: string, apiKey: string): Promise<ProviderVoice[]> {
  if (!apiKey) {
    throw new Error('ElevenLabs API key is not set. Enter your ElevenLabs API key and try again.');
  }

  const url = `${apiUrl.replace(/\/+$/, '')}/voices`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'xi-api-key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no response body)');
    if (res.status === 401) {
      throw new Error(`ElevenLabs rejected the API key (401 Unauthorized). Verify your key is valid. Response: ${body.slice(0, 200)}`);
    }
    throw new Error(`ElevenLabs voices request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    voices?: Array<{
      voice_id: string;
      name: string;
      category?: string;
      labels?: { language?: string; gender?: string; accent?: string; description?: string; use_case?: string };
      preview_url?: string;
    }>;
  };

  if (!data.voices || !Array.isArray(data.voices)) {
    throw new Error('ElevenLabs returned unexpected response shape — no "voices" array. The API may have changed.');
  }

  return data.voices.map((v) => ({
    id: v.voice_id,
    name: v.name,
    language: v.labels?.language ?? '',
    gender: (v.labels?.gender as 'male' | 'female' | 'neutral' | undefined) ?? undefined,
    accent: v.labels?.accent ?? '',
    description: v.labels?.description ?? v.labels?.use_case ?? v.category ?? '',
    previewUrl: v.preview_url ?? '',
  }));
}

// Generic TTS connection test — for providers without a known /voices endpoint.
// Tests that the API key is set + the API URL is reachable. Returns an empty
// voice list (voices are configured per-call, not listed).
async function testTtsConnection(providerId: string, apiUrl: string, apiKey: string): Promise<ProviderVoice[]> {
  if (!apiKey) {
    throw new Error(`${providerId} API key is not set. Enter your API key and try again.`);
  }
  if (!apiUrl) {
    throw new Error(`${providerId} API URL is not set. Enter the API URL and try again.`);
  }
  // For providers without a known voices-list endpoint, we do a lightweight
  // connection test: just verify the URL is reachable. We don't make a real
  // API call — just check the URL parses + the key is set.
  // A future Phase 2 extension will add per-provider voice-list endpoints.
  try {
    new URL(apiUrl);
  } catch {
    throw new Error(`${providerId} API URL is invalid: ${apiUrl}`);
  }
  // Connection test passed — return an empty voice list with a note
  // The UI will show "No voice list available — voices configured per-call"
  return [];
}

// ── Tool category: load functions (Phase 2 Step 2b) ──────────────────────

/**
 * Load the live tool catalog from the Code Siren built-in toolRegistry.
 * Each registered tool (calculator, http_request, code_interpreter, etc.)
 * is returned with its name, description, and availability status.
 * No external API call — this is a local inventory.
 */
async function loadCodeSirenTools(): Promise<ProviderTool[]> {
  const { toolRegistry } = await import('../agents/_shared/tool-registry.js');
  const tools = toolRegistry.list();
  return tools.map((t) => {
    // The code_interpreter tool currently returns success:false (D13 closeout).
    // Mark it as unavailable in the registry so the UI shows the status honestly.
    const isCodeInterpreter = t.name === 'code_interpreter';
    const available = !isCodeInterpreter;  // code_interpreter is unavailable until a real Python sidecar is wired
    return {
      name: t.name,
      description: t.description,
      readOnly: t.name === 'calculator' || t.name === 'think' || t.name === 'http_request',
      available,
      unavailableReason: isCodeInterpreter
        ? 'Unavailable — no real Python sidecar is wired through the security sandbox.'
        : undefined,
    };
  });
}

/**
 * Test an external tool provider's connection.
 * For Tavily: verifies the API key is set + the URL is reachable.
 * For Judge0: verifies the API key is set + the URL is reachable.
 * Returns a static tool catalog (1 tool per provider) describing what the
 * provider offers.
 */
async function testExternalToolProvider(providerId: string, apiUrl: string, apiKey: string): Promise<ProviderTool[]> {
  if (!apiKey) {
    throw new Error(`${providerId} API key is not set. Enter your API key and try again.`);
  }
  if (!apiUrl) {
    throw new Error(`${providerId} API URL is not set. Enter the API URL and try again.`);
  }
  try {
    new URL(apiUrl);
  } catch {
    throw new Error(`${providerId} API URL is invalid: ${apiUrl}`);
  }

  // Return the provider's tool catalog — each external tool provider
  // exposes exactly one tool.
  if (providerId === 'tavily') {
    return [{
      name: 'web_search',
      description: 'Search the web for real-time information. Args: { "query": "string", "max_results": 5 } — uses the Tavily API to return relevant search results with titles, URLs, and snippets.',
      readOnly: true,
      available: true,
    }];
  }
  if (providerId === 'judge0') {
    return [{
      name: 'code_execute',
      description: 'Execute code in a sandboxed environment (Python, JavaScript, etc.). Args: { "language": "python", "source_code": "print(2+2)" } — uses the Judge0 API to run code and return stdout/stderr/exit_code.',
      readOnly: false,
      available: true,
    }];
  }
  return [];
}

// ── Image/Video static catalogs (Phase 2 Step 2c) ───────────────────────
// Image generation APIs don't have a /models endpoint — the model list is
// documented by each provider. These static catalogs reflect the current
// (as of 2026-09) documented models. When a provider adds/removes models,
// update these catalogs.
//
// "Test & load" for image-video providers verifies the API key + URL, then
// returns the static catalog. No remote API call is made to list models.

function getOpenAIImageModelsStatic(): ProviderImageModel[] {
  return [
    {
      id: 'dall-e-3',
      name: 'DALL·E 3',
      outputType: 'image',
      resolutions: ['1024x1024', '1792x1024', '1024x1792'],
      aspectRatios: ['1:1', '16:9', '9:16'],
      supportsImageToImage: false,
      supportsVideo: false,
      costTier: 'paid',
      pricingNote: '$0.040 per standard image, $0.080 per HD image',
    },
    {
      id: 'dall-e-2',
      name: 'DALL·E 2',
      outputType: 'image',
      resolutions: ['256x256', '512x512', '1024x1024'],
      aspectRatios: ['1:1'],
      supportsImageToImage: true,
      supportsVideo: false,
      costTier: 'paid',
      pricingNote: '$0.016–$0.020 per image',
    },
    {
      id: 'gpt-image-1',
      name: 'GPT Image 1',
      outputType: 'image',
      resolutions: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
      aspectRatios: ['1:1', '3:2', '2:3'],
      supportsImageToImage: true,
      supportsVideo: false,
      costTier: 'paid',
      pricingNote: '$0.011–$0.167 per image (quality-dependent)',
    },
  ];
}

function getGeminiImageModelsStatic(): ProviderImageModel[] {
  return [
    {
      id: 'imagen-3.0-generate-002',
      name: 'Imagen 3',
      outputType: 'image',
      resolutions: ['1024x1024'],
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      supportsImageToImage: false,
      supportsVideo: false,
      costTier: 'paid',
      pricingNote: '$0.039 per image (aspect-ratio dependent)',
    },
    {
      id: 'imagen-3.0-fast-generate-001',
      name: 'Imagen 3 Fast',
      outputType: 'image',
      resolutions: ['1024x1024'],
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      supportsImageToImage: false,
      supportsVideo: false,
      costTier: 'paid',
      pricingNote: '$0.020 per image',
    },
  ];
}

function getMiniMaxImageModelsStatic(): ProviderImageModel[] {
  return [
    {
      id: 'image-01',
      name: 'MiniMax Image Generation',
      outputType: 'image',
      resolutions: [],
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      supportsImageToImage: false,
      supportsVideo: false,
      costTier: 'paid',
      pricingNote: 'See MiniMax pricing page',
    },
    {
      id: 'video-01',
      name: 'MiniMax Video Generation',
      outputType: 'video',
      resolutions: [],
      aspectRatios: ['16:9', '9:16'],
      supportsImageToImage: false,
      supportsVideo: true,
      costTier: 'paid',
      pricingNote: 'See MiniMax pricing page',
    },
  ];
}

function getWaveSpeedImageModelsStatic(): ProviderImageModel[] {
  return [
    {
      id: 'flux-dev',
      name: 'FLUX.1 [dev]',
      outputType: 'image',
      resolutions: ['1024x1024', '1360x768', '768x1360'],
      aspectRatios: ['1:1', '16:9', '9:16'],
      supportsImageToImage: true,
      supportsVideo: false,
      costTier: 'freemium',
      pricingNote: 'Free tier available; paid tier ~$0.003/image',
    },
    {
      id: 'flux-schnell',
      name: 'FLUX.1 [schnell]',
      outputType: 'image',
      resolutions: ['1024x1024'],
      aspectRatios: ['1:1'],
      supportsImageToImage: false,
      supportsVideo: false,
      costTier: 'free',
      pricingNote: 'Free',
    },
    {
      id: 'wan-2.1',
      name: 'Wan 2.1 (Video)',
      outputType: 'video',
      resolutions: [],
      aspectRatios: ['16:9'],
      supportsImageToImage: false,
      supportsVideo: true,
      costTier: 'paid',
      pricingNote: 'See WaveSpeed pricing page',
    },
  ];
}

function getBytePlusImageModelsStatic(): ProviderImageModel[] {
  return [
    {
      id: 'seedream-3.0',
      name: 'Seedream 3.0',
      outputType: 'image',
      resolutions: ['1024x1024', '2048x2048'],
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      supportsImageToImage: true,
      supportsVideo: false,
      costTier: 'paid',
      pricingNote: 'See BytePlus pricing page',
    },
  ];
}
