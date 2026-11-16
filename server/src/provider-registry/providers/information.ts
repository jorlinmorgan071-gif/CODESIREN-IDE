// server/src/provider-registry/providers/information.ts
//
// Seed definitions for INFORMATION providers.
// Extracted from registry.ts (task 04 — split god files).
// Each entry is a ProviderRegistryEntry with an empty models[] array —
// the "Test & load" action populates it at runtime from the provider's
// real /models endpoint.

import { config } from '../../config.js';
import type { ProviderRegistryEntry } from '../types.js';


// ── Seed entries ────────────────────────────────────────────────────────

export function seedInformationProviders(): ProviderRegistryEntry[] {
  return [
// Read-only data APIs — NewsAPI, OpenWeatherMap, AlphaVantage. The system
    // uses these to fetch real-time information for agents + chat.
    {
      id: 'newsapi',
      category: 'information',
      displayName: 'NewsAPI (News Headlines)',
      defaultApiUrl: 'https://newsapi.org/v2',
      apiUrl: 'https://newsapi.org/v2',
      apiKey: process.env.NEWSAPI_KEY ?? process.env.NEWS_API_KEY ?? '',
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
      id: 'openweather',
      category: 'information',
      displayName: 'OpenWeatherMap (Weather Data)',
      defaultApiUrl: 'https://api.openweathermap.org/data/2.5',
      apiUrl: 'https://api.openweathermap.org/data/2.5',
      apiKey: process.env.OPENWEATHER_API_KEY ?? process.env.OPENWEATHERMAP_API_KEY ?? '',
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
      id: 'alphavantage',
      category: 'information',
      displayName: 'Alpha Vantage (Stock Market Data)',
      defaultApiUrl: 'https://www.alphavantage.co/query',
      apiUrl: 'https://www.alphavantage.co/query',
      apiKey: process.env.ALPHAVANTAGE_API_KEY ?? process.env.ALPHA_VANTAGE_API_KEY ?? '',
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
