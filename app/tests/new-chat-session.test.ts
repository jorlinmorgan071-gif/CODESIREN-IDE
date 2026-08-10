// tests/new-chat-session.test.ts
// Directive #1 — New Chat Session-Creation Bug: real evidence test.
//
// Reproduces the EXACT bug chain described in the directive:
//   1. handleNewChat() generates a new chatId and sets it active
//   2. Bug (before fix): no ChatSession entry was created → ADD_CHAT_MESSAGE
//      silently no-ops → user sees empty chat panel
//   3. Fix (after): CREATE_CHAT_SESSION appends a real session entry BEFORE
//      SET_ACTIVE_CHAT → ADD_CHAT_MESSAGE finds the session → message renders
//
// Tests against the REAL appReducer + REAL initialState from AppContext.tsx.
// No mocks of the reducer — exercises the actual production code path.

import { describe, it, expect } from 'vitest';
import { appReducer, initialState } from '../src/store/AppContext';
import { filterChatSessions, getRecentChats } from '../src/components/sidebar/chat-list-utils';
import type { ChatMessage, ChatSession } from '../src/types';

// ── Helpers ────────────────────────────────────────────────────────────

function genId(): string {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeUserMessage(content: string): ChatMessage {
  return {
    id: genId(),
    role: 'user',
    content,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

function makeAssistantMessage(): ChatMessage {
  return {
    id: genId(),
    role: 'assistant',
    content: '',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    agentName: 'Code Siren',
    isStreaming: true,
  };
}

// Reproduce the EXACT handleNewChat() logic from Home.tsx (kept for
// reference — the actual tests below inline the dispatch sequence so
// each step can be asserted against intermediate state).
// function handleNewChat(state: AppState, dispatchLog: AppAction[]): AppState {
//   const newChatId = `cs-${Date.now()}`;
//   const newSession: ChatSession = {
//     id: newChatId,
//     name: 'New Chat',
//     messages: [],
//     isActive: false,
//   };
//   dispatchLog.push({ type: 'CREATE_CHAT_SESSION', payload: { session: newSession } });
//   dispatchLog.push({ type: 'SET_ACTIVE_CHAT', payload: newChatId });
//   return newChatId;
// }
void null;

// ── Tests ──────────────────────────────────────────────────────────────

describe('Directive #1 — New Chat Session-Creation Bug', () => {

  // ════════════════════════════════════════════════════════════════════
  // TEST 1: Bug reproduction — without CREATE_CHAT_SESSION, message is
  // silently dropped. Proves the bug existed and that ADD_CHAT_MESSAGE
  // alone cannot fix it.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 1: bug reproduction — SET_ACTIVE_CHAT alone leaves no session for ADD_CHAT_MESSAGE to find', () => {
    const state0 = JSON.parse(JSON.stringify(initialState));
    const initialSessionCount = state0.chatSessions.length;

    // Bug path: only SET_ACTIVE_CHAT, no CREATE_CHAT_SESSION
    const newChatId = `cs-bug-${Date.now()}`;
    const state1 = appReducer(state0, { type: 'SET_ACTIVE_CHAT', payload: newChatId });

    // Session count did NOT increase — no session was created
    expect(state1.chatSessions.length).toBe(initialSessionCount);

    // activeChatId points to a session that doesn't exist
    expect(state1.activeChatId).toBe(newChatId);
    const activeChat = state1.chatSessions.find(c => c.id === state1.activeChatId);
    expect(activeChat).toBeUndefined();

    // Now add a message — it silently no-ops
    const userMsg = makeUserMessage('hello world');
    const state2 = appReducer(state1, {
      type: 'ADD_CHAT_MESSAGE',
      payload: { sessionId: newChatId, message: userMsg },
    });

    // Session count STILL unchanged — message was dropped
    expect(state2.chatSessions.length).toBe(initialSessionCount);

    // No session has the new message
    const sessionWithMessage = state2.chatSessions.find(s => s.messages.some(m => m.id === userMsg.id));
    expect(sessionWithMessage).toBeUndefined();

    console.log('  ✓ Bug confirmed: SET_ACTIVE_CHAT alone → no session created → message silently dropped');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 2: Fix verification — CREATE_CHAT_SESSION before SET_ACTIVE_CHAT
  // makes the session exist, then ADD_CHAT_MESSAGE finds it and appends.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 2: fix — CREATE_CHAT_SESSION then SET_ACTIVE_CHAT → message renders', () => {
    const state0 = JSON.parse(JSON.stringify(initialState));
    const initialSessionCount = state0.chatSessions.length;

    // Fix path: CREATE_CHAT_SESSION FIRST, then SET_ACTIVE_CHAT
    const newChatId = `cs-fix-${Date.now()}`;
    const newSession: ChatSession = {
      id: newChatId,
      name: 'New Chat',
      messages: [],
      isActive: false,
    };
    const state1 = appReducer(state0, { type: 'CREATE_CHAT_SESSION', payload: { session: newSession } });

    // Session count increased by 1
    expect(state1.chatSessions.length).toBe(initialSessionCount + 1);

    // New session is in the list (at the end — pure append)
    const createdSession = state1.chatSessions.find(c => c.id === newChatId);
    expect(createdSession).toBeDefined();
    expect(createdSession?.messages).toEqual([]);
    expect(createdSession?.isActive).toBe(false); // SET_ACTIVE_CHAT hasn't run yet

    // Now set active
    const state2 = appReducer(state1, { type: 'SET_ACTIVE_CHAT', payload: newChatId });

    // activeChatId points to the new session
    expect(state2.activeChatId).toBe(newChatId);
    const activeChat = state2.chatSessions.find(c => c.id === state2.activeChatId);
    expect(activeChat).toBeDefined();
    expect(activeChat?.isActive).toBe(true);

    // Other sessions have isActive=false
    const otherSessions = state2.chatSessions.filter(c => c.id !== newChatId);
    expect(otherSessions.every(s => s.isActive === false)).toBe(true);

    // Now add a user message — it should find the session and append
    const userMsg = makeUserMessage('hello from new chat');
    const state3 = appReducer(state2, {
      type: 'ADD_CHAT_MESSAGE',
      payload: { sessionId: newChatId, message: userMsg },
    });

    // Session count unchanged (we didn't add another session)
    expect(state3.chatSessions.length).toBe(initialSessionCount + 1);

    // The new session now has 1 message — the one we just added
    const sessionWithMsg = state3.chatSessions.find(c => c.id === newChatId);
    expect(sessionWithMsg?.messages.length).toBe(1);
    expect(sessionWithMsg?.messages[0].id).toBe(userMsg.id);
    expect(sessionWithMsg?.messages[0].content).toBe('hello from new chat');
    expect(sessionWithMsg?.messages[0].role).toBe('user');

    console.log('  ✓ Fix confirmed: CREATE_CHAT_SESSION → SET_ACTIVE_CHAT → ADD_CHAT_MESSAGE finds session → message renders');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 3: Full handleNewChat() + handleSend() simulation — user message
  // AND assistant placeholder both render in the new session.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 3: full flow — New Chat → send message → both user + assistant messages render', () => {
    const state0 = JSON.parse(JSON.stringify(initialState));
    const initialSessionCount = state0.chatSessions.length;

    // Step 1: handleNewChat() — CREATE_CHAT_SESSION + SET_ACTIVE_CHAT
    const newChatId = `cs-${Date.now()}`;
    const newSession: ChatSession = {
      id: newChatId,
      name: 'New Chat',
      messages: [],
      isActive: false,
    };
    let state = appReducer(state0, { type: 'CREATE_CHAT_SESSION', payload: { session: newSession } });
    state = appReducer(state, { type: 'SET_ACTIVE_CHAT', payload: newChatId });

    // Verify session exists and is active
    expect(state.chatSessions.length).toBe(initialSessionCount + 1);
    expect(state.activeChatId).toBe(newChatId);

    // Step 2: handleSend() — add user message
    const userMsg = makeUserMessage('What is 2+2?');
    state = appReducer(state, {
      type: 'ADD_CHAT_MESSAGE',
      payload: { sessionId: newChatId, message: userMsg },
    });

    // Step 3: handleSend() — add assistant placeholder (streaming)
    const assistantMsg = makeAssistantMessage();
    state = appReducer(state, {
      type: 'ADD_CHAT_MESSAGE',
      payload: { sessionId: newChatId, message: assistantMsg },
    });

    // Both messages should be in the new session
    const session = state.chatSessions.find(c => c.id === newChatId);
    expect(session?.messages.length).toBe(2);
    expect(session?.messages[0].role).toBe('user');
    expect(session?.messages[0].content).toBe('What is 2+2?');
    expect(session?.messages[1].role).toBe('assistant');
    expect(session?.messages[1].isStreaming).toBe(true);

    console.log('  ✓ Full flow: New Chat → user msg + assistant placeholder both render in new session');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 4: No cross-contamination — switching to an existing chat
  // doesn't leak messages from the new chat, and vice versa.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 4: no cross-contamination — switch new → existing → back → messages isolated', () => {
    const state0 = JSON.parse(JSON.stringify(initialState));
    const initialSessionCount = state0.chatSessions.length;

    // Sanity: initialState has at least 1 existing session to switch to
    expect(initialSessionCount).toBeGreaterThan(0);
    const existingSessionId = state0.chatSessions[0].id;
    const existingSessionMessageCount = state0.chatSessions[0].messages.length;

    // Step 1: Create new chat + set active
    const newChatId = `cs-${Date.now()}`;
    const newSession: ChatSession = {
      id: newChatId,
      name: 'New Chat',
      messages: [],
      isActive: false,
    };
    let state = appReducer(state0, { type: 'CREATE_CHAT_SESSION', payload: { session: newSession } });
    state = appReducer(state, { type: 'SET_ACTIVE_CHAT', payload: newChatId });

    // Step 2: Add a message to the NEW chat
    const newChatMsg = makeUserMessage('message in new chat');
    state = appReducer(state, {
      type: 'ADD_CHAT_MESSAGE',
      payload: { sessionId: newChatId, message: newChatMsg },
    });

    // Verify new chat has 1 message, existing chat unchanged
    let newChat = state.chatSessions.find(c => c.id === newChatId);
    let existingChat = state.chatSessions.find(c => c.id === existingSessionId);
    expect(newChat?.messages.length).toBe(1);
    expect(existingChat?.messages.length).toBe(existingSessionMessageCount); // unchanged

    // Step 3: Switch to existing chat
    state = appReducer(state, { type: 'SET_ACTIVE_CHAT', payload: existingSessionId });

    // Verify activeChatId switched
    expect(state.activeChatId).toBe(existingSessionId);

    // Verify existing chat is now active, new chat is not
    existingChat = state.chatSessions.find(c => c.id === existingSessionId);
    newChat = state.chatSessions.find(c => c.id === newChatId);
    expect(existingChat?.isActive).toBe(true);
    expect(newChat?.isActive).toBe(false);

    // Step 4: Add a message to the EXISTING chat
    const existingChatMsg = makeUserMessage('message in existing chat');
    state = appReducer(state, {
      type: 'ADD_CHAT_MESSAGE',
      payload: { sessionId: existingSessionId, message: existingChatMsg },
    });

    // Verify both sessions still have isolated message lists
    newChat = state.chatSessions.find(c => c.id === newChatId);
    existingChat = state.chatSessions.find(c => c.id === existingSessionId);
    expect(newChat?.messages.length).toBe(1); // still just 1
    expect(newChat?.messages[0].content).toBe('message in new chat');
    expect(existingChat?.messages.length).toBe(existingSessionMessageCount + 1); // grew by 1
    expect(existingChat?.messages[existingSessionMessageCount].content).toBe('message in existing chat');

    // Step 5: Switch back to new chat — verify its message is intact
    state = appReducer(state, { type: 'SET_ACTIVE_CHAT', payload: newChatId });
    newChat = state.chatSessions.find(c => c.id === newChatId);
    expect(newChat?.isActive).toBe(true);
    expect(newChat?.messages.length).toBe(1);
    expect(newChat?.messages[0].content).toBe('message in new chat'); // not leaked/overwritten

    console.log('  ✓ No cross-contamination: new chat messages stay in new chat, existing chat unaffected');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 5: Multiple new chats — each gets its own session entry,
  // no id collisions, all appear in chatSessions list.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 5: multiple new chats — each creates a distinct session, no collisions', () => {
    const state0 = JSON.parse(JSON.stringify(initialState));
    const initialSessionCount = state0.chatSessions.length;

    // Create 3 new chats in sequence. Use a per-iteration counter suffix
    // to guarantee unique ids regardless of Date.now() resolution (CI
    // runners can be fast enough that two iterations land in the same ms).
    let state = state0;
    const newChatIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const newChatId = `cs-${Date.now()}-${i}`;
      newChatIds.push(newChatId);
      const newSession: ChatSession = {
        id: newChatId,
        name: 'New Chat',
        messages: [],
        isActive: false,
      };
      state = appReducer(state, { type: 'CREATE_CHAT_SESSION', payload: { session: newSession } });
      state = appReducer(state, { type: 'SET_ACTIVE_CHAT', payload: newChatId });
    }

    // Session count increased by 3
    expect(state.chatSessions.length).toBe(initialSessionCount + 3);

    // All 3 new ids are distinct
    expect(new Set(newChatIds).size).toBe(3);

    // All 3 new sessions exist in state
    for (const id of newChatIds) {
      const session = state.chatSessions.find(c => c.id === id);
      expect(session).toBeDefined();
      expect(session?.messages).toEqual([]);
    }

    // Only the LAST new chat is active (most recent SET_ACTIVE_CHAT)
    const lastNewId = newChatIds[newChatIds.length - 1];
    expect(state.activeChatId).toBe(lastNewId);
    for (const id of newChatIds) {
      const session = state.chatSessions.find(c => c.id === id)!;
      expect(session.isActive).toBe(id === lastNewId);
    }

    console.log('  ✓ Multiple new chats: 3 distinct sessions created, only last is active');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 6: New session appears in sidebar chat list — uses the REAL
  // filterChatSessions + getRecentChats functions imported from
  // chat-list-utils.ts (the same module Sidebar.tsx imports). No logic
  // reimplemented in the test — if Sidebar.tsx's filter changes, this
  // test exercises the same code path and will reflect the change.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 6: sidebar visibility — new session appears in chat history + recent chats list (real chat-list-utils)', () => {
    const state0 = JSON.parse(JSON.stringify(initialState));
    const initialSessionCount = state0.chatSessions.length;

    // Create new chat
    const newChatId = `cs-${Date.now()}`;
    const newSession: ChatSession = {
      id: newChatId,
      name: 'New Chat',
      messages: [],
      isActive: false,
    };
    let state = appReducer(state0, { type: 'CREATE_CHAT_SESSION', payload: { session: newSession } });
    state = appReducer(state, { type: 'SET_ACTIVE_CHAT', payload: newChatId });

    // ── Sidebar "Chat History" section uses filterChatSessions ──────────
    // Empty search query → returns ALL sessions (no filter)
    const filteredChatsEmptySearch = filterChatSessions(state.chatSessions, '');
    expect(filteredChatsEmptySearch.length).toBe(initialSessionCount + 1);

    // New session is in the list
    const foundInFiltered = filteredChatsEmptySearch.find(c => c.id === newChatId);
    expect(foundInFiltered).toBeDefined();
    expect(foundInFiltered?.name).toBe('New Chat');

    // Search by "New" should include the new session (case-insensitive)
    const filteredByNew = filterChatSessions(state.chatSessions, 'New');
    const foundByNew = filteredByNew.find(c => c.id === newChatId);
    expect(foundByNew).toBeDefined();

    // Search by "new" (lowercase) should also match (case-insensitive)
    const filteredByLower = filterChatSessions(state.chatSessions, 'new');
    const foundByLower = filteredByLower.find(c => c.id === newChatId);
    expect(foundByLower).toBeDefined();

    // Search by something that doesn't match should NOT include the new session
    const filteredByNonMatch = filterChatSessions(state.chatSessions, 'xyz-does-not-exist');
    const foundByNonMatch = filteredByNonMatch.find(c => c.id === newChatId);
    expect(foundByNonMatch).toBeUndefined();

    // ── Sidebar "Recent Chats" section uses getRecentChats ──────────────
    const recentChats = getRecentChats(state.chatSessions);

    // With initialState (3 sample sessions) + 1 new = 4 total, new session
    // is at index 3 (pure append), so it's within the first 5
    if (state.chatSessions.length <= 5) {
      const foundInRecent = recentChats.find(c => c.id === newChatId);
      expect(foundInRecent).toBeDefined();
    }

    // getRecentChats never returns more than 5
    expect(recentChats.length).toBeLessThanOrEqual(5);

    console.log('  ✓ Sidebar visibility: real filterChatSessions + getRecentChats confirm new session is visible');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 6b: Direct unit tests on chat-list-utils.ts — verifies the pure
  // functions behave correctly independent of the reducer. Catches any
  // future regression in the filter/sort logic itself.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 6b: chat-list-utils — filterChatSessions + getRecentChats contract', () => {
    const sessions: ChatSession[] = [
      { id: 'cs1', name: 'Frontend', messages: [], isActive: true },
      { id: 'cs2', name: 'Backend', messages: [], isActive: false },
      { id: 'cs3', name: 'Planning', messages: [], isActive: false },
      { id: 'cs4', name: 'New Chat', messages: [], isActive: false },
    ];

    // filterChatSessions — empty query returns all (identity, not a copy)
    const emptyResult = filterChatSessions(sessions, '');
    expect(emptyResult).toBe(sessions); // same reference (matches Sidebar.tsx behavior)
    expect(emptyResult.length).toBe(4);

    // filterChatSessions — whitespace-only query returns all
    const wsResult = filterChatSessions(sessions, '   ');
    expect(wsResult).toBe(sessions);
    expect(wsResult.length).toBe(4);

    // filterChatSessions — case-insensitive substring match
    const newResult = filterChatSessions(sessions, 'new');
    expect(newResult.length).toBe(1);
    expect(newResult[0].id).toBe('cs4');

    // filterChatSessions — case-insensitive (uppercase query)
    const upperResult = filterChatSessions(sessions, 'BACKEND');
    expect(upperResult.length).toBe(1);
    expect(upperResult[0].id).toBe('cs2');

    // filterChatSessions — partial substring
    const partialResult = filterChatSessions(sessions, 'end');
    expect(partialResult.length).toBe(2); // "Frontend" + "Backend"
    expect(partialResult.map(s => s.id).sort()).toEqual(['cs1', 'cs2']);

    // filterChatSessions — no match
    const noResult = filterChatSessions(sessions, 'xyz');
    expect(noResult.length).toBe(0);

    // getRecentChats — returns first 5 (or fewer if array is shorter)
    const recent = getRecentChats(sessions);
    expect(recent.length).toBe(4); // only 4 in the array
    expect(recent[0].id).toBe('cs1'); // preserves order
    expect(recent[3].id).toBe('cs4');

    // getRecentChats — with 7 sessions, returns exactly 5
    const sevenSessions: ChatSession[] = Array.from({ length: 7 }, (_, i) => ({
      id: `cs-${i}`,
      name: `Chat ${i}`,
      messages: [],
      isActive: i === 0,
    }));
    const recentSeven = getRecentChats(sevenSessions);
    expect(recentSeven.length).toBe(5);
    expect(recentSeven[4].id).toBe('cs-4'); // 5th element, not 6th or 7th

    // getRecentChats — empty array returns empty
    const recentEmpty = getRecentChats([]);
    expect(recentEmpty.length).toBe(0);

    console.log('  ✓ chat-list-utils contract: filter (empty/whitespace/case-insensitive/partial/no-match) + recent (slice/empty/order)');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 7: CREATE_CHAT_SESSION is decoupled from activeChatId —
  // does NOT change activeChatId, only appends to chatSessions.
  // ════════════════════════════════════════════════════════════════════
  it('TEST 7: CREATE_CHAT_SESSION does not touch activeChatId — only SET_ACTIVE_CHAT does', () => {
    const state0 = JSON.parse(JSON.stringify(initialState));
    const originalActiveChatId = state0.activeChatId;

    // Create a session WITHOUT setting it active
    const newChatId = `cs-${Date.now()}`;
    const newSession: ChatSession = {
      id: newChatId,
      name: 'New Chat',
      messages: [],
      isActive: false,
    };
    const state1 = appReducer(state0, { type: 'CREATE_CHAT_SESSION', payload: { session: newSession } });

    // activeChatId unchanged
    expect(state1.activeChatId).toBe(originalActiveChatId);

    // New session exists but is NOT active
    const newSessionInState = state1.chatSessions.find(c => c.id === newChatId);
    expect(newSessionInState).toBeDefined();
    expect(newSessionInState?.isActive).toBe(false);

    // The previously-active session is still active
    const previouslyActive = state1.chatSessions.find(c => c.id === originalActiveChatId);
    if (previouslyActive) {
      expect(previouslyActive.isActive).toBe(true);
    }

    console.log('  ✓ Decoupled: CREATE_CHAT_SESSION only appends, does not change activeChatId');
  });
});
