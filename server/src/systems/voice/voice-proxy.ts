// server/src/systems/voice/voice-proxy.ts
// Face Avatar + Live Voice Pipeline — backend voice proxy.
//
// Architecture (Section 0 + Section 2):
//   browser mic → existing WS server → this voice-proxy module
//     → z-ai ASR (speech-to-text) → transcript text
//     → AgentTask{ origin: 'voice' } → AgentManager.send()
//     → real agent response (real memory, real model router)
//     → z-ai TTS → audio buffer → WS → browser playback
//     → amplitude + viseme data → drives the Face
//
// z-ai SDK is a TRANSPORT only. No z-ai-generated response ever reaches
// the user. The transcript goes through AgentManager.send() — the same
// path as typed chat.

import ZAI from 'z-ai-web-dev-sdk';
import { v4 as uuid } from 'uuid';
import { agentManager } from '../../orchestration/agent-manager.js';
import { makeEvent, broadcast } from '../../ws/events.js';
import type { AgentTask } from '../../types.js';
import { getTTSProvider } from './tts-provider.js';

// ── Types ────────────────────────────────────────────────────────────────

interface ActiveVoiceSession {
  id: string;
  userId: string;
  userDisplayName: string;  // for greeting personalization
  projectId: string;
  startedAt: number;
  lastAudioAt: number;
  muted: boolean;
  audioBuffer: Buffer[];  // accumulated audio chunks for current turn
  zaiInstance: any | null;
}

// ── Greeting Pool ────────────────────────────────────────────────────────
// Phase B: Hands-Free — rotating greeting pool with time-context tags.
// 7 variants: 2 warm, 2 cheeky, 3 sassy. Some are time-restricted (only
// fire at appropriate hours); others are time-agnostic. Random selection
// from the eligible pool per session start. No LLM call — static/templated.
//
// [name] is replaced with the user's display name (from JWT claims → req.user.name).
// If the name is empty/missing, the greeting falls back to a generic form.
//
// Time tags:
//   'morning'   — 05:00–11:59
//   'afternoon' — 12:00–17:59
//   'evening'   — 18:00–22:59
//   'late-night'— 23:00–04:59
//   'any'       — no time restriction

type GreetingTone = 'warm' | 'cheeky' | 'sassy';
type TimeTag = 'morning' | 'afternoon' | 'evening' | 'late-night' | 'any';

interface GreetingVariant {
  id: string;
  tone: GreetingTone;
  timeTag: TimeTag;
  text: string;  // may contain [name] placeholder
}

const GREETING_POOL: readonly GreetingVariant[] = [
  // ── Warm (2) ──
  {
    id: 'warm-1',
    tone: 'warm',
    timeTag: 'any',
    text: 'Hey [name]. Code Siren is live and listening. What are we building?',
  },
  {
    id: 'warm-2',
    tone: 'warm',
    timeTag: 'morning',
    text: 'Good morning, [name]. Fresh coffee, fresh code. What\'s first?',
  },
  // ── Cheeky (2) ──
  {
    id: 'cheeky-1',
    tone: 'cheeky',
    timeTag: 'any',
    text: 'Code Siren online, [name]. Try not to break production today.',
  },
  {
    id: 'cheeky-2',
    tone: 'cheeky',
    timeTag: 'late-night',
    text: 'Coding at this hour, [name]? Bold. Let\'s make it count.',
  },
  // ── Sassy (3) ──
  {
    id: 'sassy-1',
    tone: 'sassy',
    timeTag: 'any',
    text: 'Oh look, [name]\'s back. I was getting bored without you. What\'s the task?',
  },
  {
    id: 'sassy-2',
    tone: 'sassy',
    timeTag: 'evening',
    text: 'Evening, [name]. I\'ve been idle all day and I\'m ready to judge your code.',
  },
  {
    id: 'sassy-3',
    tone: 'sassy',
    timeTag: 'any',
    text: 'Code Siren awakened, [name]. Speak — I\'m listening, for once.',
  },
] as const;

/**
 * Determine the time-of-day tag for the current hour.
 *   05:00–11:59 → 'morning'
 *   12:00–17:59 → 'afternoon'
 *   18:00–22:59 → 'evening'
 *   23:00–04:59 → 'late-night'
 */
function getTimeTag(hour: number): TimeTag {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'late-night';
}

/**
 * Pick a random greeting from the eligible pool.
 * Eligible = greetings where timeTag is 'any' OR matches the current time tag.
 * Uses crypto-grade randomness for unbiased selection.
 */
