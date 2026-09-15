// server/src/provider-registry/types.ts
// UPR Phase 1 Step 3 + Phase 2 — ProviderRegistry data model.
//
// Phase 1: LLM category (OpenRouter + Anthropic).
// Phase 2 Step 2a: TTS category (11 cloud providers + Kokoro local).
// Phase 2 Step 2b: Tool/MCP category (built-in tools + external tool APIs).
// Phase 2 Step 2c: Image/Video generation category (5 cloud providers).
// Phase 2 Step 2d: Custom provider onboarding.

export type ProviderCategory = 'llm' | 'tts' | 'tool' | 'image-video';

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

// ── Tool metadata (Phase 2 Step 2b) ──────────────────────────────────────

export interface ProviderTool {
  /** The tool name as Code Siren agents will invoke it (e.g. 'web_search', 'git_status'). */
  name: string;
  /** Human-readable description of what the tool does, including args. */
  description: string;
  /** Whether the tool is read-only (no side effects) or mutates state. */
  readOnly: boolean;
  /** Whether the tool is currently available (some tools may be conditionally unavailable). */
  available: boolean;
  /** Why the tool is unavailable (if available=false). */
  unavailableReason?: string;
}

// ── Image/Video generation metadata (Phase 2 Step 2c) ───────────────────

export interface ProviderImageModel {
  /** The model ID as the provider expects it (e.g. 'dall-e-3', 'imagen-3.0-generate-002'). */
  id: string;
  /** Human-readable display name (e.g. 'DALL·E 3', 'Imagen 3'). */
  name: string;
  /** What this model generates: 'image' or 'video'. */
  outputType: 'image' | 'video';
  /** Supported output resolutions (e.g. ['1024x1024', '1792x1024']). Empty if not documented. */
  resolutions: string[];
  /** Supported aspect ratios (e.g. ['1:1', '16:9', '9:16']). Empty if not documented. */
  aspectRatios: string[];
  /** Whether the model supports image-to-image (editing an existing image). */
  supportsImageToImage: boolean;
  /** Whether the model supports video generation (vs static image only). */
  supportsVideo: boolean;
  /** Cost tier. */
  costTier: CostTier;
  /** Pricing note (e.g. '$0.040 per image'). */
  pricingNote: string;
}

// ── Registry entry ────────────────────────────────────────────────────────

export interface ProviderRegistryEntry {
  /** Unique provider ID (e.g. 'openrouter', 'anthropic', 'kokoro', 'elevenlabs'). */
  id: string;
  /** Category — 'llm', 'tts', 'tool', or 'image-video'. */
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
  /** Tools loaded from the built-in tool registry (Tool category). Empty until tested. */
  tools: ProviderTool[];
  /** Image/video models available from this provider (Image/Video category). Empty until tested. */
  imageModels: ProviderImageModel[];
  /** The currently-selected voice ID for this provider (TTS category). Undefined if none selected. */
  selectedVoiceId?: string;
  /** Last error from a test-and-load attempt — null if none. */
  lastError: string | null;
  /** Timestamp (epoch ms) of the last successful model/voice/tool/image-model load. */
  lastLoadedAt: number | null;
}

// ── Test & load result ───────────────────────────────────────────────────

export interface TestAndLoadResult {
  /** The provider ID that was tested. */
  providerId: string;
  /** Whether the test succeeded. */
  success: boolean;
  /** Models loaded (empty if failed or non-LLM category). */
  models: ProviderModel[];
  /** Voices loaded (empty if failed or non-TTS category). */
  voices: ProviderVoice[];
  /** Tools loaded (empty if failed or non-Tool category). */
  tools: ProviderTool[];
  /** Image/video models loaded (empty if failed or non-Image/Video category). */
  imageModels: ProviderImageModel[];
  /** Error message if failed — specific and visible, not silent. */
  error: string | null;
  /** How long the real API call took in ms. */
  durationMs: number;
}
