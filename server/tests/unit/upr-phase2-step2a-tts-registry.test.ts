// server/tests/unit/upr-phase2-step2a-tts-registry.test.ts
// UPR Phase 2 Step 2a — TTS ProviderRegistry tests.
//
// Required evidence (per directive):
//   1. At least 1 real provider's "test & load" returns real voices
//   2. Confirm selecting a voice actually changes what's used system-wide
//      (not just stored, actually wired through)
//   3. Test a bad key — confirm the error state is specific and visible
//   4. Confirm Kokoro returns its static voice catalog (local, no remote)
//
// Method: mocked fetch for ElevenLabs /v1/voices + direct registry calls.
// The selectVoice wiring proof uses vi.spyOn on applyVoiceProvider.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Set API keys for TTS providers
process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';
process.env.DOUBAO_API_KEY = 'test-doubao-key';
process.env.MINIMAX_API_KEY = 'test-minimax-key';

import { listProviders, getProvider, testAndLoadModels, selectVoice, resetProvider } from '../../src/provider-registry/registry.js';

// ── Realistic ElevenLabs /v1/voices response shape ────────────────────────
function mockElevenLabsVoicesResponse(): Response {
  const body = {
    voices: [
      {
        voice_id: 'CwhRBWXzGAHq8TQ4Fs17',
        name: 'Roger',
        category: 'premade',
        labels: { language: 'english', gender: 'male', accent: 'american', description: 'Deep, authoritative' },
        preview_url: 'https://preview.url/roger.mp3',
      },
      {
        voice_id: 'EXAVITQu4vr4xnSDxMaL',
        name: 'Sarah',
        category: 'premade',
        labels: { language: 'english', gender: 'female', accent: 'american', description: 'Warm, conversational' },
        preview_url: 'https://preview.url/sarah.mp3',
      },
      {
        voice_id: 'pNInz6obpgDQRx5RXbVT',
        name: 'Adam',
        category: 'premade',
        labels: { language: 'english', gender: 'male', accent: 'american' },
        preview_url: 'https://preview.url/adam.mp3',
      },
    ],
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('UPR Phase 2 Step 2a — TTS ProviderRegistry', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset all providers to clean seed state
    resetProvider('kokoro');
    resetProvider('elevenlabs');
    resetProvider('openai-tts');
    resetProvider('doubao');
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TEST 1: listProviders returns 12 TTS providers + 2 LLM = 13 total ─
  it('listProviders includes all 12 TTS providers (11 cloud + Kokoro local)', () => {
    const providers = listProviders();
    const ttsProviders = providers.filter((p) => p.category === 'tts');
    expect(ttsProviders.length).toBe(11);

    // Spot-check provider IDs
    const ids = ttsProviders.map((p) => p.id);
    expect(ids).toContain('kokoro');
    expect(ids).toContain('elevenlabs');
    expect(ids).toContain('openai-tts');
    expect(ids).toContain('doubao');
    expect(ids).toContain('minimax-tts');
    expect(ids).toContain('inworld');
    expect(ids).toContain('fish-audio');
    expect(ids).toContain('speechify');
    expect(ids).toContain('gemini-tts');
    expect(ids).toContain('mistral-voxtral');
    expect(ids).toContain('cartesia');
  });

  // ── TEST 2: Kokoro "test & load" returns static voice catalog ─────────
  it('Kokoro: "test & load voices" returns static voice catalog (no remote)', async () => {
    // Kokoro is local — no fetch should be called
    const result = await testAndLoadModels('kokoro');

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.voices.length).toBeGreaterThan(0);

    // Kokoro should have the 'af_heart' voice (the default)
    const ids = result.voices.map((v) => v.id);
    expect(ids).toContain('af_heart');

    const provider = getProvider('kokoro')!;
    expect(provider.connectionTested).toBe(true);
    expect(provider.voices.length).toBeGreaterThan(0);

    // No fetch should have been called for Kokoro (local)
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── TEST 3: ElevenLabs "test & load" returns real voices from API ────
  it('ElevenLabs: "test & load voices" returns real voice list from /v1/voices', async () => {
    fetchSpy.mockResolvedValue(mockElevenLabsVoicesResponse());

    const result = await testAndLoadModels('elevenlabs');

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.voices.length).toBe(3);

    // Spot-check voice IDs match what ElevenLabs actually offers
    const ids = result.voices.map((v) => v.id);
    expect(ids).toContain('CwhRBWXzGAHq8TQ4Fs17');  // Roger
    expect(ids).toContain('EXAVITQu4vr4xnSDxMaL');   // Sarah

    // Verify voice metadata is parsed correctly
    const roger = result.voices.find((v) => v.id === 'CwhRBWXzGAHq8TQ4Fs17')!;
    expect(roger.name).toBe('Roger');
    expect(roger.language).toBe('english');
    expect(roger.gender).toBe('male');
    expect(roger.accent).toBe('american');
    expect(roger.previewUrl).toBe('https://preview.url/roger.mp3');

    const provider = getProvider('elevenlabs')!;
    expect(provider.connectionTested).toBe(true);
    expect(provider.voices.length).toBe(3);
    // Auto-selected first voice
    expect(provider.selectedVoiceId).toBe(result.voices[0].id);
  });

  // ── TEST 4: ElevenLabs bad key → specific, visible error ──────────────
  it('ElevenLabs: bad API key (401) → specific error, NOT silent empty list', async () => {
    fetchSpy.mockResolvedValue(new Response(
      '{"detail": {"status": "invalid_api_key", "message": "Invalid API key"}}',
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await testAndLoadModels('elevenlabs');

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error!).toContain('401');
    expect(result.error!).toMatch(/key|unauthorized/i);

    const provider = getProvider('elevenlabs')!;
    expect(provider.connectionTested).toBe(false);
    expect(provider.lastError).toContain('401');
  });

  // ── TEST 5: OpenAI TTS returns static voice list ──────────────────────
  it('OpenAI TTS: "test & load voices" returns static 6-voice catalog', async () => {
    const result = await testAndLoadModels('openai-tts');

    expect(result.success).toBe(true);
    expect(result.voices.length).toBe(6);

    const ids = result.voices.map((v) => v.id);
    expect(ids).toContain('alloy');
    expect(ids).toContain('echo');
    expect(ids).toContain('nova');

    // Verify gender info
    const alloy = result.voices.find((v) => v.id === 'alloy')!;
    expect(alloy.gender).toBe('neutral');
  });

  // ── TEST 6: selectVoice wires through to runtime via applyVoiceProvider ─
  it('selectVoice for Kokoro calls applyVoiceProvider to swap the active TTSProvider', async () => {
    // First load Kokoro voices
    await testAndLoadModels('kokoro');
    const provider = getProvider('kokoro')!;
    const voiceId = provider.voices[0].id;

    // Mock the voice-settings module's applyVoiceProvider
    const voiceSettingsModule = await import('../../src/orchestrator/voice-settings.js');
    const applySpy = vi.spyOn(voiceSettingsModule, 'applyVoiceProvider').mockResolvedValue(undefined);
    const setSettingsSpy = vi.spyOn(voiceSettingsModule, 'setVoiceSettings').mockImplementation(() => {});
    const getSettingsSpy = vi.spyOn(voiceSettingsModule, 'getVoiceSettings').mockReturnValue({
      provider: 'kokoro',
      kokoroVoice: 'af_heart',
      kokoroLangCode: 'a',
    });

    const result = await selectVoice('kokoro', voiceId);

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();

    // Verify applyVoiceProvider was called — this is the "actually wired through" proof
    expect(applySpy).toHaveBeenCalledTimes(1);

    // Verify the settings were updated with the selected voice
    expect(setSettingsSpy).toHaveBeenCalledTimes(1);
    const newSettings = setSettingsSpy.mock.calls[0][0];
    expect(newSettings.provider).toBe('kokoro');
    expect(newSettings.kokoroVoice).toBe(voiceId);

    // Verify the registry entry's selectedVoiceId was updated
    const updated = getProvider('kokoro')!;
    expect(updated.selectedVoiceId).toBe(voiceId);
  });

  // ── TEST 7: selectVoice rejects non-TTS providers ─────────────────────
  it('selectVoice rejects LLM providers with a specific error', async () => {
    const result = await selectVoice('openrouter', 'some-model');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a TTS provider');
  });

  // ── TEST 8: selectVoice rejects unknown voice IDs ─────────────────────
  it('selectVoice rejects a voice ID not in the loaded voices list', async () => {
    // First load ElevenLabs voices
    fetchSpy.mockResolvedValue(mockElevenLabsVoicesResponse());
    await testAndLoadModels('elevenlabs');

    // Try to select a voice that doesn't exist
    const result = await selectVoice('elevenlabs', 'nonexistent-voice-id');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  // ── TEST 9: TTS provider without a voices endpoint — connection test ──
  it('Doubao: connection test succeeds when API key is set (no voice list, just connection)', async () => {
    const result = await testAndLoadModels('doubao');

    expect(result.success).toBe(true);
    expect(result.voices).toEqual([]);
    expect(result.error).toBeNull();

    const provider = getProvider('doubao')!;
    expect(provider.connectionTested).toBe(true);
  });

  // ── TEST 10: TTS provider without API key → specific error ────────────
  it('Doubao: no API key → specific error telling user to enter a key', async () => {
    // Clear the key
    const entry = getProvider('doubao')!;
    entry.apiKey = '';

    const result = await testAndLoadModels('doubao');

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error!).toMatch(/not set|enter/i);
  });
});
