// server/tests/unit/upr-phase3-read-aloud.test.ts
// Phase 3 — Read-aloud wiring tests.
//
// Verifies that POST /api/voice/speak:
//   1. Returns 400 on missing/empty text
//   2. Returns audio data on success
//   3. Uses the SAME getTTSProvider() singleton as greeting + agent-response
//   4. Surfaces TTS failures with a suggestedAction
//
// The test uses a mock TTSProvider to avoid hitting real cloud APIs.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { TTSProvider, TTSResult } from '../../src/systems/voice/tts-provider.js';

// We need to mock the TTS provider singleton BEFORE importing the route.
// The route uses dynamic import('../systems/voice/tts-provider.js'), so we
// need to intercept that.

vi.mock('../../src/systems/voice/tts-provider.js', () => {
  const mockProvider: TTSProvider = {
    implementation: 'mock',
    speak: vi.fn().mockResolvedValue({
      audioBase64: 'dGVzdA==', // 'test' base64
      format: 'wav',
      sampleRate: 24000,
      durationMs: 1000,
    } satisfies TTSResult),
  };
  return {
    getTTSProvider: () => mockProvider,
    setTTSProvider: () => {},
    __mockProvider: mockProvider,
  };
});

// Mock requireAuth so we don't need a real JWT
vi.mock('../../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { sub: 'test-user', email: 'test@test', name: 'Test', plan: 'free' };
    next();
  },
}));

import express from 'express';
import request from 'supertest';

describe('UPR Phase 3 — Read-aloud wiring (POST /api/voice/speak)', () => {
  let app: express.Express;

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    const { voiceRouter } = await import('../../src/routes/voice.js');
    app.use('/api/voice', voiceRouter);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 on missing text in body', async () => {
    const res = await request(app)
      .post('/api/voice/speak')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('text');
  });

  it('returns 400 on empty/whitespace text', async () => {
    const res = await request(app)
      .post('/api/voice/speak')
      .send({ text: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns audio data on success', async () => {
    const res = await request(app)
      .post('/api/voice/speak')
      .send({ text: 'Hello world' });
    expect(res.status).toBe(200);
    expect(res.body.audioBase64).toBe('dGVzdA==');
    expect(res.body.format).toBe('wav');
    expect(res.body.sampleRate).toBe(24000);
    expect(res.body.durationMs).toBe(1000);
  });

  it('returns 500 + suggestedAction on TTS failure', async () => {
    const { __mockProvider } = await import('../../src/systems/voice/tts-provider.js') as any;
    const mockProvider = __mockProvider as TTSProvider;
    (mockProvider.speak as any).mockRejectedValueOnce(new Error('Kokoro sidecar not running'));

    const res = await request(app)
      .post('/api/voice/speak')
      .send({ text: 'Hello' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Kokoro sidecar not running');
    expect(res.body.suggestedAction).toBeDefined();
  });

  it('calls the getTTSProvider() singleton (not a separate TTS path)', async () => {
    const { __mockProvider } = await import('../../src/systems/voice/tts-provider.js') as any;
    const mockProvider = __mockProvider as TTSProvider;
    (mockProvider.speak as any).mockClear();
    await request(app)
      .post('/api/voice/speak')
      .send({ text: 'Test the singleton path' });
    expect(mockProvider.speak).toHaveBeenCalledWith('Test the singleton path');
  });
});
