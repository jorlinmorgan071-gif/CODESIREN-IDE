import { describe, expect, it } from 'vitest';
import { createChatSessionId } from '../src/lib/chat-session';

describe('createChatSessionId', () => {
  it('creates unique UUIDs accepted by the authenticated chat-session API', () => {
    const first = createChatSessionId();
    const second = createChatSessionId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second).not.toBe(first);
  });
});