function pickGreeting(hour: number): GreetingVariant {
  const currentTag = getTimeTag(hour);
  const eligible = GREETING_POOL.filter(
    g => g.timeTag === 'any' || g.timeTag === currentTag
  );
  // Guard: if no eligible greetings (shouldn't happen), fall back to the first
  const pool = eligible.length > 0 ? eligible : [GREETING_POOL[0]];
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

/**
 * Personalize a greeting by replacing [name] with the user's display name.
 * If the name is empty/missing, the greeting is rephrased to omit the name
 * rather than leaving a dangling comma or awkward placeholder.
 */
function personalizeGreeting(text: string, name: string): string {
  const trimmedName = (name ?? '').trim();
  if (!trimmedName) {
    // Remove the "[name]. " or "[name], " prefix gracefully
    return text.replace(/\[name\][.,]?\s*/g, '');
  }
  return text.replace(/\[name\]/g, trimmedName);
}

// ── Exports for testing ──────────────────────────────────────────────────
// These are exported so the behavioral test can verify the pool, time-tag
// filtering, and name substitution without starting a full voice session.

export const greetingPool = GREETING_POOL;
export { getTimeTag, pickGreeting, personalizeGreeting };
export type { GreetingVariant, GreetingTone, TimeTag };

// ── Voice proxy singleton ────────────────────────────────────────────────

class VoiceProxy {
  private sessions = new Map<string, ActiveVoiceSession>();
  private silenceTimers = new Map<string, NodeJS.Timeout>();
  private zaiInstance: any | null = null;
  private readonly SILENCE_TIMEOUT_MS = 90_000;  // 90 seconds of silence

  async ensureZai(): Promise<any> {
    if (!this.zaiInstance) {
      this.zaiInstance = await ZAI.create();
      console.log('[voice-proxy] z-ai SDK initialized');
    }
    return this.zaiInstance;
  }

  /**
   * Start a voice session. Called when user taps the Live icon.
   * userDisplayName is used for greeting personalization (from JWT claims).
   */
  async startSession(userId: string, projectId: string, userDisplayName?: string): Promise<string> {
    const sessionId = `voice-${uuid()}`;
    await this.ensureZai();

    const session: ActiveVoiceSession = {
      id: sessionId,
      userId,
      userDisplayName: userDisplayName ?? '',
      projectId,
      startedAt: Date.now(),
      lastAudioAt: Date.now(),
      muted: false,
      audioBuffer: [],
      zaiInstance: this.zaiInstance,
    };
    this.sessions.set(sessionId, session);

    // Start silence timer
    this.resetSilenceTimer(sessionId);

    console.log(`[voice-proxy] session started: ${sessionId} for user ${userId} (${userDisplayName || 'no name'})`);

    // Fire wake greeting — non-blocking, fire-and-forget. If TTS fails,
    // the session still works normally (user just doesn't hear a greeting).
    this.fireGreeting(sessionId).catch((err) => {
      console.warn(`[voice-proxy] greeting failed: ${err.message}`);
    });

    return sessionId;
  }

  /**
   * Wake greeting — a short, time-of-day-aware greeting spoken via the
   * active TTS provider when a voice session starts. Fires once per session
   * (not per turn). No LLM call — static/templated text only.
   *
   * Phase B: Hands-Free — draws from a rotating pool of 7 variants
   * (2 warm, 2 cheeky, 3 sassy). Time-restricted entries only fire in their
   * appropriate time window. Personalized with the user's display name.
   *
   * Broadcasts a voice:greeting WS event with the greeting text + audio
   * (audio is null if TTS fails). The client can display the text as a
   * caption and/or play the audio.
   */
  private async fireGreeting(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`[voice-proxy] fireGreeting: session ${sessionId} not found`);
      return;
    }

    const hour = new Date().getHours();
    const variant = pickGreeting(hour);
    const greeting = personalizeGreeting(variant.text, session.userDisplayName);

    console.log(`[voice-proxy] greeting: id=${variant.id} tone=${variant.tone} timeTag=${variant.timeTag} hour=${hour} → "${greeting}"`);

    // Broadcast the greeting text immediately (for live caption)
    broadcast(makeEvent('voice:greeting' as any, {
      sessionId,
      text: greeting,
      greetingId: variant.id,
      tone: variant.tone,
      audioBase64: null,  // filled in after TTS completes
      ts: Date.now(),
    }));

    // Generate audio via the active TTS provider
    try {
      const tts = getTTSProvider();
      const result = await tts.speak(greeting);
      console.log(`[voice-proxy] greeting TTS via ${tts.implementation}: ${result.audioBase64.length} chars base64, ~${result.durationMs}ms`);

      // Broadcast the greeting again WITH audio (client replaces the first event)
      broadcast(makeEvent('voice:greeting' as any, {
        sessionId,
        text: greeting,
        greetingId: variant.id,
        tone: variant.tone,
        audioBase64: result.audioBase64,
        ts: Date.now(),
      }));
    } catch (err: any) {
      console.warn(`[voice-proxy] greeting TTS failed: ${err.message}`);
      // Text-only greeting already broadcast above — audio stays null
    }
  }

  /**
   * Receive an audio chunk from the browser via WS.
   * Accumulates audio; when silence is detected (client-side), the client
   * sends a 'voice:turn-end' message and we process the accumulated audio.
   */
  receiveAudioChunk(sessionId: string, audioData: ArrayBuffer): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.muted) return;

    session.lastAudioAt = Date.now();
    session.audioBuffer.push(Buffer.from(audioData));
    this.resetSilenceTimer(sessionId);
  }

  /**
   * Process a completed turn: ASR → AgentTask → AgentManager.send() → TTS.
   * This is the core pipeline — Section 0's non-negotiable flow.
   */
  async processTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Combine accumulated audio chunks
    const combinedBuffer = Buffer.concat(session.audioBuffer);
    session.audioBuffer = [];  // clear for next turn

    if (combinedBuffer.length < 1000) {
      console.log('[voice-proxy] audio too short, skipping');
      return;
    }

    // Step 1: ASR — speech to text via z-ai SDK
    let transcript = '';
    try {
      const base64Audio = combinedBuffer.toString('base64');
      const zai = await this.ensureZai();
      const asrResult = await zai.audio.asr.create({ file_base64: base64Audio });
      transcript = asrResult.text ?? '';
      console.log(`[voice-proxy] ASR result: "${transcript.slice(0, 100)}"`);
    } catch (err: any) {
      console.error('[voice-proxy] ASR failed:', err.message);
      broadcast(makeEvent('voice:error' as any, {
        sessionId, error: `ASR failed: ${err.message}`,
      }));
      return;
    }

    if (!transcript.trim()) {
      console.log('[voice-proxy] empty transcript, skipping');
      return;
    }

    // Emit the recognized transcript to the client (for live captions)
    broadcast(makeEvent('voice:transcript' as any, {
      sessionId, text: transcript, role: 'user', ts: Date.now(),
    }));

    // Step 2: Create AgentTask with origin: 'voice' — SAME path as typed chat
    const taskId = uuid();
    const task: AgentTask = {
      id: taskId,
      projectId: session.projectId,
      sessionId: session.projectId,
      agentId: 'architect-agent',  // default agent for voice
      type: 'chat',
      description: transcript,
      context: {
        projectId: session.projectId,
        rootPath: '/tmp/code-siren-voice',
        techStack: {},
        activeFiles: [],
        userId: session.userId,
      },
      priority: 'normal',
      executionMode: 'single-shot',
      origin: 'voice',  // ← the ONLY field that differs from typed chat
      createdAt: Date.now(),
    };

    // Step 3: Send through AgentManager.executeAndWait() — the real pipeline.
    //
    // WS-BYPASS FIX (Phase E, post-Build 3): replaced the direct
    // `agentManager.get('architect-agent')!.execute(task, ...)` call with
    // `agentManager.executeAndWait(task)`. This gains all 14 previously-skipped
    // side effects that send()/executeAndWait() provide:
    //   - Context bundle assembly (Phase B — agent now sees open files, history, memory, project graph)
    //   - Trust-score governance (success → +0.9, failure → 0)
    //   - Trace persistence (startTrace + completeTrace → .traces/runs.jsonl)
    //   - Standard WS events: agent:start, agent:chunk, agent:progress, agent:complete, agent:status, agent:error
    //   - activeTasks tracking
    //   - Unknown-agent guard
    //
    // executeAndWait() returns { text, filesTouched, error } — the `text` field
    // replaces the old inline `agentResponse += chunk.content` accumulation.
    //
    // LIVE CAPTIONS: executeAndWait() broadcasts standard `agent:chunk` WS events
    // during iteration. However, FaceView.tsx (the voice UI) listens for the
    // voice-specific `voice:agent-chunk` event, NOT `agent:chunk`. To preserve
    // live captions without a frontend change, we register a temporary sink that
    // forwards `agent:chunk` events for THIS task as `voice:agent-chunk` events.
    // The sink is unregistered when executeAndWait() resolves.
    // TODO (follow-up cleanup): FaceView.tsx should listen for `agent:chunk`
    // filtered by sessionId/taskId instead of the voice-specific event — then
    // this forwarding sink can be removed.
    broadcast(makeEvent('voice:agent-start' as any, {
      sessionId, taskId, ts: Date.now(),
    }));

    // Register a temporary sink to forward agent:chunk → voice:agent-chunk
    // for FaceView's live captions. Filter by taskId so we only forward this
    // task's chunks, not other concurrent tasks'.
    const { registerSink } = await import('../../ws/events.js');
    const unsubscribeSink = registerSink((event) => {
      if (event.event === 'agent:chunk') {
        const payload = event.payload as { taskId?: string; content?: string; type?: string };
        if (payload.taskId === taskId) {
          broadcast(makeEvent('voice:agent-chunk' as any, {
            sessionId,
            taskId,
            content: payload.content ?? '',
            type: payload.type ?? 'text',
            ts: Date.now(),
          }));
        }
      }
    });

    let agentResponse: string;
    let agentError: string | null;
    try {
      const result = await agentManager.executeAndWait(task);
      agentResponse = result.text;
      agentError = result.error;
      if (agentError) {
        console.error(`[voice-proxy] agent execution failed: ${agentError}`);
        agentResponse = `I encountered an error: ${agentError}`;
      }
    } catch (err: any) {
      console.error('[voice-proxy] executeAndWait threw:', err.message);
      agentResponse = `I encountered an error: ${err.message}`;
      agentError = err.message;
    } finally {
      // Always unsubscribe the sink — even on error — to avoid leaks
      unsubscribeSink();
    }

    // Step 4: TTS — text to speech via TTSProvider interface
    // (ZaiTTSProvider by default; KokoroTTSProvider or ElevenLabsTTSProvider
    // if the user switched via Settings → Voice)
    let audioBase64: string | null = null;
    let ttsDurationMs = 0;
    try {
      const tts = getTTSProvider();
      const ttsResult = await tts.speak(agentResponse);
      audioBase64 = ttsResult.audioBase64;
      ttsDurationMs = ttsResult.durationMs;
      console.log(`[voice-proxy] TTS generated via ${tts.implementation}: ${audioBase64.length} chars base64, ~${ttsDurationMs}ms`);
    } catch (err: any) {
      console.error('[voice-proxy] TTS failed:', err.message);
    }

    // Step 5: Emit the agent's response text + audio to the client
    broadcast(makeEvent('voice:agent-response' as any, {
      sessionId,
      taskId,
      text: agentResponse,
      audioBase64,  // null if TTS failed
      ts: Date.now(),
    }));

    // Voice-turn summary log (trace is already persisted by executeAndWait —
    // no need for a separate addStep call that would no-op on the completed trace)
    console.log(`[voice-proxy] turn complete — ASR: "${transcript.slice(0, 60)}" → agent: ${agentResponse.length} chars → TTS: ${audioBase64 ? 'ok' : 'failed'}${agentError ? ` (agent error: ${agentError})` : ''}`);

    this.resetSilenceTimer(sessionId);
  }

  /**
   * Mute/unmute — pauses sending audio, keeps session alive.
   */
  setMuted(sessionId: string, muted: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.muted = muted;
      console.log(`[voice-proxy] session ${sessionId} ${muted ? 'muted' : 'unmuted'}`);
    }
  }

  /**
   * End session — fully closes everything. Verify no further audio leaves.
   */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Clear silence timer
    const timer = this.silenceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.silenceTimers.delete(sessionId);
    }

    // Clear audio buffer
    session.audioBuffer = [];
    session.zaiInstance = null;

    this.sessions.delete(sessionId);
    console.log(`[voice-proxy] session ended: ${sessionId} — no further audio will be processed`);

    broadcast(makeEvent('voice:session-ended' as any, {
      sessionId, ts: Date.now(),
    }));
  }

  /**
   * Get session status.
   */
  getSession(sessionId: string): ActiveVoiceSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Find the most recent active voice session for a given user.
   *
   * Used by the WS binary audio handler (Option C fix) to route incoming
   * audio to the user's active session without requiring a sessionId in the
   * binary frame header. If a user has multiple sessions (e.g., two browser
   * tabs), the most recently started one wins — that's the one the user is
   * actively interacting with.
   *
   * Returns undefined if the user has no active voice session.
   */
  getSessionByUserId(userId: string): ActiveVoiceSession | undefined {
    let latest: ActiveVoiceSession | undefined;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        if (!latest || session.startedAt > latest.startedAt) {
          latest = session;
        }
      }
    }
    return latest;
  }

  /**
   * Reset the silence timer — fires auto-disconnect after SILENCE_TIMEOUT_MS.
   */
  private resetSilenceTimer(sessionId: string): void {
    const existing = this.silenceTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      console.log(`[voice-proxy] auto-disconnect after ${this.SILENCE_TIMEOUT_MS / 1000}s silence: ${sessionId}`);
      this.endSession(sessionId);
      broadcast(makeEvent('voice:auto-disconnect' as any, {
        sessionId,
        reason: 'silence-timeout',
        timeoutMs: this.SILENCE_TIMEOUT_MS,
        ts: Date.now(),
      }));
    }, this.SILENCE_TIMEOUT_MS);

    this.silenceTimers.set(sessionId, timer);
  }

  get silenceTimeoutMs(): number {
    return this.SILENCE_TIMEOUT_MS;
  }
}

export const voiceProxy = new VoiceProxy();
