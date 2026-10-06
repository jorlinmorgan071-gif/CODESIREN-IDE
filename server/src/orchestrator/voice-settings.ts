// server/src/orchestrator/voice-settings.ts
// Voice provider settings — Phase E Build 2.
//
// Mirrors the orchestrator-settings.ts pattern exactly (per Section 0.2's
// summary): JSON file at server/.runtime/voice-settings.json, module-level
// cache, lazy-load + write-through, no DB table. Adds two extensions:
//
//   1. applyVoiceProvider(settings) — instantiates the correct TTSProvider
//      and calls setTTSProvider(). Called at both boot (from index.ts) and
//      on-demand (from the POST /api/voice/settings route). Fixes the
//      orchestrator-engine boot quirk (where the saved engine setting is
//      NOT applied at boot — only on later POST) rather than replicating it.
//
//   2. Read-time validation — if settings.provider isn't in VOICE_PROVIDERS,
//      log a clear warning and fall back to DEFAULT_SETTINGS. This is more
//      honest than the orchestrator pattern's silent per-field ?? fallback,
//      which can load a stale/invalid value into cache without surfacing it.
//
// Extensible for Chatterbox/ElevenLabs: add the new provider id to the
// VoiceSettings union type, add an entry to VOICE_PROVIDERS, add a case
// to applyVoiceProvider(). The shape doesn't break.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(__dirname, '..', '..', '.runtime', 'voice-settings.json');

// ── Types ────────────────────────────────────────────────────────────────

/**
 * TTS provider id. Add new provider ids here (e.g. 'chatterbox')
 * when those providers are implemented — also add a matching entry to
 * VOICE_PROVIDERS below and a case to applyVoiceProvider().
 */
export type VoiceProviderId = 'zai' | 'kokoro' | 'elevenlabs';

export interface VoiceProviderOption {
  id: VoiceProviderId;
  label: string;        // display label for the Settings UI
  desc?: string;        // optional description shown in the picker
  /** True if the provider is currently implemented and available. */
  available: boolean;
  /** If not available, a human-readable reason (shown in the UI). */
  reason?: string;
}

/**
 * Voice settings shape. Extensible — when Chatterbox/ElevenLabs are added,
 * their per-provider options (e.g. chatterboxVoice, elevenLabsVoiceId) go
 * here as optional fields. Existing fields don't change.
 */
export interface VoiceSettings {
  provider: VoiceProviderId;
  /** Kokoro voice name (e.g. 'af_heart'). Only used when provider='kokoro'. */
  kokoroVoice?: string;
  /** Kokoro language code (e.g. 'a' = American English). Only used when provider='kokoro'. */
  kokoroLangCode?: string;
  /** ElevenLabs voice_id (e.g. 'CwhRBWXzGAHq8TQ4Fs17'). Only used when provider='elevenlabs'. */
  elevenlabsVoiceId?: string;
}

// ── Allowed-values list (const, exported for the UI picker) ──────────────

/**
 * Build the VOICE_PROVIDERS list at runtime. ElevenLabs availability is
 * computed from whether ELEVENLABS_API_KEY is set in process.env — same
 * pattern as the orchestrator's listAvailableEngines() (engines without
 * their required API key show as available:false with a reason).
 *
 * This is a FUNCTION rather than a const so the availability check runs
 * fresh each time it's called (e.g. after the user adds a key to .env and
 * restarts, or in tests that mock process.env). Callers should call
 * getVoiceProviders() rather than referencing a stale const.
 */
function buildVoiceProviders(): VoiceProviderOption[] {
  const elevenlabsKeyConfigured = !!process.env.ELEVENLABS_API_KEY;
  return [
    {
      id: 'zai',
      label: 'Z.ai Cloud TTS',
      desc: 'Cloud-based TTS via z-ai-web-dev-sdk. No local install required.',
      available: true,
    },
    {
      id: 'kokoro',
      label: 'Kokoro-82M (Local)',
      desc: 'Local neural TTS — Apache 2.0, 82M params. Requires Python sidecar (~1.4 GB venv, ~312 MB model). 54 voices across 9 languages.',
      available: true,
    },
    {
      id: 'elevenlabs',
      label: 'ElevenLabs (BYOK)',
      desc: 'Cloud TTS via ElevenLabs REST API. Bring Your Own Key — requires ELEVENLABS_API_KEY in server/.env. Free tier: 10,000 credits/month. 21 premade voices.',
      available: elevenlabsKeyConfigured,
      reason: elevenlabsKeyConfigured
        ? undefined
        : 'API key not configured — add ELEVENLABS_API_KEY to server/.env and restart the server.',
    },
    // Future providers slot in here:
    // { id: 'chatterbox', label: 'Chatterbox', desc: '...', available: true },
  ];
}

