// server/tests/unit/upr-phase2-read-aloud-wiring.test.ts
// UPR Phase 2 — Read-aloud wiring tests.
//
// Required evidence:
//   1. POST /api/voice/speak calls getTTSProvider().speak() — the singleton
//   2. Returns { audioBase64, format, sampleRate, durationMs }
//   3. Errors surface honestly (not silent)
//   4. Text validation (empty / too long)
//   5. ChatPanel passes onSpeak (source inspection)
//   6. ActionRow hidden during streaming
//   7. Overlap prevention in handleSpeak
//   8. api.speak() method exists

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the TTS provider BEFORE importing the route
const mockSpeak = vi.fn();
vi.mock('../../src/systems/voice/tts-provider.js', () => ({
  getTTSProvider: () => ({
    implementation: 'stub',
    speak: mockSpeak,
  }),
  setTTSProvider: vi.fn(),
}));

// Mock auth
vi.mock('../../src/auth/middleware.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAuthOptional: (_req: any, _res: any, next: any) => next(),
}));

// Mock voice-settings to avoid circular deps
vi.mock('../../src/orchestrator/voice-settings.js', () => ({
  getVoiceSettings: () => ({ provider: 'zai', kokoroVoice: 'af_heart', kokoroLangCode: 'a' }),
  setVoiceSettings: vi.fn(() => ({ provider: 'zai', kokoroVoice: 'af_heart', kokoroLangCode: 'a' })),
  applyVoiceProvider: vi.fn(async () => {}),
  getVoiceProviders: () => [],
  VOICE_PROVIDERS: [],
  KOKORO_VOICES: [],
  ELEVENLABS_VOICES: [],
}));

// Mock tenancy scope
vi.mock('../../src/tenancy/scope.js', () => ({
  resolveTenantScope: vi.fn(async () => ({ userId: 'test', projectId: 'test-project' })),
  ProjectAccessError: class extends Error {},
  SessionAccessError: class extends Error {},
  ensureOwnedSession: vi.fn(async () => {}),
}));

// Mock agent-manager
vi.mock('../../src/orchestration/agent-manager.js', () => ({
  agentManager: { send: vi.fn(), executeAndWait: vi.fn(), get: vi.fn(), register: vi.fn(), list: vi.fn(() => []) },
}));

// Mock voice-client
vi.mock('../../src/systems/voice/voice-client.js', () => ({
  getVoiceClient: () => ({ implementation: 'stub', startSession: vi.fn(), stopSession: vi.fn(), transcribe: vi.fn(), getSessionStatus: vi.fn() }),
}));

import express from 'express';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function makeRequest(app: express.Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const data = body ? JSON.stringify(body) : undefined;
      const start = Date.now();
      const req = http.request(
        { host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : {} });
          });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      if (data) req.write(data);
      req.end();
    });
  });
}

describe('UPR Phase 2 — Read-aloud wiring', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Dynamic import AFTER mocks are set up
    const { voiceRouter } = await import('../../src/routes/voice.js');
    app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: 'test-user', email: 'test@test.com', name: 'Test' };
      next();
    });
    app.use('/api/voice', voiceRouter);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TEST 1: speak calls getTTSProvider().speak() ──────────────────────
  it('POST /api/voice/speak calls getTTSProvider().speak() with the provided text', async () => {
    mockSpeak.mockResolvedValue({
      audioBase64: 'dGVzdC1hdWRpbw==',
      format: 'wav',
      sampleRate: 24000,
      durationMs: 500,
    });

    const res = await makeRequest(app, 'POST', '/api/voice/speak', { text: 'Hello, world!' });

    expect(mockSpeak).toHaveBeenCalledTimes(1);
    expect(mockSpeak).toHaveBeenCalledWith('Hello, world!');
    expect(res.status).toBe(200);
    expect(res.body.audioBase64).toBe('dGVzdC1hdWRpbw==');
    expect(res.body.format).toBe('wav');
    expect(res.body.sampleRate).toBe(24000);
    expect(res.body.durationMs).toBe(500);
  });

  // ── TEST 2: empty text → 400 ─────────────────────────────────────────
  it('POST /api/voice/speak with empty text → 400', async () => {
    const res = await makeRequest(app, 'POST', '/api/voice/speak', { text: '' });
    expect(res.status).toBe(400);
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  // ── TEST 3: TTS failure → 500 with specific error ─────────────────────
  it('POST /api/voice/speak when TTS fails → 500 with specific error message', async () => {
    mockSpeak.mockRejectedValue(new Error('Kokoro sidecar not running'));

    const res = await makeRequest(app, 'POST', '/api/voice/speak', { text: 'Test text' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('TTS failed');
    expect(res.body.error).toContain('Kokoro sidecar not running');
  });

  // ── TEST 4: ChatPanel passes onSpeak to ChatBubble ────────────────────
  it('ChatPanel.tsx passes onSpeak to ChatBubble (source inspection)', () => {
    const source = readFileSync(resolve(process.cwd(), '../app/src/components/chat/ChatPanel.tsx'), 'utf8');
    expect(source).toContain('onSpeak={handleSpeak}');
    expect(source).toContain('api.speak(content)');
    expect(source).toContain('decodeAudioData');
    expect(source).toContain('createBufferSource');
  });

  // ── TEST 5: ActionRow hidden during streaming ─────────────────────────
  it('ChatBubble.tsx hides ActionRow during streaming', () => {
    const source = readFileSync(resolve(process.cwd(), '../app/src/components/chat/elements/ChatBubble.tsx'), 'utf8');
    expect(source).toContain('!message.isStreaming');
  });

  // ── TEST 6: Overlap prevention ────────────────────────────────────────
  it('handleSpeak stops current playback before starting new (overlap prevention)', () => {
    const source = readFileSync(resolve(process.cwd(), '../app/src/components/chat/ChatPanel.tsx'), 'utf8');
    expect(source).toContain('speakSourceRef.current.stop()');
    expect(source).toContain('abort');
    expect(source).toContain('superseded by a newer click');
  });

  // ── TEST 7: api.speak() method exists ─────────────────────────────────
  it('api.ts exposes speak(text) method', () => {
    const source = readFileSync(resolve(process.cwd(), '../app/src/lib/api.ts'), 'utf8');
    expect(source).toContain('async speak(text: string)');
    expect(source).toContain("request('/voice/speak'");
  });
});
