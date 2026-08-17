import type { AgentEvent } from '../types.js';

export interface VoiceEventSessionOwner {
  userId: string;
  projectId: string;
}

export interface AuthenticatedWsRecipient {
  userId: string;
  projectId?: string;
}

export function isVoiceEventForRecipient(
  event: AgentEvent,
  recipient: AuthenticatedWsRecipient,
  resolveSession: (sessionId: string) => VoiceEventSessionOwner | undefined,
): boolean {
  if (!event.event.startsWith('voice:')) return true;
  const payload = event.payload as { sessionId?: unknown };
  if (typeof payload?.sessionId !== 'string') return false;
  const session = resolveSession(payload.sessionId);
  return Boolean(session && session.userId === recipient.userId && session.projectId === recipient.projectId);
}