/** Runtime-built VOICE_PROVIDERS list (computed each call). */
export function getVoiceProviders(): VoiceProviderOption[] {
  return buildVoiceProviders();
}

/**
 * Backwards-compat: VOICE_PROVIDERS as a const evaluated at module load.
 * NOTE: This captures the availability state at module-load time. For fresh
 * availability checks (e.g. after .env changes), use getVoiceProviders().
 * Tests that mock process.env should call getVoiceProviders() explicitly.
 */
export const VOICE_PROVIDERS: VoiceProviderOption[] = buildVoiceProviders();

// ── Kokoro voice catalog (per Section 0.1 — 54 voices, 9 languages) ──────
// Used by the UI picker when Kokoro is selected. Grouped by language.
// (Kept here so the server is the single source of truth for the catalog;
// the UI fetches it via GET /api/voice/settings.)

export interface KokoroVoiceOption {
  name: string;         // voice name (e.g. 'af_heart')
  langCode: string;     // language code (e.g. 'a')
  langLabel: string;    // human-readable language label
  gender: 'female' | 'male';
  grade?: string;       // quality grade from VOICES.md (e.g. 'A', 'B+')
}

export const KOKORO_VOICES: KokoroVoiceOption[] = [
  // American English (lang_code='a')
  { name: 'af_heart', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'A' },
  { name: 'af_bella', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'A-' },
  { name: 'af_nicole', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'B-' },
  { name: 'af_sarah', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'C+' },
  { name: 'af_sky', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'C-' },
  { name: 'af_alloy', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'C' },
  { name: 'af_aoede', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'C+' },
  { name: 'af_jessica', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'D' },
  { name: 'af_kore', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'C+' },
  { name: 'af_nova', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'C' },
  { name: 'af_river', langCode: 'a', langLabel: 'American English', gender: 'female', grade: 'D' },
  { name: 'am_adam', langCode: 'a', langLabel: 'American English', gender: 'male', grade: 'F+' },
  { name: 'am_echo', langCode: 'a', langLabel: 'American English', gender: 'male', grade: 'D' },
  { name: 'am_eric', langCode: 'a', langLabel: 'American English', gender: 'male', grade: 'D' },
  { name: 'am_fenrir', langCode: 'a', langLabel: 'American English', gender: 'male', grade: 'C+' },
  { name: 'am_liam', langCode: 'a', langLabel: 'American English', gender: 'male', grade: 'D' },
  { name: 'am_michael', langCode: 'a', langLabel: 'American English', gender: 'male', grade: 'C+' },
  { name: 'am_onyx', langCode: 'a', langLabel: 'American English', gender: 'male', grade: 'D' },
  { name: 'am_puck', langCode: 'a', langLabel: 'American English', gender: 'male', grade: 'C+' },
  { name: 'am_santa', langCode: 'a', langLabel: 'American English', gender: 'male', grade: 'D-' },
  // British English (lang_code='b')
  { name: 'bf_emma', langCode: 'b', langLabel: 'British English', gender: 'female', grade: 'B-' },
  { name: 'bf_alice', langCode: 'b', langLabel: 'British English', gender: 'female', grade: 'D' },
  { name: 'bf_isabella', langCode: 'b', langLabel: 'British English', gender: 'female', grade: 'C' },
  { name: 'bf_lily', langCode: 'b', langLabel: 'British English', gender: 'female', grade: 'D' },
  { name: 'bm_daniel', langCode: 'b', langLabel: 'British English', gender: 'male', grade: 'D' },
  { name: 'bm_fable', langCode: 'b', langLabel: 'British English', gender: 'male', grade: 'C' },
  { name: 'bm_george', langCode: 'b', langLabel: 'British English', gender: 'male', grade: 'C' },
  { name: 'bm_lewis', langCode: 'b', langLabel: 'British English', gender: 'male', grade: 'D+' },
  // Japanese (lang_code='j')
  { name: 'jf_alpha', langCode: 'j', langLabel: 'Japanese', gender: 'female' },
  { name: 'jf_gongitsune', langCode: 'j', langLabel: 'Japanese', gender: 'female' },
  { name: 'jf_nezumi', langCode: 'j', langLabel: 'Japanese', gender: 'female' },
  { name: 'jf_tebukuro', langCode: 'j', langLabel: 'Japanese', gender: 'female' },
  { name: 'jm_kumo', langCode: 'j', langLabel: 'Japanese', gender: 'male' },
  // Mandarin Chinese (lang_code='z')
  { name: 'zf_xiaobei', langCode: 'z', langLabel: 'Mandarin Chinese', gender: 'female' },
  { name: 'zf_xiaoni', langCode: 'z', langLabel: 'Mandarin Chinese', gender: 'female' },
  { name: 'zf_xiaoxiao', langCode: 'z', langLabel: 'Mandarin Chinese', gender: 'female' },
  { name: 'zf_xiaoyi', langCode: 'z', langLabel: 'Mandarin Chinese', gender: 'female' },
  { name: 'zm_yunjian', langCode: 'z', langLabel: 'Mandarin Chinese', gender: 'male' },
  { name: 'zm_yunxi', langCode: 'z', langLabel: 'Mandarin Chinese', gender: 'male' },
  { name: 'zm_yunxia', langCode: 'z', langLabel: 'Mandarin Chinese', gender: 'male' },
  { name: 'zm_yunyang', langCode: 'z', langLabel: 'Mandarin Chinese', gender: 'male' },
  // Spanish (lang_code='e')
  { name: 'ef_dora', langCode: 'e', langLabel: 'Spanish', gender: 'female' },
  { name: 'em_alex', langCode: 'e', langLabel: 'Spanish', gender: 'male' },
  { name: 'em_santa', langCode: 'e', langLabel: 'Spanish', gender: 'male' },
  // French (lang_code='f')
  { name: 'ff_siwis', langCode: 'f', langLabel: 'French', gender: 'female' },
  // Hindi (lang_code='h')
  { name: 'hf_alpha', langCode: 'h', langLabel: 'Hindi', gender: 'female' },
  { name: 'hf_beta', langCode: 'h', langLabel: 'Hindi', gender: 'female' },
  { name: 'hm_omega', langCode: 'h', langLabel: 'Hindi', gender: 'male' },
  { name: 'hm_psi', langCode: 'h', langLabel: 'Hindi', gender: 'male' },
  // Italian (lang_code='i')
  { name: 'if_sara', langCode: 'i', langLabel: 'Italian', gender: 'female' },
  { name: 'im_nicola', langCode: 'i', langLabel: 'Italian', gender: 'male' },
  // Brazilian Portuguese (lang_code='p')
  { name: 'pf_dora', langCode: 'p', langLabel: 'Brazilian Portuguese', gender: 'female' },
  { name: 'pm_alex', langCode: 'p', langLabel: 'Brazilian Portuguese', gender: 'male' },
  { name: 'pm_santa', langCode: 'p', langLabel: 'Brazilian Portuguese', gender: 'male' },
];

