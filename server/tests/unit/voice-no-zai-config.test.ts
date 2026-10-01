// tests/unit/voice-no-zai-config.test.ts
// Directive: Voice Session z-ai Dependency — Step 4 test
//
// Originally verified that voice-proxy worked without .z-ai-config. Now
// verifies the stronger guarantee: voice-proxy has NO z-ai dependency at all
// (the z-ai SDK import was removed). ASR is provided by the ASRProvider
// singleton (default: WhisperASRProvider).
//
// Verifies:
//   1. startSession() succeeds (returns a sessionId) — does NOT throw,
//      does NOT 500, does NOT depend on any z-ai config.
//   2. fireGreeting() broadcasts a voice:greeting WS event with text but
//      audioBase64: null (text-only fallback — TTS failed because no TTS
//      provider is configured in this test env).
//   3. processTurn() (called when the user speaks) broadcasts a clean
//      voice:error WS event when ASR fails — does NOT crash, does NOT throw,
//      does NOT leave the session in a broken state.
//   4. No z-ai SDK import in voice-proxy.ts — confirmed by mocking the
//      ASR provider (not z-ai) and verifying the error message comes from
//      the ASR provider, not from z-ai.
//
// Mocks the ASRProvider to throw (simulating Whisper sidecar not installed).
// This is the same condition the user would see on a machine without the
// Whisper sidecar — the error surfaces a plain-language installer prompt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the ASR provider to throw — simulates "Whisper sidecar not installed"
vi.mock('../../src/systems/voice/asr-provider.js', () => ({
  getASRProvider: () => ({
    implementation: 'whisper',
    transcribe: async () => {
      throw new Error('Whisper sidecar crashed: ModuleNotFoundError: No module named \'faster_whisper\'');
    },
  }),
}));

// Mock the WS broadcast so we can capture events without a real WS server
const capturedEvents: Array<{ event: string; payload: any }> = [];
vi.mock('../../src/ws/events.js', () => ({
  makeEvent: (event: string, payload: any) => ({ event, payload }),
  broadcast: (evt: { event: string; payload: any }) => {
    capturedEvents.push(evt);
  },
}));

// Mock classifyCommand (used by voice-intent-router, not relevant here)
vi.mock('../../src/orchestration/classify-command.js', () => ({
  classifyCommand: () => ({ blocked: false, risk: 'safe', explanation: '' }),
}));

import { voiceProxy } from '../../src/systems/voice/voice-proxy.js';

