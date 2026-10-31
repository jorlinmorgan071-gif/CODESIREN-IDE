// server/src/systems/voice/tts-provider.ts
// TTSProvider interface — same dependency-injection pattern as
// PrinterClient, BrowserClient, DeviceClient, etc.
//
// This phase ships Z.ai via OpenAI-compatible TTS provider. A later phase will add
// KokoroTTSProvider (local, high-quality open-source TTS).
// The voice proxy and Face consume ONLY the interface — swapping
// providers is a new class implementing the same interface, zero
// changes to callers.

export interface TTSResult {
  /** Base64-encoded audio data (WAV format) */
  audioBase64: string;
  /** Audio format (e.g. 'wav', 'pcm') */
  format: string;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Duration in milliseconds (approximate) */
  durationMs: number;
}

export interface TTSProvider {
  readonly implementation: string;  // 'zai' | 'kokoro' | 'stub'

  /**
   * Convert text to speech audio.
   * @param text The text to speak (max 1024 chars per z-ai limit)
   * @returns TTSResult with base64 audio + metadata
   */
  speak(text: string): Promise<TTSResult>;
}


// ── StubTTSProvider — for testing ───────────────────────────

import { wrapPcmInWav, pcmDurationMs } from './audio-wav.js';

export class StubTTSProvider implements TTSProvider {
  readonly implementation = 'stub';

  async speak(text: string): Promise<TTSResult> {
    // Return a minimal valid WAV (silence) — lets the audio pipeline work
    // end-to-end without z-ai. Uses the shared wrapPcmInWav util.
    const sampleRate = 24000;
    const durationSec = Math.max(1, Math.min(10, text.length / 15));  // ~15 chars/sec
    const numSamples = Math.floor(sampleRate * durationSec);
    const pcmBytes = Buffer.alloc(numSamples * 2);  // all zeros = silence

    const wavBuffer = wrapPcmInWav(pcmBytes, sampleRate, 1);

    return {
      audioBase64: wavBuffer.toString('base64'),
      format: 'wav',
      sampleRate,
      durationMs: pcmDurationMs(pcmBytes, sampleRate, 1),
    };
  }
}

// ── Dependency injection ─────────────────────────────────────────────────

let activeTTSProvider: TTSProvider = new StubTTSProvider();

export function getTTSProvider(): TTSProvider {
  return activeTTSProvider;
}

export function setTTSProvider(provider: TTSProvider): void {
  activeTTSProvider = provider;
  console.log(`[tts-provider] active implementation: ${provider.implementation}`);
}
