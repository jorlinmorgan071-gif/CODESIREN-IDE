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
  projectId: string;
  startedAt: number;
  lastAudioAt: number;
  muted: boolean;
  audioBuffer: Buffer[];  // accumulated audio chunks for current turn
  zaiInstance: any | null;
}

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
   */
  async startSession(userId: string, projectId: string): Promise<string> {
    const sessionId = `voice-${uuid()}`;
    await this.ensureZai();

    const session: ActiveVoiceSession = {
      id: sessionId,
      userId,
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

    console.log(`[voice-proxy] session started: ${sessionId} for user ${userId}`);
    return sessionId;
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
