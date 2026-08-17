// Session-only VRMA selection. A selected animation remains a browser-local
// object URL and is never uploaded, persisted, or added to the asset catalog.

import type { AvatarMotionState } from './avatar-motion';

export const MAX_LOCAL_VRMA_BYTES = 25 * 1024 * 1024;

export const LOCAL_VRMA_TARGET_STATES = [
  'idle',
  'listening',
  'thinking',
  'celebrate',
  'gesture',
  'bored',
  'rest',
  'wake',
] as const satisfies readonly AvatarMotionState[];

export type LocalVrmaTargetState = (typeof LOCAL_VRMA_TARGET_STATES)[number];

export interface LocalVrmaSession {
  url: string;
  fileName: string;
  sizeBytes: number;
  targetState: LocalVrmaTargetState;
}

export type LocalVrmaRegistry = Partial<Record<LocalVrmaTargetState, LocalVrmaSession>>;

export function validateLocalVrmaFile(file: Pick<File, 'name' | 'size'>): string | null {
  if (!/\.vrma$/i.test(file.name)) {
    return 'Choose a VRM Animation (.vrma) file.';
  }
  if (file.size <= 0) {
    return 'The selected VRM Animation file is empty.';
  }
  if (file.size > MAX_LOCAL_VRMA_BYTES) {
    return 'The selected VRM Animation is larger than the 25 MiB session limit.';
  }
  return null;
}

export function createLocalVrmaSession(file: File, targetState: LocalVrmaTargetState): LocalVrmaSession {
  const validationError = validateLocalVrmaFile(file);
  if (validationError) throw new Error(validationError);

  return {
    url: URL.createObjectURL(file),
    fileName: file.name,
    sizeBytes: file.size,
    targetState,
  };
}

export function revokeLocalVrmaSession(session: LocalVrmaSession | null): void {
  if (session?.url.startsWith('blob:')) {
    URL.revokeObjectURL(session.url);
  }
}

export function getLocalVrmaRegistryEntries(registry: LocalVrmaRegistry): LocalVrmaSession[] {
  return LOCAL_VRMA_TARGET_STATES
    .map((state) => registry[state])
    .filter((session): session is LocalVrmaSession => Boolean(session));
}

export function setLocalVrmaRegistryEntry(
  registry: LocalVrmaRegistry,
  session: LocalVrmaSession,
): LocalVrmaRegistry {
  return { ...registry, [session.targetState]: session };
}

export function removeLocalVrmaRegistryEntry(
  registry: LocalVrmaRegistry,
  targetState: LocalVrmaTargetState,
): LocalVrmaRegistry {
  const remaining = { ...registry };
  delete remaining[targetState];
  return remaining;
}

export function revokeLocalVrmaRegistry(registry: LocalVrmaRegistry): void {
  for (const session of getLocalVrmaRegistryEntries(registry)) {
    revokeLocalVrmaSession(session);
  }
}
