// server/src/systems/voice/tts-provider.ts
// TTSProvider interface — same dependency-injection pattern as
// PrinterClient, BrowserClient, DeviceClient, etc.
//
// This phase ships ZaiTTSProvider (z-ai SDK). A later phase will add
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

// ── ZaiTTSProvider — uses z-ai-web-dev-sdk ───────────────────────────────

export class ZaiTTSProvider implements TTSProvider {
  readonly implementation = 'zai';
  private zaiInstance: any | null = null;

  private async ensureZai(): Promise<any> {
    if (!this.zaiInstance) {
      const ZAI = (await import('z-ai-web-dev-sdk')).default;
      this.zaiInstance = await ZAI.create();
    }
    return this.zaiInstance;
  }

  async speak(text: string): Promise<TTSResult> {
    if (!text || text.trim().length === 0) {
      throw new Error('TTS: empty text');
    }

    // z-ai TTS limit: 1024 chars — split if needed
    const truncated = text.slice(0, 1024);

    const zai = await this.ensureZai();
    const response = await zai.audio.tts.create({
      input: truncated,
      voice: 'tongtong',
      speed: 1.0,
      response_format: 'wav',
      stream: false,
    });

    const arrayBuffer = await response.arrayBuffer();
    const audioBase64 = Buffer.from(new Uint8Array(arrayBuffer)).toString('base64');

    // Estimate duration: WAV at 24kHz, 16-bit mono ≈ 48KB/sec
    const estimatedDurationMs = Math.round((arrayBuffer.byteLength / 48000) * 1000);

    return {
      audioBase64,
      format: 'wav',
      sampleRate: 24000,
      durationMs: estimatedDurationMs,
    };
  }
}

// ── StubTTSProvider — for testing without z-ai ───────────────────────────

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
