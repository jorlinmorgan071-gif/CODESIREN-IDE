# Pre-Push Verification — Live Conversation Button Fix

## What's in this tarball

The Code Siren IDE working tree with the **dead "Live conversation" button fix** applied. The button in the chat input toolbar (Radio icon, tooltip "Live conversation") was a `console.log` no-op; it now calls `toggleVoiceSession()` from `VoiceSessionContext` and shows active-state color feedback (siren-red when a call is live, steel-silver when idle).

## Files changed (1 file + 1 new proof script)

1. **`app/src/components/chat/elements/ChatInput.tsx`** — 3 surgical changes:
   - Added `import { useVoiceSession } from '@/store/VoiceSessionContext';`
   - Added `const { isActive, toggleVoiceSession } = useVoiceSession();` in the component body
   - Replaced `onClick={() => console.log('[chat-input] Live/Face visualizer — built in Face phase')}` with `onClick={() => void toggleVoiceSession()}`
   - Changed button `style` from `color: 'var(--steel-silver)'` to `color: isActive ? 'var(--siren-red)' : 'var(--steel-silver)'` (matches the Mic button's `isRecording` pattern)

2. **`scripts/live-button-click-through-proof.mts`** (NEW) — Playwright headless Chromium proof that clicks the button, verifies `POST /api/voice/live/start` fires, verifies color change to siren-red, clicks again, verifies `POST /api/voice/live/:id/end` fires, verifies color reverts. **4/4 tests pass.**

3. **`scripts/identify-second-radio-button.mts`** (NEW) — investigation script that confirmed the "second Radio-icon button" found by the proof is the Dock's "Face" navigation button (`Dock.tsx:46`), not a duplicate or leftover. No fix needed.

## IMPORTANT: npm install IS NEEDED

`package.json` is unchanged, but `node_modules/` is excluded from the tarball. You MUST run `npm install` in both `app/` and `server/` after extraction.

## How to extract + run

```bash
# Extract
tar -xzf codesiren-live-button-fix.tar.gz
cd codesiren-live-button-fix   # or wherever you extracted

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

**Note:** VRM avatar model files (90MB) are excluded to keep the tarball small. The Face tab won't load 3D avatars, but **that's unrelated to this fix** — the chat panel + live-call button work fine without them.

## What Morgan needs to verify manually (Phase D human-confirmation gate)

The automated Playwright proof passed 4/4, but per Phase D's gate, Morgan must click this live in the real running app before it closes:

1. Open `http://localhost:3000` in a real browser (Chrome/Firefox/Safari)
2. Locate the chat input bar at the bottom of the chat panel
3. Find the **Radio icon button** in the toolbar (between the Camera icon and the Mic icon) — tooltip should say "Live conversation"
4. **Click it once** — browser should prompt for microphone permission → grant it
5. **Verify:**
   - The button's color changes from gray (steel-silver) to red (siren-red)
   - The browser's mic indicator shows the mic is active
   - Server logs show `POST /api/voice/live/start` with a 200 response
6. **Click the same button again** — the call should end
7. **Verify:**
   - The button's color reverts from red back to gray
   - The browser's mic indicator shows the mic is released
   - Server logs show `POST /api/voice/live/<session-id>/end` with a 200 response

### Expected vs broken behavior

| Step | Expected (with fix) | Broken (before fix) |
|---|---|---|
| Click button | Mic permission prompt → call starts → button turns red | Nothing visible; `console.log('[chat-input] Live/Face visualizer — built in Face phase')` in DevTools console only |
| Click again | Call ends → button reverts to gray | Nothing (another console.log) |

### If something doesn't work

- If the button doesn't change color: check browser console for errors from `useVoiceSession` or `VoiceSessionContext`
- If the call doesn't start: check server is running on `:3001`, check browser is granting mic permission
- If the call starts but doesn't end on second click: check `isActive` is being updated in the React state (the toggle checks `isActiveRef.current`)

## Second Radio-icon button (not a bug)

The proof script's selector (`button:has(svg.lucide-radio)`) found 2 matches. Investigation confirmed:

- **Button #1** (`ChatInput.tsx:396`) — the "Live conversation" button this fix targets. Tooltip "Live conversation", 28×28px, top-right of chat input.
- **Button #2** (`Dock.tsx:86`) — the Dock's "Face" navigation button. Tooltip "Face", 40×40px, bottom center dock. Navigates to `/face` route. Uses the same `Radio` icon by design choice (Face page = avatar/voice-call page). Working as intended — no fix needed.

The proof script's `.first()` correctly targeted Button #1 for both click scenarios.

## Verification gates (all green at packaging time)

- **Typecheck:** `tsc --noEmit -p tsconfig.app.json` — clean, 0 errors
- **Lint:** `eslint` on `ChatInput.tsx` — clean, 0 errors
- **Existing app tests:** `vitest run` — 13/13 pass (no regression)
- **Playwright click-through proof:** 4/4 pass (button exists, no dead-handler log, call starts on click, call ends on second click, color toggles correctly)

## Out-of-scope (logged for future directive)

The live-call pipeline has no awareness of which chat session or model is active. `startVoiceSession()` POSTs `{}` to `/voice/live/start`; the server's `voiceProxy.startSession(userId, projectId, userDisplayName)` takes no `chatSessionId` or `modelId`. This affects F6, FaceView's button, AND this newly-wired button equally. Separate fix for its own directive.

## What was NOT touched (scope boundaries respected)

- `VoiceSessionContext.tsx` — untouched
- `server/src/routes/voice-live.ts` — untouched
- `server/src/systems/voice/voice-proxy.ts` — untouched
- Button markup, className, icon, tooltip text — all unchanged (only `onClick` + `style.color` value changed)
- Other toolbar buttons (Camera, Mic, Send, Paperclip) — unchanged
- Dock.tsx — untouched (the second Radio-icon button is not affected)
