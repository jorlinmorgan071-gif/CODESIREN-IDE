// server/src/provider-registry/providers/image-video.ts
//
// Seed definitions for IMAGE-VIDEO providers.
// Extracted from registry.ts (task 04 — split god files).
// Each entry is a ProviderRegistryEntry with an empty models[] array —
// the "Test & load" action populates it at runtime from the provider's
// real /models endpoint.

import { config } from '../../config.js';
import type { ProviderRegistryEntry } from '../types.js';


// ── Seed entries ────────────────────────────────────────────────────────

export function seedImageVideoProviders(): ProviderRegistryEntry[] {
  return [
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
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
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
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
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
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
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
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
    },
    {
      id: 'byteplus-seedream',
      category: 'image-video',
      displayName: 'BytePlus Seedream (Image Generation)',
      defaultApiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: process.env.BYTEPLUS_API_KEY ?? process.env.DOUBAO_API_KEY ?? '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
    }
  ];
}
