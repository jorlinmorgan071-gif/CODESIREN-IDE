// server/src/provider-registry/types.ts
// UPR Phase 1 Step 3 + Phase 2 Step 2a — ProviderRegistry data model.
//
// Phase 1: LLM category only (OpenRouter + Anthropic).
// Phase 2 Step 2a: TTS category (11 cloud providers + Kokoro local).
// Phase 2 Steps 2b-2d: Tool/MCP, Image/Video, Custom onboarding.

export type ProviderCategory = 'llm' | 'tts';  // Phase 2 adds 'tool' | 'image-video'

export type CostTier = 'free' | 'freemium' | 'paid';

// ── LLM model metadata (Phase 1) ─────────────────────────────────────────

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

// ── TTS voice metadata (Phase 2 Step 2a) ──────────────────────────────────

export interface ProviderVoice {
  /** The voice ID as the provider expects it (e.g. 'CwhRBWXzGAHq8TQ4Fs17', 'af_heart', 'alloy'). */
  id: string;
  /** Human-readable display name (e.g. 'Roger', 'Heart (American English)', 'Alloy'). */
  name: string;
  /** Language code or label (e.g. 'en', 'English', 'American English'). Empty if not reported. */
  language?: string;
  /** Gender — 'male', 'female', or 'neutral'. Undefined if not reported. */
  gender?: 'male' | 'female' | 'neutral';
  /** Accent description (e.g. 'American', 'British', 'Indian'). Empty if not reported. */
  accent?: string;
  /** URL to a preview audio sample (if the provider offers one). */
  previewUrl?: string;
  /** Provider's description of the voice. */
  description?: string;
}

// ── Registry entry ────────────────────────────────────────────────────────

export interface ProviderRegistryEntry {
  /** Unique provider ID (e.g. 'openrouter', 'anthropic', 'kokoro', 'elevenlabs'). */
  id: string;
  /** Category — 'llm' or 'tts' (Phase 2 adds 'tool' | 'image-video'). */
  category: ProviderCategory;
  /** Human-readable display name (e.g. 'OpenRouter (Cloud Gateway)', 'Kokoro (Local)'). */
  displayName: string;
  /** Default API URL (e.g. 'https://openrouter.ai/api/v1', 'https://api.elevenlabs.io/v1'). */
  defaultApiUrl: string;
  /** Current API URL — defaults to defaultApiUrl, overridable by the user. */
  apiUrl: string;
  /** API key — read from env on first load, updateable via settings. Empty for local providers. */
  apiKey: string;
  /** Whether the "Test & load" action has been successfully run. */
  connectionTested: boolean;
  /** Models loaded from the provider's real /models endpoint (LLM category). Empty until tested. */
  models: ProviderModel[];
  /** Voices loaded from the provider's real /voices endpoint or static catalog (TTS category). Empty until tested. */
  voices: ProviderVoice[];
  /** The currently-selected voice ID for this provider (TTS category). Undefined if none selected. */
  selectedVoiceId?: string;
  /** Last error from a test-and-load attempt — null if none. */
  lastError: string | null;
  /** Timestamp (epoch ms) of the last successful model/voice load. */
  lastLoadedAt: number | null;
}

// ── Test & load result ───────────────────────────────────────────────────

export interface TestAndLoadResult {
  /** The provider ID that was tested. */
  providerId: string;
  /** Whether the test succeeded. */
  success: boolean;
  /** Models loaded (empty if failed or TTS category). */
  models: ProviderModel[];
  /** Voices loaded (empty if failed or LLM category). */
  voices: ProviderVoice[];
  /** Error message if failed — specific and visible, not silent. */
  error: string | null;
  /** How long the real API call took in ms. */
  durationMs: number;
}
