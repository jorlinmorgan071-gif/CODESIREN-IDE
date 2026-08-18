// Phase 5 runtime coordination: tiny local primitives for latest-operation wins.
// These are deliberately state-free utilities, not a provider/store or clock.

export class LatestOperationGate {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }
}

export function canAttachLipSyncNode(
  audioSource: AudioNode | null,
  audioContext: AudioContext | null,
  profile: unknown,
): audioSource is AudioNode {
  return Boolean(audioSource && audioContext && profile);
}

export function isCurrentAudioNode(current: AudioNode | null, expected: AudioNode): boolean {
  return current === expected;
}

export function isCurrentVoiceSession(
  currentGeneration: number,
  expectedGeneration: number,
  currentSessionId: string | null,
  expectedSessionId: string,
): boolean {
  return currentGeneration === expectedGeneration && currentSessionId === expectedSessionId;
}

export function isVoiceEventForSession(payload: unknown, currentSessionId: string | null): boolean {
  const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
  return typeof sessionId === 'string' && sessionId === currentSessionId;
}
