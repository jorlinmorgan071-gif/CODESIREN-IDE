import { describe, expect, it } from 'vitest';
import { isVoiceEventForRecipient } from '../../src/ws/voice-event-isolation.js';

const sessionOwners = new Map([
  ['voice-a', { userId: 'user-a', projectId: 'project-a' }],
  ['voice-b', { userId: 'user-b', projectId: 'project-b' }],
]);

const resolveSession = (sessionId: string) => sessionOwners.get(sessionId);

describe('voice WebSocket recipient isolation', () => {
  it('delivers a voice event only to its authenticated owner and project', () => {
    const event = { event: 'voice:agent-response', payload: { sessionId: 'voice-a', text: 'private' } } as never;

    expect(isVoiceEventForRecipient(event, { userId: 'user-a', projectId: 'project-a' }, resolveSession)).toBe(true);
    expect(isVoiceEventForRecipient(event, { userId: 'user-b', projectId: 'project-b' }, resolveSession)).toBe(false);
    expect(isVoiceEventForRecipient(event, { userId: 'user-a', projectId: 'project-b' }, resolveSession)).toBe(false);
  });

  it('rejects voice events with a missing, unknown, or non-string session identity', () => {
    const recipient = { userId: 'user-a', projectId: 'project-a' };
    expect(isVoiceEventForRecipient({ event: 'voice:greeting', payload: {} } as never, recipient, resolveSession)).toBe(false);
    expect(isVoiceEventForRecipient({ event: 'voice:greeting', payload: { sessionId: 'missing' } } as never, recipient, resolveSession)).toBe(false);
    expect(isVoiceEventForRecipient({ event: 'voice:greeting', payload: { sessionId: 42 } } as never, recipient, resolveSession)).toBe(false);
  });

  it('does not alter non-voice delivery semantics', () => {
    const event = { event: 'agent:chunk', payload: { taskId: 'task-a' } } as never;
    expect(isVoiceEventForRecipient(event, { userId: 'user-b', projectId: 'project-b' }, resolveSession)).toBe(true);
  });
});
