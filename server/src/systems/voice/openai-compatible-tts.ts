// server/src/systems/voice/openai-compatible-tts.ts
// Generic OpenAI-compatible TTS provider.
//
// Most cloud TTS providers (OpenAI, Doubao, MiniMax, Cartesia, Fish Audio,
// Speechify, etc.) expose an OpenAI-compatible API:
//   POST /v1/audio/speech
//   Body: { model: "tts-1", voice: "alloy", input: "hello", format: "wav" }
//   Response: binary audio data (mp3/wav/opus)
//
// This single class handles ALL of them — no need for 8 separate provider classes.
// Each provider is configured with: apiUrl, apiKey, defaultModel, defaultVoice.

import type { TTSProvider, TTSResult } from './tts-provider.js';

export interface OpenAICompatibleTTSConfig {
  providerId: string;      // e.g. 'openai-tts', 'cartesia', 'doubao'
  apiUrl: string;          // e.g. 'https://api.openai.com/v1'
  apiKey: string;
  defaultModel: string;    // e.g. 'tts-1'
  defaultVoice: string;   // e.g. 'alloy'
  format?: string;        // 'mp3' | 'wav' | 'opus' — defaults to 'mp3'
}

export class OpenAICompatibleTTSProvider implements TTSProvider {
  readonly implementation: string;
  private apiUrl: string;
  private apiKey: string;
  private model: string;
  private voice: string;
  private format: string;

  constructor(config: OpenAICompatibleTTSConfig) {
    this.implementation = config.providerId;
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.model = config.defaultModel;
    this.voice = config.defaultVoice;
    this.format = config.format ?? 'mp3';
  }

  async speak(text: string): Promise<TTSResult> {
    if (!text.trim()) {
      throw new Error(`[${this.implementation}] Empty text — nothing to speak`);
    }

    if (!this.apiKey) {
      throw new Error(`[${this.implementation}] No API key configured`);
    }

    const url = `${this.apiUrl}/audio/speech`;
    const body = {
      model: this.model,
      voice: this.voice,
      input: text,
      response_format: this.format,
    };

    console.log(`[tts:${this.implementation}] speaking ${text.length} chars via ${url} (model=${this.model}, voice=${this.voice})`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`[${this.implementation}] TTS failed: ${res.status} ${errText.slice(0, 200)}`);
    }

    // The response is binary audio data
    const arrayBuffer = await res.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64');

    // Estimate duration: roughly 150 words per minute = 2.5 words/sec
    // = ~5 chars/sec for English text
    const estimatedDurationMs = Math.ceil(text.length / 5) * 1000;

    return {
      audioBase64,
      format: this.format,
      sampleRate: 24000, // most providers use 24kHz
      durationMs: estimatedDurationMs,
    };
  }
}
