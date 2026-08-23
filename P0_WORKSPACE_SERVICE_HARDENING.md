# P0 WorkspaceService and Project Identity Hardening

## Purpose and release rule

This P0 slice makes the durable `projects.id` record the single workspace identity used by coding tasks, context assembly, memory lookup, traces, and WebSocket events. A change is publishable only after the complete server and application gates pass, the diff contains no protected assets or runtime workspace contents, and remote `main` verification succeeds.

## Security contract

| Contract | Enforcement |
|---|---|
| Stable identity | `WorkspaceService.resolveWorkspace()` resolves an authenticated user and requested project through the existing ownership resolver, then reads the project-owned `root_path`. The returned `projectId` is the existing durable project primary key; no second workspace ID exists. |
| Server-owned roots | Browser chat payloads no longer accept `workspaceRoot`. The root is canonicalized on the server and is never returned by the public workspace identity endpoint. |
| File containment | Open-file reads, project-graph scans, and project-file writes require non-empty relative paths. Absolute paths, `..` traversal, backslash ambiguity, final-file symlinks, and symlinked parent-directory write escapes are rejected. |
| Task propagation | `AgentManager.send()` and `executeAndWait()` hydrate each tenant-bound task from `WorkspaceService` before traces, context, events, or agents consume the task root. |
| Chat isolation | In-memory chat history is keyed by user ID, durable project ID, and browser session label. Matching client session labels therefore cannot share history across workspaces. |
| Client subscription | The client obtains only `{ projectId, name }` from `/api/workspace/current` and connects WebSocket subscriptions with that stable project identity. Missing identity is resolved server-side to the authenticated user's personal workspace. |

## Impact review and decisions

The audit found that `/api/orchestrator/chat` accepted a client-selected absolute workspace root, `ContextManager` and `project-graph` resolved active files without containment checks, and `/api/project-files/write` wrote below a shared `/tmp` directory. These paths are now removed or bound to the selected project root.

The existing `projects` schema already provides `id`, `user_id`, and `root_path`; therefore no migration was added. The personal-workspace fallback now persists a deterministic managed root under `server/.workspaces/<userId>/<projectId>`. This directory is runtime-only and ignored by Git. Existing project roots continue to be honored only after project ownership is verified.

The P0 boundary does not retrofit arbitrary legacy agent utility APIs that accept a root path outside a task lifecycle. Production chat and project-file HTTP entry points, plus both central AgentManager dispatch paths, now resolve their roots through `WorkspaceService`. Any future direct coding API must either receive a `WorkspaceIdentity` or be explicitly kept non-user-facing until converted.

## Regression evidence to date

| Gate | Result |
|---|---|
| Backend typecheck after WorkspaceService introduction and each corrective change | Passed |
| Focused WorkspaceService/context suite | Passed: 5 WorkspaceService tests and 10 existing context tests |
| Existing project-file security route suite after root-bound correction | Passed: 6 tests |
| Frontend suite after client payload and WebSocket identity updates | Passed: 11 files / 63 tests; pre-existing React `act(...)`, Three.js, and Browserslist warnings remain non-blocking |

## Remaining release steps

The final P0 gate still requires complete server tests, complete frontend tests, frontend lint and production build, whitespace and protected-asset audit, secret-safe test scan, source/diff review, commit, push to `origin/main`, and remote SHA parity verification. The release status is **not published** until those checks are complete.
