
---
Task ID: github-credential-permanence-v2
Agent: main (super-z)
Task: Make GitHub credential setup permanent in the sandbox after discovering that .gitconfig gets overwritten and .git-credentials gets deleted on every reset.

Work Log:
- Previous credential helper setup (device 44) was wiped by sandbox reset:
  - /home/z/.gitconfig was OVERWRITTEN by base image version (no [credential] section)
  - /home/z/.git-credentials was DELETED (not in base image)
  - /home/z/my-project/.env and worklog.md SURVIVED (not touched by base image)
- Key finding: files at /home/z/my-project/ root level survive resets because
  the base image doesn't touch them. Files at /home/z/ get reset to base image state.
- Solution: 
  1. Stored token at /home/z/my-project/.github-token (persistent, device 44)
  2. Created bootstrap script at /home/z/my-project/setup-git.sh (persistent, device 44)
  3. Script reads token from persistent file, writes .git-credentials + sets credential.helper
  4. After any reset, run: bash /home/z/my-project/setup-git.sh
- This is NOT fully automatic (no startup hook exists in this sandbox), but it
  reduces recovery from a full chat round-trip to a single command.
- Token upload file deleted (no longer needed — token is in persistent storage).

Stage Summary:
- Persistent files (survive resets, device 44):
  /home/z/my-project/.github-token  — the GitHub PAT
  /home/z/my-project/setup-git.sh   — bootstrap script
  /home/z/my-project/.env           — project env vars
  /home/z/my-project/worklog.md     — this worklog
- After a reset: run `bash /home/z/my-project/setup-git.sh` then re-clone.
- CHIMERA commit (ea9efa1) pushed to GitHub successfully using credential helper.

---
Task ID: chimera-inline-completion
Agent: main (super-z)
Task: CHIMERA Inline Completion — FIM prompting + Copilot-style ghost text. Replace dropdown completion with inline ghost text, switch server endpoint to FIM (prefix/suffix) prompt shape.

Work Log:
- Server: POST /api/orchestrator/complete
  - Request shape changed from { prompt: string } → { prefix: string, suffix: string }
  - System prompt rewritten for FIM: explains the <CURSOR/> marker, instructs
    model to return ONLY the insertion text (no markdown, no fences)
  - User prompt format: "CODE BEFORE CURSOR:\n{prefix}\n\n<CURSOR/>\n\nCODE AFTER CURSOR:\n{suffix}"
  - All existing infrastructure preserved: 3s timeout, AbortController,
    response-length cap (200 chars), no agent dispatch (calls
    modelRouter.stream() directly)
- Client: app/src/components/editor/CodeEditor.tsx
  - Replaced registerCompletionItemProvider with registerInlineCompletionsProvider
    for both 'typescript' and 'javascript'
  - New response shape: { items: [{ insertText, range, completeBracketPairs: true }] }
    instead of the old CompletionList { suggestions: [...] }
  - Range is zero-width at cursor position (startColumn = endColumn = position.column)
    so Monaco inserts ghost text exactly at the cursor
  - prefix/suffix built from actual cursor position:
    - prefix = 10 lines above + current line up to cursor column
    - suffix = current line after cursor + 5 lines below
    (same line-count windows as before)
  - Removed the "wordUntil.word.length < 2" early-out — ghost text is useful
    even at start of empty line (Copilot-style behavior). Only bails if BOTH
    prefix and suffix are completely empty (brand-new file).
  - Wired Monaco's own CancellationToken in ADDITION to the existing
    module-scoped AbortController pattern: monacoToken.onCancellationRequested
    → myAbort.abort(). Both cancellation paths now work together.
  - disposeInlineCompletions: no-op (module-scoped state is self-managing)
  - 300ms debounce + module-scoped aiCompletionToken/aiCompletionAbort
    pattern preserved exactly
- Evidence:
  1. scripts/fim-inline-completion-proof.mts — 5 tests, all PASS:
     - New { prefix, suffix } shape accepted (status 200)
     - Real completion text returned (stub engine echoes — expected)
     - Latency: 142-144ms (consistent across 3 calls)
     - AbortController actually aborts (threw AbortError after 50ms)
     - Superseded request cancelled (A aborted when B superseded)
  2. scripts/ghost-text-verify.py — Playwright headless Chromium:
     - Monaco editor mounted at route /
     - Typed "const greeting = 'hello'\nconsole." + " l"
     - AI inline completion fired (console log: 152ms, 148ms)
     - Ghost text rendered in DOM:
       * .suggest-preview-text: 1 element
       * .ghost-text: 30 elements (individual spans)
       * .ghost-text-decoration: 15 elements
       * 20 ghost text spans matched via regex
     - Result: ✓ PASS — ghost text actually rendered
- Tests: 615/618 passing (3 pre-existing failures in tests/agent/agent-manager.test.ts
  verified to fail on baseline commit 4006fe3 BEFORE my changes — auth middleware
  rejects manually-signed test token, unrelated to inline completion).
  Breakdown: unit 276 + integration 13 + security 314 + e2e 6 + agent 6 = 615.
- Typechecks: both clean
  - server: tsc -p tsconfig.json --noEmit — no errors
  - app: tsc -b — no errors
- Lint: app eslint . — no errors
- Scope guards respected:
  - No repo-level context/code search (deferred per Section 0)
  - No multiple-suggestion ranking (skipped per Section 0)
  - No new services, no Tabby dependency
  - Agent pipeline / modelRouter untouched (only the /complete endpoint's
    request shape changed; everything else in orchestrator.ts is identical)

Stage Summary:
- Server endpoint: /api/orchestrator/complete now accepts FIM shape { prefix, suffix }
  with labeled <CURSOR/> marker prompt format
- Client: CodeEditor.tsx uses registerInlineCompletionsProvider — Copilot-style
  ghost text instead of dropdown widget. Real AbortController + Monaco
  CancellationToken double-wired. 300ms debounce preserved.
- Evidence: FIM proof (5/5 tests pass) + Playwright ghost text rendering
  proof (DOM contains .suggest-preview-text + .ghost-text + .ghost-text-decoration
  elements after typing).
- This closes CHIMERA Build 3 of 3: Avatar Engine (VRM + lip sync) ✓,
  Plugin Runtime (agent auto-loader) ✓, Inline Completion (FIM + ghost text) ✓.
