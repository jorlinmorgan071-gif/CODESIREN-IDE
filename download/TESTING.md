# Pre-Push Verification — New Chat Session-Creation Fix (Path B)

## What's in this tarball

This tarball contains the full Code Siren IDE working tree with the **New Chat session-creation fix** applied, including the Path B refactor (sidebar filter/sort logic extracted into a testable pure-function module).

## Files changed for the fix (5 files in `app/`)

1. **`app/src/store/AppContext.tsx`** — added `CREATE_CHAT_SESSION` to the `AppAction` union, added the reducer case (pure append via spread, does NOT touch `activeChatId`), added `createChatSession` action creator + interface entry + provider value. Also exported `appReducer`, `AppState`, `AppAction`, `initialState` for direct test access.

2. **`app/src/pages/Home.tsx`** — `handleNewChat()` now builds a full `ChatSession` object (`id`, `name: 'New Chat'`, `messages: []`, `isActive: false`) and dispatches `CREATE_CHAT_SESSION` before `SET_ACTIVE_CHAT`.

3. **`app/src/components/sidebar/chat-list-utils.ts`** (NEW) — pure functions `filterChatSessions()` and `getRecentChats()` extracted from Sidebar.tsx so the filter/sort logic is testable in isolation. No behavioral change — same output, just relocated.

4. **`app/src/components/sidebar/Sidebar.tsx`** — imports `filterChatSessions` and `getRecentChats` from `chat-list-utils.ts` instead of inlining the logic. Behavior identical to before.

5. **`app/vitest.config.ts`** — added the `@` path alias (was missing — existing tests didn't import from `src/`, so the alias was never needed until now).

6. **`app/tests/new-chat-session.test.ts`** (NEW) — 8 tests exercising the real `appReducer` + real `initialState` + real `chat-list-utils` functions, no mocks.

## IMPORTANT: npm install IS NEEDED

**Correction from the previous tarball's instructions:** `package.json` IS unchanged, but `node_modules/` is excluded from the tarball (it would balloon the file to hundreds of MB). You MUST run `npm install` in both `app/` and `server/` after extraction — this only installs existing declared deps, no new packages.

## How to extract + run

```bash
# Extract
tar -xzf codesiren-new-chat-fix-path-b.tar.gz
cd codesiren-new-chat-fix-path-b   # or wherever you extracted

# Install server deps + run server
cd server
cp .env.example .env        # if .env not already present
npm install                 # installs declared deps (package.json unchanged)
npm run dev                 # server on http://localhost:3001

# In a new terminal — install app deps + run app
cd app
npm install                 # installs declared deps (package.json unchanged)
npm run dev                 # app on http://localhost:3000
```

**Note:** VRM avatar model files (90MB) are excluded from this tarball to keep it small. The Face tab won't load 3D avatars, but **that's unrelated to the New Chat fix** — the chat panel + sidebar work fine without them.

## What to verify

### Automated tests (fastest — 8 tests, ~1 second)

```bash
cd app
npx vitest run tests/new-chat-session.test.ts --reporter=verbose
```

Expected output: 8 tests passing:
- TEST 1: bug reproduction — SET_ACTIVE_CHAT alone → message silently dropped
- TEST 2: fix — CREATE_CHAT_SESSION then SET_ACTIVE_CHAT → message renders
- TEST 3: full flow — New Chat → send message → both user + assistant messages render
- TEST 4: no cross-contamination — switch new → existing → back → messages isolated
- TEST 5: multiple new chats — each creates a distinct session, no collisions
- **TEST 6: sidebar visibility — uses REAL `filterChatSessions` + `getRecentChats` from `chat-list-utils.ts`** (Path B fix — no longer a logic reimplementation)
- **TEST 6b: chat-list-utils contract — direct unit tests on the extracted pure functions**
- TEST 7: CREATE_CHAT_SESSION does not touch activeChatId — only SET_ACTIVE_CHAT does

### Manual browser test (catches what automated tests can't)

1. Open `http://localhost:3000`
2. Click "New Chat"
3. Type a message + press Enter — message should render in the panel
4. Click an existing chat in the sidebar → switch back to "New Chat" — messages stay isolated
5. Click "New Chat" 3 times → all 3 appear as separate entries in the sidebar's chat history

## What was NOT changed (scope boundaries respected)

- `ADD_CHAT_MESSAGE` reducer — unchanged
- `UPDATE_CHAT_MESSAGE` reducer — unchanged
- `ChatPanel.tsx` WS chunk-handling logic — unchanged
- `ChatPanel.tsx` `handleSend()` — unchanged
- `SET_ACTIVE_CHAT` reducer — unchanged
- Backend (`/api/orchestrator/chat`) — unchanged
- Any message-handling, streaming, or backend code — unchanged

## Path B refactor detail (what changed since the previous tarball)

**Before (Path A — previous tarball):** Test 6 reimplemented the Sidebar's filter/sort logic inside the test file. This meant it verified the reducer's output shape was correct for the sidebar to consume, but did NOT prove the real `Sidebar.tsx` component would render the new session — if someone later added a filter like `s.messages.length > 0` to hide empty sessions, the test would still pass while the real component would break.

**After (Path B — this tarball):**
1. Extracted `filterChatSessions()` and `getRecentChats()` from `Sidebar.tsx` into `app/src/components/sidebar/chat-list-utils.ts` (pure functions, no behavioral change).
2. `Sidebar.tsx` now imports and calls those functions — same output, just relocated.
3. Test 6 imports `filterChatSessions` + `getRecentChats` from the real `chat-list-utils.ts` module and exercises them directly. If the sidebar's filter logic changes, the test exercises the same code path and will reflect the change.
4. Added Test 6b — direct contract tests on `chat-list-utils.ts` (empty query, whitespace, case-insensitive, partial match, no match, slice bounds, empty array, ordering).

## Verification gates (all green at packaging time)

- **Typecheck:** `tsc --noEmit -p tsconfig.app.json` — clean, 0 errors
- **Lint:** `eslint` on all 6 touched files — clean, 0 errors
- **Existing tests:** `lightbulb-enum.runtime.test.ts` 5/5 pass (no regressions)
- **New tests:** `new-chat-session.test.ts` 8/8 pass
- **Combined app suite:** 2 files / 13 tests / 0 failures