describe('Directive: Voice Session z-ai Dependency — no .z-ai-config condition', () => {
  beforeEach(() => {
    capturedEvents.length = 0;
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 1: startSession() succeeds without any z-ai dependency
  //
  // This is the direct fix for the reported bug. voice-proxy.ts no longer
  // imports z-ai-web-dev-sdk at all — the import was removed when ASR
  // moved to the ASRProvider singleton. startSession() returns 200.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 1: startSession() succeeds with no z-ai dependency (ASR provider mocked)', async () => {
    const sessionId = await voiceProxy.startSession(
      'test-user-id',
      '00000000-0000-0000-0000-000000000000',
      'TestUser',
    );

    // Session was created — returns a real session id
    expect(sessionId).toMatch(/^voice-/);
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(6);

    console.log(`  ✓ startSession() returned sessionId: ${sessionId}`);
    console.log('  ✓ No throw — HTTP endpoint would return 200 (not 500)');
    console.log('  ✓ No z-ai SDK import in voice-proxy.ts (removed in this phase)');

    voiceProxy.endSession(sessionId);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 2: fireGreeting() broadcasts text-only greeting (audioBase64: null)
  //
  // fireGreeting() is fire-and-forget. It broadcasts the greeting text
  // immediately (audioBase64: null), THEN tries to generate audio via
  // the TTS provider. If TTS fails (no provider configured in test env),
  // the text-only greeting remains.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 2: fireGreeting() broadcasts text-only greeting (audioBase64: null) when TTS fails', async () => {
    const sessionId = await voiceProxy.startSession(
      'test-user-id-2',
      '00000000-0000-0000-0000-000000000000',
      'TestUser2',
    );

    // Wait for fireGreeting() to complete
    await new Promise(r => setTimeout(r, 500));

    const greetingEvents = capturedEvents.filter(e => e.event === 'voice:greeting');
    expect(greetingEvents.length).toBeGreaterThanOrEqual(1);

    const firstGreeting = greetingEvents[0];
    expect(firstGreeting.payload.sessionId).toBe(sessionId);
    expect(firstGreeting.payload.text).toBeTruthy();
    expect(firstGreeting.payload.text.length).toBeGreaterThan(0);
    expect(firstGreeting.payload.audioBase64).toBeNull();

    console.log(`  ✓ Greeting text: "${firstGreeting.payload.text}"`);
    console.log(`  ✓ audioBase64: null (text-only — TTS failed gracefully)`);

    voiceProxy.endSession(sessionId);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 3: processTurn() broadcasts clean voice:error when ASR fails
  //
  // processTurn() calls getASRProvider().transcribe(). When the ASR provider
  // throws (simulated Whisper sidecar not installed), the catch block
  // broadcasts a voice:error event with "ASR failed: ..." + the installer
  // prompt. processTurn() returns normally — does NOT crash.
  //
  // This is the key test: the error comes from the ASR provider (not z-ai),
  // and the message surfaces the installer prompt.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 3: processTurn() broadcasts clean voice:error (not crash) when ASR provider fails', async () => {
    const sessionId = await voiceProxy.startSession(
      'test-user-id-3',
      '00000000-0000-0000-0000-000000000000',
      'TestUser3',
    );

    // Wait for greeting to finish
    await new Promise(r => setTimeout(r, 500));
    capturedEvents.length = 0;

    // Feed a real audio buffer (>1000 bytes to pass the length check)
    const fakeAudio = Buffer.alloc(2000, 0);
    const sessions = (voiceProxy as any).sessions as Map<string, any>;
    const session = sessions.get(sessionId);
    expect(session).toBeDefined();
    session.audioBuffer.push(fakeAudio);

    // Call processTurn — should NOT throw, should broadcast voice:error
    await voiceProxy.processTurn(sessionId);

    // Verify voice:error was broadcast
    const errorEvents = capturedEvents.filter(e => e.event === 'voice:error');
    expect(errorEvents.length).toBe(1);

    const errorEvent = errorEvents[0];
    expect(errorEvent.payload.sessionId).toBe(sessionId);
    // The error should come from the ASR provider (Whisper), NOT from z-ai.
    // It should NOT contain "Configuration file not found" (that was the z-ai error).
    expect(errorEvent.payload.error).not.toContain('Configuration file not found');
    // It SHOULD mention the Whisper sidecar (the new ASR provider).
    expect(errorEvent.payload.error).toContain('Whisper');
    // It SHOULD surface the installer prompt (plain-language, not a stack trace).
    expect(errorEvent.payload.error).toContain('Settings');
    expect(errorEvent.payload.error).toContain('Download');

    console.log(`  ✓ processTurn() did NOT throw (returned normally)`);
    console.log(`  ✓ voice:error event broadcast:`);
    console.log(`      error: "${errorEvent.payload.error}"`);
    console.log(`  ✓ Error comes from ASR provider (not z-ai) — z-ai dependency is gone`);
    console.log(`  ✓ Error surfaces installer prompt (plain-language, not stack trace)`);

    voiceProxy.endSession(sessionId);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 4: Full session lifecycle works without z-ai
  //
  // start → greeting (text-only) → speak (voice:error) → end.
  // The session doesn't crash at any point. endSession() cleans up.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 4: full lifecycle — start → text greeting → speak (error) → end — no crashes', async () => {
    // 1. Start
    const sessionId = await voiceProxy.startSession(
      'test-user-id-4',
      '00000000-0000-0000-0000-000000000000',
      'LifecycleTestUser',
    );
    expect(sessionId).toMatch(/^voice-/);
    console.log(`  ✓ 1. startSession() → ${sessionId}`);

    // 2. Wait for greeting
    await new Promise(r => setTimeout(r, 500));
    const greetingEvents = capturedEvents.filter(e => e.event === 'voice:greeting');
    expect(greetingEvents.length).toBeGreaterThanOrEqual(1);
    expect(greetingEvents[0].payload.audioBase64).toBeNull();
    console.log(`  ✓ 2. greeting received (text-only): "${greetingEvents[0].payload.text}"`);

    // 3. Speak (will fail ASR)
    capturedEvents.length = 0;
    const sessions = (voiceProxy as any).sessions as Map<string, any>;
    const session = sessions.get(sessionId);
    session.audioBuffer.push(Buffer.alloc(2000, 0));
    await voiceProxy.processTurn(sessionId);
    const errorEvents = capturedEvents.filter(e => e.event === 'voice:error');
    expect(errorEvents.length).toBe(1);
    console.log(`  ✓ 3. speak → voice:error: "${errorEvents[0].payload.error}"`);

    // 4. End
    voiceProxy.endSession(sessionId);
    const endEvents = capturedEvents.filter(e => e.event === 'voice:session-ended');
    expect(endEvents.length).toBe(1);
    expect(endEvents[0].payload.sessionId).toBe(sessionId);
    console.log(`  ✓ 4. endSession() → voice:session-ended broadcast`);

    // 5. Verify session is gone from the Map
    expect(sessions.has(sessionId)).toBe(false);
    console.log(`  ✓ 5. session cleaned up from memory`);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 5: No z-ai SDK import in voice-proxy.ts
  //
  // Confirms the z-ai-web-dev-sdk import was removed. The voice pipeline
  // no longer depends on z-ai for ASR at all.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 5: voice-proxy.ts does not import z-ai-web-dev-sdk', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const voiceProxySource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'systems', 'voice', 'voice-proxy.ts'),
      'utf8',
    );

    // The import line should NOT exist
    expect(voiceProxySource).not.toContain("import ZAI from 'z-ai-web-dev-sdk'");
    expect(voiceProxySource).not.toMatch(/import\s+.*z-ai-web-dev-sdk/);

    // ensureZai() method should NOT exist
    expect(voiceProxySource).not.toMatch(/async\s+ensureZai\s*\(/);

    // zaiInstance field should NOT exist
    expect(voiceProxySource).not.toMatch(/zaiInstance\s*[:=]/);

    // zai.audio.asr.create call should NOT exist
    expect(voiceProxySource).not.toContain('zai.audio.asr.create');

    console.log('  ✓ voice-proxy.ts does not import z-ai-web-dev-sdk');
    console.log('  ✓ voice-proxy.ts does not call ensureZai()');
    console.log('  ✓ voice-proxy.ts does not call zai.audio.asr.create()');
    console.log('  ✓ z-ai dependency is fully removed from the voice ASR path');
  });
});
