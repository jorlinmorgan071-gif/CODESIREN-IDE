# Testing the New Chat Session-Creation Fix

## What was fixed

**Bug:** Clicking "New Chat" generated a new chat id and set it active, but never created a `ChatSession` entry for that id. Every downstream message write (`ADD_CHAT_MESSAGE`, `UPDATE_CHAT_MESSAGE`) silently no-oped because the session didn't exist in state. The user saw an empty chat panel with no errors.

**Fix:** Added a new reducer action `CREATE_CHAT_SESSION` that appends a real `ChatSession` entry to `state.chatSessions`. `handleNewChat()` now dispatches `CREATE_CHAT_SESSION` BEFORE `SET_ACTIVE_CHAT`, so the session exists in state before it's made active.

## Files changed (4 files, all in `app/`)

1. **`app/src/store/AppContext.tsx`** — added `CREATE_CHAT_SESSION` to the `AppAction` union, added the reducer case (pure append via spread, does NOT touch `activeChatId`), added `createChatSession` action creator + interface entry + provider value. Also exported `appReducer`, `AppState`, `AppAction`, `initialState` for direct test access.

2. **`app/src/pages/Home.tsx`** — `handleNewChat()` now builds a full `ChatSession` object (`id`, `name: 'New Chat'`, `messages: []`, `isActive: false`) and dispatches `CREATE_CHAT_SESSION` before `SET_ACTIVE_CHAT`.

3. **`app/vitest.config.ts`** — added the `@` path alias (was missing — existing tests didn't import from `src/`, so the alias was never needed until now).

4. **`app/tests/new-chat-session.test.ts`** — NEW, 7 tests exercising the real `appReducer` + real `initialState`, no mocks.

## How to install + run

```bash
# Extract
tar -xzf codesiren-new-chat-fix.tar.gz
cd codesiren-new-chat-fix   # or wherever you extracted

# Install server deps + run server
cd server
cp .env.example .env        # if .env not already present
npm install
npm run dev                 # server on http://localhost:3001

# In a new terminal — install app deps + run app
cd app
npm install
npm run dev                 # app on http://localhost:3000
```

**Note:** VRM avatar model files (90MB) are excluded from this tarball to keep it small. The Face tab won't load 3D avatars, but **that's unrelated to the New Chat fix** — the chat panel + sidebar work fine without them.

## What to test (the manual reproduction)

### Test 1: New Chat → send message → verify it renders

1. Open the app at `http://localhost:3000`
2. Click the "New Chat" button (sidebar or dock, wherever the + button is)
3. The chat panel should open with an empty message list (no errors in console)
4. Type a message like "hello world" and press Enter
5. **Expected:** Your message appears in the chat panel immediately as a user bubble. An assistant placeholder appears (streaming indicator). The backend responds and the assistant message streams in.

**Before the fix:** Step 5 would show an empty panel — no user message, no assistant placeholder, no error. The message was silently dropped.

### Test 2: Switch chats and back — no cross-contamination

1. With the new chat still open and containing messages, click an existing chat in the sidebar's chat history (e.g., "Frontend", "Backend", or "Planning")
2. **Expected:** The existing chat's messages load, the new chat's messages are NOT visible
3. Click the new chat ("New Chat") in the sidebar history
4. **Expected:** The new chat's messages are still there, intact — not overwritten by the existing chat

### Test 3: Multiple new chats in sequence

1. Click "New Chat" — chat panel is empty, send a message
2. Click "New Chat" again — chat panel is empty again (new session), send a different message
3. Click "New Chat" a third time — same behavior
4. Open the sidebar's chat history — all 3 new chats should appear as separate entries named "New Chat"

### Test 4: New chat appears in sidebar immediately

1. Click "New Chat"
2. Open the sidebar's "History" section (or "Recent" section)
3. **Expected:** A "New Chat" entry appears in the list immediately, without needing a refresh

## Automated test (if you just want to verify the fix without manual testing)

```bash
cd app
npx vitest run tests/new-chat-session.test.ts --reporter=verbose
```

This runs 7 tests against the real `appReducer` + real `initialState`:

```
✓ TEST 1: bug reproduction — SET_ACTIVE_CHAT alone → message silently dropped
✓ TEST 2: fix — CREATE_CHAT_SESSION then SET_ACTIVE_CHAT → message renders
✓ TEST 3: full flow — New Chat → send message → both user + assistant messages render
✓ TEST 4: no cross-contamination — switch new → existing → back → messages isolated
✓ TEST 5: multiple new chats — each creates a distinct session, no collisions
✓ TEST 6: sidebar visibility — new session appears in chat history + recent chats list
✓ TEST 7: CREATE_CHAT_SESSION does not touch activeChatId — only SET_ACTIVE_CHAT does
```

## Known limitation of Test 6

Test 6 reimplements the sidebar's filter/sort logic inside the test file rather than importing the real `Sidebar` component. This means it verifies the reducer's output shape is correct for the sidebar to consume, but does NOT prove the real `Sidebar.tsx` component renders the new session. If you want a full end-to-end test, run the manual Test 4 above in a browser.

## What was NOT changed (scope boundaries)

- `ADD_CHAT_MESSAGE` reducer — unchanged
- `UPDATE_CHAT_MESSAGE` reducer — unchanged
- `ChatPanel.tsx` WS chunk-handling logic — unchanged
- `ChatPanel.tsx` `handleSend()` — unchanged
- `SET_ACTIVE_CHAT` reducer — unchanged
- Backend (`/api/orchestrator/chat`) — unchanged
- Any message-handling, streaming, or backend code — unchanged
