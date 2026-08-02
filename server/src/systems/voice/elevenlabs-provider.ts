// server/src/systems/voice/elevenlabs-provider.ts
// ElevenLabsTTSProvider — Phase E Build 3.
//
// Third implementation of the TTSProvider interface. Uses ElevenLabs' REST API
// (cloud TTS, BYOK — Bring Your Own Key). NO sidecar, NO model download,
// NO Python venv — just a raw fetch() call, matching the existing Skills Vault
// http_request pattern and ZaiTTSProvider's shape.
//
// Per Section 0.4 ground truth (all verified via real curl calls):
//   - Endpoint: POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}
//   - Auth: xi-api-key header (NOT Authorization: Bearer)
//   - Output: request pcm_24000 (raw 24kHz int16 PCM mono) via output_format
//     query param — matches Kokoro's sample rate, so the same wrapPcmInWav
//     util produces a WAV file the Face Avatar can play
//   - Error shape: { detail: { status: 'needs_authorization' | 'invalid_api_key' |
//     'invalid_uid' | 'quota_exceeded' | 'rate_limit_exceeded' | ... } }
//   - Each error status maps to a specific, honestly-reported throw message
//     (see ERROR_MESSAGES below) — no silent fallback to Zai or Stub
//
// Key storage: process.env.ELEVENLABS_API_KEY (read at runtime, never logged,
// never stored in voice-settings.json). Matches the existing .env pattern
// used by every other API key in the codebase.

import { wrapPcmInWav, pcmDurationMs } from './audio-wav.js';
import type { TTSProvider, TTSResult } from './tts-provider.js';

// ── Constants ────────────────────────────────────────────────────────────

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';  // 1 char = 1 credit on free tier
const DEFAULT_OUTPUT_FORMAT = 'pcm_24000';            // 24kHz mono int16 PCM
const DEFAULT_SAMPLE_RATE = 24000;
const REQUEST_TIMEOUT_MS = 30_000;  // 30s — cloud API, should be fast

// Default voice per Section 0.4: "CwhRBWXzGAHq8TQ4Fs17" = Roger (premade,
// American English, middle-aged male, conversational). User can override
// via the Settings UI voice picker.
const DEFAULT_VOICE_ID = 'CwhRBWXzGAHq8TQ4Fs17';

// Voice ID format: 20-character alphanumeric (verified from the public
// /v1/voices endpoint response). Used for client-side validation BEFORE
// making the API call — ElevenLabs checks voice_id format before auth,
// so we catch invalid IDs early to avoid a confusing 400.
const VOICE_ID_REGEX = /^[A-Za-z0-9]{16,32}$/;

// ── Error mapping (per Section 0.4 Item 6's table) ───────────────────────
// Maps ElevenLabs' detail.status field → specific honest-throw message.
// Each message tells the user what to do, not just what went wrong.

const ERROR_MESSAGES: Record<string, (detail: any) => string> = {
  needs_authorization: (_detail) =>
    'ElevenLabs: ELEVENLABS_API_KEY not configured — add it to server/.env to enable this provider.',
  invalid_api_key: (_detail) =>
    'ElevenLabs: invalid API key — check ELEVENLABS_API_KEY in server/.env.',
  invalid_uid: (detail) =>
    `ElevenLabs: invalid voice_id — ${detail?.message ?? 'unknown voice_id'}. Pick a valid voice in Settings → Voice.`,
  voice_not_found: (detail) =>
    `ElevenLabs: voice not found — ${detail?.message ?? 'no such voice_id'}. Pick a valid voice in Settings → Voice.`,
  quota_exceeded: (_detail) =>
    'ElevenLabs: monthly quota exceeded — upgrade your plan at https://elevenlabs.io/pricing or switch to a different provider in Settings → Voice.',
  rate_limit_exceeded: (_detail) =>
    'ElevenLabs: rate limited — please retry in a few seconds.',
};

// ── Provider options ─────────────────────────────────────────────────────

export interface ElevenLabsTTSProviderOptions {
  /** ElevenLabs voice_id (e.g. 'CwhRBWXzGAHq8TQ4Fs17' for Roger). Default: Roger. */
  voiceId?: string;
  /** Model id (e.g. 'eleven_multilingual_v2', 'eleven_flash_v2_5'). Default: eleven_multilingual_v2. */
  modelId?: string;
}

// ── Provider ─────────────────────────────────────────────────────────────

export class ElevenLabsTTSProvider implements TTSProvider {
  readonly implementation = 'elevenlabs';
  private readonly voiceId: string;
  private readonly modelId: string;

  constructor(opts: ElevenLabsTTSProviderOptions = {}) {
    this.voiceId = opts.voiceId ?? DEFAULT_VOICE_ID;
    this.modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  }

  async speak(text: string): Promise<TTSResult> {
    // ── Pre-flight: empty text (matches ZaiTTSProvider pattern) ──────────
    if (!text || text.trim().length === 0) {
      throw new Error('TTS: empty text');
    }

    // ── Pre-flight: API key (matches http_request tool's missing-key guard) ──
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error(ERROR_MESSAGES.needs_authorization(null));
    }

    // ── Pre-flight: voice_id format (avoids the API's 400-invalid_uid) ──
    if (!VOICE_ID_REGEX.test(this.voiceId)) {
      throw new Error(
        `ElevenLabs: invalid voice_id format '${this.voiceId}' — voice_id must be a 16-32 character alphanumeric string. Pick a valid voice in Settings → Voice.`
      );
    }

    // ── Make the request ────────────────────────────────────────────────
    const url = `${ELEVENLABS_API_BASE}/text-to-speech/${this.voiceId}?output_format=${DEFAULT_OUTPUT_FORMAT}`;
    const body = JSON.stringify({
      text,
      model_id: this.modelId,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/pcm',
        },
        body,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`ElevenLabs: request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new Error(`ElevenLabs: network error — ${err.message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    // ── Handle non-2xx (ElevenLabs uses consistent error JSON shape) ─────
    if (!response.ok) {
      // Try to parse the error body — ElevenLabs always returns JSON with
      // a `detail` field containing {type, code, message, status, request_id}
      let errorDetail: any = null;
      try {
        const errorJson: any = await response.json();
        errorDetail = errorJson?.detail ?? errorJson;
      } catch {
        // Non-JSON error response — surface the raw status
      }

      const status = errorDetail?.status ?? 'unknown';
      const messageFn = ERROR_MESSAGES[status];
      if (messageFn) {
        throw new Error(messageFn(errorDetail));
      }

      // Unknown error shape — surface it honestly with all available info
      const message = errorDetail?.message ?? `HTTP ${response.status}`;
      throw new Error(
        `ElevenLabs: ${status} (HTTP ${response.status}) — ${message}. ` +
        `Request ID: ${errorDetail?.request_id ?? 'unknown'}. ` +
        `See https://elevenlabs.io/docs/api-reference for details.`
      );
    }

    // ── Success: wrap raw PCM in WAV and return TTSResult ───────────────
    const pcmBytes = new Uint8Array(await response.arrayBuffer());
    if (pcmBytes.length === 0) {
      throw new Error('ElevenLabs: API returned empty audio (0 bytes)');
    }

    const wavBuffer = wrapPcmInWav(pcmBytes, DEFAULT_SAMPLE_RATE, 1);

    return {
      audioBase64: wavBuffer.toString('base64'),
      format: 'wav',
      sampleRate: DEFAULT_SAMPLE_RATE,
      durationMs: pcmDurationMs(pcmBytes, DEFAULT_SAMPLE_RATE, 1),
    };
  }
}
