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
