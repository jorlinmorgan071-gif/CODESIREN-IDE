// server/src/systems/voice/voice-client.ts
// VoiceClient interface + StubVoiceClient impl.
//
// Per directive Section 1: "Gemini Live voice loop → Voice Command System
// (upgraded). Still routes through AgentManager.send() like any typed message."
//
// Per directive Section 7: "A spoken command and a typed command must resolve
// to the SAME AgentTask shape and travel through the SAME AgentManager.send()
// call. Voice is a transport, not a second brain."
//
// The VoiceClient interface abstracts the voice recognition layer. The stub
// simulates transcripts. The real Gemini Live impl (deployment-time) captures
// audio, sends it to Gemini, and returns recognized text. In BOTH cases, the
// transcript is handed to AgentManager.send() as an AgentTask with
// origin: 'voice' — the SAME path as typed chat (origin: 'chat').

// ── Types ────────────────────────────────────────────────────────────────

export interface VoiceSession {
  id: string;
  startedAt: number;
  active: boolean;
}

export interface VoiceTranscript {
  text: string;
  confidence: number;
  isFinal: boolean;
}

// ── VoiceClient interface ────────────────────────────────────────────────

export interface VoiceClient {
  readonly implementation: string;  // 'stub' | 'gemini-live'

  /** Start a voice session (opens audio stream in real impl). */
  startSession(): Promise<VoiceSession>;

  /** Stop a voice session. */
  stopSession(sessionId: string): Promise<void>;

  /**
   * Simulate receiving a voice transcript. In the real impl, this is called
   * when Gemini Live returns recognized text. In the stub, it returns the
   * input text directly as a transcript.
   *
   * The CALLER (voice route) is responsible for converting this transcript
   * into an AgentTask with origin: 'voice' and sending it through
   * AgentManager.send() — the SAME path as typed chat.
   */
  transcribe(audioData: unknown): Promise<VoiceTranscript>;

  /** Get the current session status. */
  getSessionStatus(sessionId: string): VoiceSession | null;
}

// ── StubVoiceClient ──────────────────────────────────────────────────────

export class StubVoiceClient implements VoiceClient {
  readonly implementation = 'stub';

  private sessions = new Map<string, VoiceSession>();

  async startSession(): Promise<VoiceSession> {
    const session: VoiceSession = {
      id: `voice-session-${Date.now()}`,
      startedAt: Date.now(),
      active: true,
    };
    this.sessions.set(session.id, session);
    console.log(`[voice] session started: ${session.id}`);
    return session;
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.active = false;
      console.log(`[voice] session stopped: ${sessionId}`);
    }
  }

  async transcribe(audioData: unknown): Promise<VoiceTranscript> {
    // Stub: if audioData is a string, use it directly as the transcript.
    // This lets the e2e test simulate voice input by passing text.
    const text = typeof audioData === 'string' ? audioData : '(unrecognized)';
    return {
      text,
      confidence: 0.95,
      isFinal: true,
    };
  }

  getSessionStatus(sessionId: string): VoiceSession | null {
    return this.sessions.get(sessionId) ?? null;
  }
}

// ── Dependency injection ─────────────────────────────────────────────────

let activeVoiceClient: VoiceClient = new StubVoiceClient();

export function getVoiceClient(): VoiceClient {
  return activeVoiceClient;
}

export function setVoiceClient(client: VoiceClient): void {
  activeVoiceClient = client;
  console.log(`[voice-client] active implementation: ${client.implementation}`);
}
