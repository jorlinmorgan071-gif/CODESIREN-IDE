// server/src/provider-registry/providers/tool.ts
//
// Seed definitions for TOOL providers.
// Extracted from registry.ts (task 04 — split god files).
// Each entry is a ProviderRegistryEntry with an empty models[] array —
// the "Test & load" action populates it at runtime from the provider's
// real /models endpoint.

import { config } from '../../config.js';
import type { ProviderRegistryEntry } from '../types.js';


// ── Seed entries ────────────────────────────────────────────────────────

export function seedToolProviders(): ProviderRegistryEntry[] {
  return [
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
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
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
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
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
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
    },
    // Whisper — local neural ASR (transcription, NOT TTS).
    // Uses faster-whisper (CTranslate2-backed) running in a Python sidecar.
    // Installed via the same installer flow as Kokoro (Phase 3+).
    // Category is 'tool' (it's a transcription tool, not TTS output).
    {
      id: 'whisper',
      category: 'tool',
      displayName: 'Whisper (Local — speech-to-text)',
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
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
    }
  ];
}
