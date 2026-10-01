// server/src/systems/voice/asr-provider.ts
// ASRProvider interface — mirrors the TTSProvider pattern exactly.
//
// This replaces the direct zai.audio.asr.create() call in voice-proxy.ts.
// The Whisper sidecar (already built for offline transcription) becomes the
// default ASR provider — no z-ai dependency for voice ASR.
//
// Same dependency-injection pattern as tts-provider.ts:
//   - ASRProvider interface
//   - WhisperASRProvider implementation (wraps the sidecar)
//   - getASRProvider() / setASRProvider() singleton
//   - activeASRProvider defaults to WhisperASRProvider
//
// The voice proxy consumes ONLY the interface — swapping providers is a new
// class implementing the same interface, zero changes to callers.

import { sidecarManager, ensureWhisperSidecar, SidecarCrashedError } from '../../sidecars/manager.js';

export interface ASRResult {
  /** The transcribed text */
  text: string;
  /** Detected language code (e.g. 'en', 'es', 'fr') */
  language: string;
  /** Audio duration in seconds */
  duration: number;
}

export interface ASRProvider {
  readonly implementation: string;  // 'whisper' | 'stub'

  /**
   * Transcribe audio bytes to text.
   * @param audioBytes Raw audio bytes (webm/wav/mp3 — PyAV decodes by content)
   * @returns ASRResult with transcript + metadata
   */
  transcribe(audioBytes: Buffer): Promise<ASRResult>;
}

// ── WhisperASRProvider — wraps the faster-whisper sidecar ────────────────

const ASR_REQUEST_TIMEOUT_MS = 180_000;  // 3 min — large-v3-turbo is slow on first load

export class WhisperASRProvider implements ASRProvider {
  readonly implementation = 'whisper';

  async transcribe(audioBytes: Buffer): Promise<ASRResult> {
    if (!audioBytes || audioBytes.length === 0) {
      throw new Error('ASR: empty audio data');
    }

    // Lazy-spawn the sidecar on first call (not at server boot).
    ensureWhisperSidecar();

    // Send the transcribe request via the JSON-lines protocol.
    const base64Audio = audioBytes.toString('base64');
    let resp;
    try {
      resp = await sidecarManager.request('whisper', {
        type: 'transcribe',
        audioBase64: base64Audio,
      }, ASR_REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof SidecarCrashedError) {
        throw new Error(`Whisper sidecar crashed: ${err.message}`);
      }
      throw err;
    }

    if (!resp.ok) {
      throw new Error(`Whisper ASR failed: ${resp.error ?? 'unknown error'}`);
    }

    return {
      text: String(resp.text ?? ''),
      language: String(resp.language ?? 'unknown'),
      duration: Number(resp.duration ?? 0),
    };
  }
}

// ── StubASRProvider — for testing without the Whisper sidecar ───────────

export class StubASRProvider implements ASRProvider {
  readonly implementation = 'stub';

  async transcribe(audioBytes: Buffer): Promise<ASRResult> {
    // Return a fixed transcript — lets the pipeline work end-to-end
    // without the Whisper sidecar. For testing only.
    return {
      text: '(stub transcription — install Whisper for real ASR)',
      language: 'en',
      duration: 0,
    };
  }
}

// ── Dependency injection ─────────────────────────────────────────────────

// Default to WhisperASRProvider — the Whisper sidecar is installed via the
// API Hub installer (Kokoro + Whisper sidecars). If the sidecar isn't
// installed, transcribe() will fail with a clear error that surfaces the
// installer prompt (handled by the caller).
let activeASRProvider: ASRProvider = new WhisperASRProvider();

export function getASRProvider(): ASRProvider {
  return activeASRProvider;
}

export function setASRProvider(provider: ASRProvider): void {
  activeASRProvider = provider;
  console.log(`[asr-provider] active implementation: ${provider.implementation}`);
}
