import type { AgentEvent } from '../types.js';
import { scopesMatch, type TenantScope } from '../tenancy/scope.js';

export interface VoiceEventSessionOwner {
  userId: string;
  projectId: string;
}

export interface AuthenticatedWsRecipient {
  userId: string;
  projectId?: string;
}

export type VoiceTaskOwner = VoiceEventSessionOwner;

export function isVoiceEventForRecipient(
  event: AgentEvent,
  recipient: AuthenticatedWsRecipient,
  resolveSession: (sessionId: string) => VoiceEventSessionOwner | undefined,
  resolveVoiceTask?: (taskId: string) => VoiceTaskOwner | undefined,
): boolean {
  const recipientScope: TenantScope | undefined = recipient.projectId
    ? { userId: recipient.userId, projectId: recipient.projectId }
    : undefined;
  const eventScope = event.scope;
  if (eventScope) return scopesMatch(eventScope, recipientScope);

  const payload = event.payload as { sessionId?: unknown };
  const ownsRecipient = (owner: VoiceEventSessionOwner | undefined) => Boolean(
    owner && owner.userId === recipient.userId && owner.projectId === recipient.projectId,
  );
  if (event.event.startsWith('voice:')) {
    return typeof payload?.sessionId === 'string' && ownsRecipient(resolveSession(payload.sessionId));
  }
  const agentPayload = payload as { taskId?: unknown; voiceOrigin?: unknown };
  if (agentPayload.voiceOrigin === true) {
    if (typeof agentPayload.taskId !== 'string' || !resolveVoiceTask) return false;
    return ownsRecipient(resolveVoiceTask(agentPayload.taskId));
  }
  // P0: generic events without a server-resolved scope are never delivered.
  // This turns missing metadata into a safe omission instead of cross-tenant data.
  return false;
}
