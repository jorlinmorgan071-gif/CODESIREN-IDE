import { describe, expect, it } from 'vitest';
import { isVoiceEventForRecipient } from '../../src/ws/voice-event-isolation.js';

const sessionOwners = new Map([
  ['voice-a', { userId: 'user-a', projectId: 'project-a' }],
  ['voice-b', { userId: 'user-b', projectId: 'project-b' }],
]);

const resolveSession = (sessionId: string) => sessionOwners.get(sessionId);
const voiceTaskOwners = new Map([
  ['voice-task-a', { userId: 'user-a', projectId: 'project-a' }],
]);
const resolveVoiceTask = (taskId: string) => voiceTaskOwners.get(taskId);

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

  it('fails closed for an unscoped generic event', () => {
    const event = { event: 'agent:chunk', payload: { taskId: 'task-a' } } as never;
    expect(isVoiceEventForRecipient(event, { userId: 'user-b', projectId: 'project-b' }, resolveSession, resolveVoiceTask)).toBe(false);
  });

  it('delivers a scoped generic event only to the exact user and project', () => {
    const event = {
      event: 'agent:chunk',
      payload: { taskId: 'task-a', content: 'private code' },
      scope: { userId: 'user-a', projectId: 'project-a' },
    } as never;
    expect(isVoiceEventForRecipient(event, { userId: 'user-a', projectId: 'project-a' }, resolveSession, resolveVoiceTask)).toBe(true);
    expect(isVoiceEventForRecipient(event, { userId: 'user-b', projectId: 'project-b' }, resolveSession, resolveVoiceTask)).toBe(false);
    expect(isVoiceEventForRecipient(event, { userId: 'user-a', projectId: 'project-b' }, resolveSession, resolveVoiceTask)).toBe(false);
  });

  it('routes a generic agent chunk from a voice task only to its owner and project', () => {
    const event = { event: 'agent:chunk', payload: { taskId: 'voice-task-a', voiceOrigin: true, content: 'private voice content' } } as never;

    expect(isVoiceEventForRecipient(event, { userId: 'user-a', projectId: 'project-a' }, resolveSession, resolveVoiceTask)).toBe(true);
    expect(isVoiceEventForRecipient(event, { userId: 'user-b', projectId: 'project-b' }, resolveSession, resolveVoiceTask)).toBe(false);
    expect(isVoiceEventForRecipient(event, { userId: 'user-a', projectId: 'project-b' }, resolveSession, resolveVoiceTask)).toBe(false);
  });

  it('does not globally deliver a generic agent event with known invalid voice-task ownership', () => {
    const event = { event: 'agent:error', payload: { taskId: 'voice-task-a', voiceOrigin: true, error: 'private failure' } } as never;
    expect(isVoiceEventForRecipient(event, { userId: 'user-b', projectId: 'project-b' }, resolveSession, resolveVoiceTask)).toBe(false);
  });

  it('fails closed when a voice-origin generic agent event lacks resolvable ownership', () => {
    const event = { event: 'agent:chunk', payload: { taskId: 'missing-voice-task', voiceOrigin: true, content: 'private' } } as never;
    expect(isVoiceEventForRecipient(event, { userId: 'user-a', projectId: 'project-a' }, resolveSession, resolveVoiceTask)).toBe(false);
  });
});
