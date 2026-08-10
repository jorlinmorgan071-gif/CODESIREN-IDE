// tests/unit/voice-no-zai-config.test.ts
// Directive: Voice Session z-ai Dependency — Step 4 test
//
// Reproduces Morgan's exact condition: NO .z-ai-config available. The z-ai
// SDK's ZAI.create() throws "Configuration file not found or invalid."
//
// Verifies the fix:
//   1. startSession() succeeds (returns a sessionId) — does NOT throw,
//      does NOT 500. This is the direct fix for the reported bug.
//   2. fireGreeting() broadcasts a voice:greeting WS event with text but
//      audioBase64: null (text-only fallback — TTS failed because z-ai is
//      unavailable, but the greeting text still arrives).
//   3. processTurn() (called when the user speaks) broadcasts a clean
//      voice:error WS event with "ASR failed: ..." — does NOT crash,
//      does NOT throw, does NOT leave the session in a broken state.
//
// Mocks ZAI.create() to throw the exact error the SDK throws when no
// .z-ai-config file is found. This simulates Morgan's local Windows dev
// machine where no Z.ai credentials exist.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the z-ai SDK BEFORE importing voice-proxy. The mock throws the
// exact error the real SDK throws when no config file is found.
vi.mock('z-ai-web-dev-sdk', () => ({
  default: {
    create: async () => {
      throw new Error('Configuration file not found or invalid. Please create .z-ai-config in your project, home directory, or /etc.');
    },
  },
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

  afterEach(async () => {
    // Clean up any sessions created during tests
    // voiceProxy.sessions is private, but we can call endSession on known ids
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 1: startSession() succeeds when z-ai is unavailable
  //
  // This is the direct fix for the reported bug. Before the fix,
  // startSession() called `await this.ensureZai()` which threw when
  // .z-ai-config was missing, causing POST /voice/live/start to 500.
  // After the fix, startSession() does not call ensureZai() at all —
  // the session is created without z-ai, and the HTTP endpoint returns 200.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 1: startSession() succeeds when ZAI.create() throws (no .z-ai-config)', async () => {
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
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 2: fireGreeting() broadcasts text-only greeting (audioBase64: null)
  //
  // fireGreeting() is fire-and-forget. It broadcasts the greeting text
  // immediately (audioBase64: null), THEN tries to generate audio via
  // the TTS provider. If TTS fails (z-ai unavailable), the text-only
  // greeting remains — the catch block just logs a warning.
  //
  // We need to wait for fireGreeting() to complete (including the failed
  // TTS attempt) before checking captured events.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 2: fireGreeting() broadcasts text-only greeting (audioBase64: null) when TTS fails', async () => {
    const sessionId = await voiceProxy.startSession(
      'test-user-id-2',
      '00000000-0000-0000-0000-000000000000',
      'TestUser2',
    );

    // Wait for fireGreeting() to complete (it's fire-and-forget in
    // startSession, so we need to give it time to run + fail)
    await new Promise(r => setTimeout(r, 500));

    // Find the greeting events (fireGreeting broadcasts twice:
    // once immediately with audioBase64: null, once after TTS completes
    // with audio. When TTS fails, only the first broadcast happens.)
    const greetingEvents = capturedEvents.filter(e => e.event === 'voice:greeting');

    expect(greetingEvents.length).toBeGreaterThanOrEqual(1);
    console.log(`  ✓ voice:greeting events broadcast: ${greetingEvents.length}`);

    const firstGreeting = greetingEvents[0];
    expect(firstGreeting.payload.sessionId).toBe(sessionId);
    expect(firstGreeting.payload.text).toBeTruthy();
    expect(firstGreeting.payload.text.length).toBeGreaterThan(0);
    expect(firstGreeting.payload.audioBase64).toBeNull();

    console.log(`  ✓ Greeting text: "${firstGreeting.payload.text}"`);
    console.log(`  ✓ audioBase64: null (text-only — TTS failed gracefully)`);

    // Clean up
    voiceProxy.endSession(sessionId);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 3: processTurn() broadcasts clean voice:error when ASR fails
  //
  // processTurn() is called when the user speaks (audio chunks arrive
  // via WS). It calls ensureZai() on-demand for ASR. When z-ai is
  // unavailable, ensureZai() throws, the catch block broadcasts a
  // voice:error event with "ASR failed: <message>", and processTurn()
  // returns normally — does NOT crash, does NOT throw.
  //
  // We feed a real (non-empty) audio buffer to trigger the ASR path.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 3: processTurn() broadcasts clean voice:error (not crash) when ASR fails', async () => {
    const sessionId = await voiceProxy.startSession(
      'test-user-id-3',
      '00000000-0000-0000-0000-000000000000',
      'TestUser3',
    );

    // Wait for greeting to finish (so its events don't interfere)
    await new Promise(r => setTimeout(r, 500));
    capturedEvents.length = 0;  // clear greeting events

    // Feed a real audio buffer (>1000 bytes to pass the length check)
    // This is a fake WAV header + silence — processTurn only checks length
    const fakeAudio = Buffer.alloc(2000, 0);

    // Access the private sessions Map to inject audio (processTurn reads
    // from session.audioBuffer)
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
    expect(errorEvent.payload.error).toContain('ASR failed');
    expect(errorEvent.payload.error).toContain('Configuration file not found');

    console.log(`  ✓ processTurn() did NOT throw (returned normally)`);
    console.log(`  ✓ voice:error event broadcast:`);
    console.log(`      event: ${errorEvent.event}`);
    console.log(`      sessionId: ${errorEvent.payload.sessionId}`);
    console.log(`      error: "${errorEvent.payload.error}"`);

    // Clean up
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
});