// ── ElevenLabs voice catalog (per Section 0.4 — public /v1/voices endpoint) ─
// 21 premade voices, English only. Fetched from the public ElevenLabs API
// (no auth required for the premade voice catalog). Hardcoded here as a const
// so the server is the single source of truth — the UI fetches via GET
// /api/voice/settings. To refresh this list, run:
//   curl -s https://api.elevenlabs.io/v1/voices | jq '.voices[] | {voice_id, name, labels}'
// and paste the result here.

export interface ElevenLabsVoiceOption {
  voice_id: string;     // e.g. 'CwhRBWXzGAHq8TQ4Fs17'
  name: string;         // display name (e.g. 'Roger - Laid-Back, Casual, Resonant')
  category: string;     // 'premade' | 'cloned' | 'generated'
  language: string;     // ISO language code from labels (e.g. 'en')
  gender: string;       // 'male' | 'female' | '' from labels
  accent: string;       // e.g. 'american' | 'british' | ''
  description?: string; // voice description from ElevenLabs
  preview_url?: string; // URL to preview the voice (MP3)
}

export const ELEVENLABS_VOICES: ElevenLabsVoiceOption[] = [
  { voice_id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger', category: 'premade', language: 'en', gender: 'male', accent: 'american', description: 'Easy going and perfect for casual conversations.' },
  { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', category: 'premade', language: 'en', gender: 'female', accent: 'american', description: 'Mature, reassuring, confident.' },
  { voice_id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura', category: 'premade', language: 'en', gender: 'female', accent: 'american', description: 'Enthusiast, quirky attitude.' },
  { voice_id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', category: 'premade', language: 'en', gender: 'male', accent: 'australian', description: 'Deep, confident, energetic.' },
  { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', category: 'premade', language: 'en', gender: 'male', accent: 'british', description: 'Warm, captivating storyteller.' },
  { voice_id: 'N2lFW1XyP63u9XrYqSnl', name: 'Emily', category: 'premade', language: 'en', gender: 'female', accent: 'british', description: 'Calm, friendly, professional.' },
  { voice_id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', category: 'premade', language: 'en', gender: 'female', accent: 'swedish', description: 'Soft, expressive.' },
  { voice_id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Matilda', category: 'premade', language: 'en', gender: 'female', accent: 'american', description: 'Friendly, positive.' },
  { voice_id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matthew', category: 'premade', language: 'en', gender: 'male', accent: 'american', description: 'Calm, professional.' },
  { voice_id: 'Yko7PKHZNWotYUsmB8tZ', name: 'Jessica', category: 'premade', language: 'en', gender: 'female', accent: 'american', description: 'Soft, expressive.' },
  { voice_id: 'ZQe5CZNOzWyzPSCn5a3c', name: 'Brian', category: 'premade', language: 'en', gender: 'male', accent: 'american', description: 'Deep, authoritative.' },
  { voice_id: 'Zo8NpztVZ2pkBgVvc0x4', name: 'Lily', category: 'premade', language: 'en', gender: 'female', accent: 'british', description: 'Warm, friendly.' },
  { voice_id: 'azGgh5ui6qTbjncp7L8v', name: 'Samuel', category: 'premade', language: 'en', gender: 'male', accent: 'american', description: 'Calm, professional narrator.' },
  { voice_id: 'bHtb6xZtHlaPoM3x5Xvy', name: 'Nicole', category: 'premade', language: 'en', gender: 'female', accent: 'american', description: 'Warm, friendly.' },
  { voice_id: 'd8NzoULm4XQ7Lucy120v', name: 'Gigi', category: 'premade', language: 'en', gender: 'female', accent: 'american', description: 'Expressive, friendly.' },
  { voice_id: 'eVItLK1UvVnMxkJbxpAi', name: 'Freeman', category: 'premade', language: 'en', gender: 'male', accent: 'american', description: 'Deep, mature.' },
  { voice_id: 'fQcUMgGGRxCTACPbOaOJ', name: 'Gracie', category: 'premade', language: 'en', gender: 'female', accent: 'american', description: 'Warm, friendly.' },
  { voice_id: 'g5MIjCe0ngAFuTn3Mf4w', name: 'Michael', category: 'premade', language: 'en', gender: 'male', accent: 'american', description: 'Calm, professional.' },
  { voice_id: 'j91pENnMwfYpERs1xk3q', name: 'Owen', category: 'premade', language: 'en', gender: 'male', accent: 'british', description: 'Deep, friendly.' },
  { voice_id: 'mDTUuXeIxFnPcDAOSPXJ', name: 'Alice', category: 'premade', language: 'en', gender: 'female', accent: 'british', description: 'Warm, friendly.' },
  { voice_id: 'pNzbT6wjAQTuBgsMhddi', name: 'Bill', category: 'premade', language: 'en', gender: 'male', accent: 'american', description: 'Deep, mature.' },
];

// ── Defaults ─────────────────────────────────────────────────────────────
// Default provider is 'kokoro' — local neural TTS, no z-ai dependency.
// This matches the Phase 4 directive: the voice pipeline should work
// without any z-ai config. Existing dev machines may have a .runtime/
// voice-settings.json that overrides this — a fresh install gets Kokoro.

const DEFAULT_SETTINGS: VoiceSettings = {
  provider: 'kokoro',
  // Kokoro defaults (per Section 0.1 grading): af_heart is the A-grade
  // American English female voice. Used only when provider='kokoro'.
  kokoroVoice: 'af_heart',
  kokoroLangCode: 'a',
  // ElevenLabs default (per Section 0.4): Roger is the first premade voice —
  // American English, middle-aged male, conversational. Used only when
  // provider='elevenlabs'.
  elevenlabsVoiceId: 'CwhRBWXzGAHq8TQ4Fs17',
};

// ── Module-level cache ───────────────────────────────────────────────────

let cachedSettings: VoiceSettings | null = null;

// ── Read ─────────────────────────────────────────────────────────────────

/**
 * Read the saved voice settings. Falls back to DEFAULT_SETTINGS if the file
 * is missing, unreadable, or contains an invalid provider value (logged as
 * a visible warning, NOT a silent fallback).
 */
export function getVoiceSettings(): VoiceSettings {
  if (cachedSettings) return cachedSettings;

  let parsed: Partial<VoiceSettings> | null = null;
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = readFileSync(SETTINGS_PATH, 'utf8');
      parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    }
  } catch (err) {
    console.warn(
      `[voice:settings] failed to read ${SETTINGS_PATH}: ${err instanceof Error ? err.message : err}. Using defaults.`
    );
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }

  if (!parsed) {
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }

  // ── Read-time validation against VOICE_PROVIDERS ──────────────────────
  // Per directive Section 0.2 decision: invalid provider must fail honestly
  // (visible warning + fallback to default), not silently load the bad value.
  const provider = parsed.provider as VoiceProviderId | undefined;
  const knownProvider = provider ? VOICE_PROVIDERS.find((p) => p.id === provider) : undefined;

  if (provider && !knownProvider) {
    console.warn(
      `[voice:settings] unknown provider '${provider}' in ${SETTINGS_PATH}. ` +
      `Falling back to default ('${DEFAULT_SETTINGS.provider}'). ` +
      `Known providers: ${VOICE_PROVIDERS.map((p) => p.id).join(', ')}.`
    );
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }

  if (provider && knownProvider && !knownProvider.available) {
    console.warn(
      `[voice:settings] provider '${provider}' is not currently available: ${knownProvider.reason ?? 'unknown reason'}. ` +
      `Falling back to default ('${DEFAULT_SETTINGS.provider}').`
    );
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }

  // Validate kokoroVoice against KOKORO_VOICES if provider is 'kokoro'
  let kokoroVoice = parsed.kokoroVoice ?? DEFAULT_SETTINGS.kokoroVoice;
  let kokoroLangCode = parsed.kokoroLangCode ?? DEFAULT_SETTINGS.kokoroLangCode;
  if (provider === 'kokoro' && kokoroVoice) {
    const knownVoice = KOKORO_VOICES.find((v) => v.name === kokoroVoice);
    if (!knownVoice) {
      console.warn(
        `[voice:settings] unknown kokoro voice '${kokoroVoice}' in ${SETTINGS_PATH}. ` +
        `Falling back to default ('${DEFAULT_SETTINGS.kokoroVoice}'). ` +
        `Known voices: see KOKORO_VOICES export.`
      );
      kokoroVoice = DEFAULT_SETTINGS.kokoroVoice;
      kokoroLangCode = DEFAULT_SETTINGS.kokoroLangCode;
    } else {
      // Sync langCode to match the voice (a voice belongs to exactly one language)
      kokoroLangCode = knownVoice.langCode;
    }
  }

  // Validate elevenlabsVoiceId against ELEVENLABS_VOICES if provider is 'elevenlabs'
  let elevenlabsVoiceId = parsed.elevenlabsVoiceId ?? DEFAULT_SETTINGS.elevenlabsVoiceId;
  if (provider === 'elevenlabs' && elevenlabsVoiceId) {
    const knownVoice = ELEVENLABS_VOICES.find((v) => v.voice_id === elevenlabsVoiceId);
    if (!knownVoice) {
      console.warn(
        `[voice:settings] unknown elevenlabs voice_id '${elevenlabsVoiceId}' in ${SETTINGS_PATH}. ` +
        `Falling back to default ('${DEFAULT_SETTINGS.elevenlabsVoiceId}'). ` +
        `Known voices: see ELEVENLABS_VOICES export.`
      );
      elevenlabsVoiceId = DEFAULT_SETTINGS.elevenlabsVoiceId;
    }
  }

  cachedSettings = {
    provider: provider ?? DEFAULT_SETTINGS.provider,
    kokoroVoice,
    kokoroLangCode,
    elevenlabsVoiceId,
  };
  return cachedSettings;
}

// ── Write ────────────────────────────────────────────────────────────────

/**
 * Persist a settings patch. Returns the merged next settings. Writes through
 * to disk; if disk write fails, the settings live in memory only (with a
 * visible warning, matching the orchestrator pattern).
 */
export function setVoiceSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const current = getVoiceSettings();
  const next: VoiceSettings = {
    provider: patch.provider ?? current.provider,
    kokoroVoice: patch.kokoroVoice ?? current.kokoroVoice,
    kokoroLangCode: patch.kokoroLangCode ?? current.kokoroLangCode,
    elevenlabsVoiceId: patch.elevenlabsVoiceId ?? current.elevenlabsVoiceId,
  };
  try {
    const dir = dirname(SETTINGS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
    cachedSettings = next;
    console.log(
      `[voice:settings] saved — provider=${next.provider} kokoroVoice=${next.kokoroVoice ?? '-'} kokoroLangCode=${next.kokoroLangCode ?? '-'}`
    );
    return next;
  } catch (err) {
    console.warn(
      `[voice:settings] failed to write ${SETTINGS_PATH}: ${err instanceof Error ? err.message : err}. Settings live in memory only.`
    );
    cachedSettings = next;
    return next;
  }
}

// ── Apply (boot + runtime swap) ──────────────────────────────────────────

/**
 * Instantiate the correct TTSProvider based on the given settings and swap
 * it in as the active provider via setTTSProvider(). Called at both boot
 * (from index.ts) and on-demand (from the POST /api/voice/settings route).
 *
 * Throws if the provider id is unknown — this is intentional: by the time
 * applyVoiceProvider() is called, getVoiceSettings() has already validated
 * the id and fallen back to default if needed. So an unknown id here means
 * either a bug in the caller or a programmer error, and should surface loudly.
 */
export async function applyVoiceProvider(settings: VoiceSettings): Promise<void> {
  const { setTTSProvider } = await import('../systems/voice/tts-provider.js');

  switch (settings.provider) {
    case 'zai': {
      const { ZaiTTSProvider } = await import('../systems/voice/tts-provider.js');
      setTTSProvider(new ZaiTTSProvider());
      console.log(`[voice:settings] active TTS provider: zai`);
      break;
    }
    case 'kokoro': {
      const { KokoroTTSProvider } = await import('../systems/voice/kokoro-provider.js');
      setTTSProvider(
        new KokoroTTSProvider({
          voice: settings.kokoroVoice,
          langCode: settings.kokoroLangCode,
        })
      );
      console.log(
        `[voice:settings] active TTS provider: kokoro (voice=${settings.kokoroVoice ?? 'af_heart'}, langCode=${settings.kokoroLangCode ?? 'a'})`
      );
      // Note: sidecar spawns LAZILY on first speak() call — no preload here.
      // Per directive Section 0.2 decision: leave running on switch-away,
      // no teardown logic when switching away from Kokoro.
      break;
    }
    case 'elevenlabs': {
      const { ElevenLabsTTSProvider } = await import('../systems/voice/elevenlabs-provider.js');
      setTTSProvider(
        new ElevenLabsTTSProvider({
          voiceId: settings.elevenlabsVoiceId,
        })
      );
      console.log(
        `[voice:settings] active TTS provider: elevenlabs (voiceId=${settings.elevenlabsVoiceId ?? 'CwhRBWXzGAHq8TQ4Fs17'})`
      );
      // No sidecar — pure cloud fetch. No teardown needed when switching away.
      break;
    }
    default: {
      // Should never happen — getVoiceSettings() validates and falls back.
      // If it does, throw loudly so the bug surfaces.
      throw new Error(
        `applyVoiceProvider: unknown provider '${settings.provider}'. ` +
        `This indicates a bug — getVoiceSettings() should have validated and fallen back to default.`
      );
    }
  }
}
