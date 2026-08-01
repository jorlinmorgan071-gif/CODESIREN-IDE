// server/src/systems/voice/kokoro-provider.ts
// KokoroTTSProvider — Phase E Build 1.
//
// Second implementation of the TTSProvider interface. Uses the Kokoro-82M
// model (Apache 2.0, hexgrad/Kokoro-82M on HuggingFace) running in a Python
// sidecar process, spawned and owned by SidecarManager. Same lifecycle
// contract as build123d/kasa sidecars — dies when Node dies, crashes surface
// as SidecarCrashedError, no silent fallback.
//
// NOT WIRED AS DEFAULT. ZaiTTSProvider remains the active provider in index.ts
// until this is reviewed and signed off. Prove via the standalone test script
// (scripts/kokoro-provider-isolated-test.ts) before any wiring change.
//
// Output normalization (per Section 0.1):
//   Kokoro returns 24kHz mono float32 torch.Tensor → sidecar converts to
//   int16 PCM bytes → base64-encodes → returns via JSON-lines. This provider
//   maps that into TTSResult { audioBase64, format: 'wav', sampleRate: 24000, durationMs }.
//
// Section 0.1 ground truth (verified):
//   - First call latency: ~9-10s (includes lazy model load: 312 MB download
//     if not cached + 1.3 GB RAM peak during load)
//   - Subsequent calls: ~1.5-2s for a 12-word sentence (2.15x real-time on
//     2-core CPU, no GPU in this environment)
//   - 54 voices across 9 languages; default voice is af_heart (A-grade
//     American English female)

import { sidecarManager, ensureKokoroSidecar, SidecarCrashedError } from '../../sidecars/manager.js';
import type { TTSProvider, TTSResult } from './tts-provider.js';

// Default voice per Section 0.1 grading — af_heart is the A-grade American
// English female voice. Override by passing options to the constructor
// (not exposed via the TTSProvider interface yet — that's a future Settings UI concern).
const DEFAULT_VOICE = 'af_heart';
const DEFAULT_LANG_CODE = 'a';  // American English

// Request timeout — first call includes lazy model load (~10s), subsequent
// calls are ~2s. 120s gives ample headroom for slow CPUs and long text.
const TTS_REQUEST_TIMEOUT_MS = 120_000;

export interface KokoroTTSProviderOptions {
  /** Voice name (e.g. 'af_heart', 'am_onyx'). Default: af_heart. */
  voice?: string;
  /** Language code (e.g. 'a' = American English, 'b' = British, 'j' = Japanese). Default: 'a'. */
  langCode?: string;
}

export class KokoroTTSProvider implements TTSProvider {
  readonly implementation = 'kokoro';
  private readonly voice: string;
  private readonly langCode: string;

  constructor(opts: KokoroTTSProviderOptions = {}) {
    this.voice = opts.voice ?? DEFAULT_VOICE;
    this.langCode = opts.langCode ?? DEFAULT_LANG_CODE;
  }

  async speak(text: string): Promise<TTSResult> {
    if (!text || text.trim().length === 0) {
      throw new Error('TTS: empty text');
    }

    // Lazy-spawn the sidecar on first call (not at server boot).
    // ensureKokoroSidecar() is idempotent — returns immediately if already running.
    ensureKokoroSidecar();

    // Send the TTS request via the JSON-lines protocol.
    // sidecarManager.request() handles response correlation by id, timeouts,
    // and SidecarCrashedError on sidecar death.
    let resp;
    try {
      resp = await sidecarManager.request('kokoro', {
        type: 'tts',
        text,
        voice: this.voice,
        langCode: this.langCode,
      }, TTS_REQUEST_TIMEOUT_MS);
    } catch (err) {
      // Sidecar died mid-request, or timed out, or never started.
      // Propagate honestly — no silent fallback to StubTTSProvider.
      if (err instanceof SidecarCrashedError) {
        throw new Error(`Kokoro sidecar crashed: ${err.message}`);
      }
      throw err;
    }

    if (!resp.ok) {
      // Sidecar ran the request but returned an error (bad input, model error, etc.)
      // Propagate honestly — no fabricated audio.
      throw new Error(`Kokoro TTS failed: ${resp.error ?? 'unknown error'}`);
    }

    // Map sidecar response → TTSResult
    const audioBase64 = String(resp.audioBase64 ?? '');
    if (!audioBase64) {
      throw new Error('Kokoro TTS returned ok=true but no audioBase64');
    }

    return {
      audioBase64,
      format: String(resp.format ?? 'wav'),
      sampleRate: Number(resp.sampleRate ?? 24000),
      durationMs: Number(resp.durationMs ?? 0),
    };
  }
}
