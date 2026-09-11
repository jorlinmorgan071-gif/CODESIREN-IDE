// server/src/provider-registry/types.ts
// UPR Phase 1 Step 3 — ProviderRegistry data model.
//
// This is the registry shape that the "Test & load models" button populates
// and the settings-panel card renders. Phase 1 scope: LLM category only
// (OpenRouter + Anthropic). Phase 2 will extend to TTS, Tool/MCP, Image/Video.

export type ProviderCategory = 'llm';  // Phase 2 adds 'tts' | 'tool' | 'image-video'

export type CostTier = 'free' | 'freemium' | 'paid';

export interface ProviderModel {
  /** The model ID as the provider expects it (e.g. 'anthropic/claude-3.5-sonnet'). */
  id: string;
  /** Human-readable display name (e.g. 'Claude 3.5 Sonnet'). */
  name: string;
  /** Context window in tokens (e.g. 200000). 0 if the provider doesn't report it. */
  contextWindow: number;
  /** Max output tokens (e.g. 8192). 0 if not reported. */
  maxOutputTokens: number;
  /** Cost tier — 'free' if the provider reports $0 prompt + $0 completion. */
  costTier: CostTier;
  /** Free or paid? Derived from costTier for convenience. */
  freeOrPaid: 'free' | 'paid';
  /** Vision capability — true if the provider reports the model can process images. */
  supportsVision: boolean;
  /** Tool-use / function-calling capability — true if the provider reports it. */
  supportsToolUse: boolean;
  /** Raw pricing string from the provider (e.g. '$3/MTok input, $15/MTok output'). Empty if not reported. */
  pricingNote: string;
}

export interface ProviderRegistryEntry {
  /** Unique provider ID (e.g. 'openrouter', 'anthropic'). */
  id: string;
  /** Category — 'llm' for Phase 1. */
  category: ProviderCategory;
  /** Human-readable display name (e.g. 'OpenRouter (Cloud Gateway)'). */
  displayName: string;
  /** Default API URL (e.g. 'https://openrouter.ai/api/v1'). */
  defaultApiUrl: string;
  /** Current API URL — defaults to defaultApiUrl, overridable by the user. */
  apiUrl: string;
  /** API key — read from env on first load, updateable via settings. */
  apiKey: string;
  /** Whether the "Test & load models" action has been successfully run. */
  connectionTested: boolean;
  /** Models loaded from the provider's real /models endpoint. Empty until tested. */
  models: ProviderModel[];
  /** Last error from a test-and-load attempt — null if none. */
  lastError: string | null;
  /** Timestamp (epoch ms) of the last successful model load. */
  lastLoadedAt: number | null;
}

export interface TestAndLoadResult {
  /** The provider ID that was tested. */
  providerId: string;
  /** Whether the test succeeded. */
  success: boolean;
  /** Models loaded (empty if failed). */
  models: ProviderModel[];
  /** Error message if failed — specific and visible, not silent. */
  error: string | null;
  /** How long the real API call took in ms. */
  durationMs: number;
}
