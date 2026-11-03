# P0 Tenant Isolation Hardening Record

**Status:** Published to `origin/main`; implementation, validation, staged-diff review, and remote parity verification are complete.
**Baseline:** `main` at `0d5ee544e9caf652bbb949d8df3ce493e7a1652e` before this P0 slice.  
**P0 implementation commit:** `ac2d40b61ad83d24a56777f5cebf1240f7aca7a3` (`fix(security): scope Code Siren tenant events and data`).
**Scope:** User/project tenancy for generic WebSocket delivery, tasks, relay plans, traces, memory, and dashboard data. This record is intentionally kept in the repository so later implementation sessions can distinguish audited behavior from outstanding work.

## Security Contract

> A client-controlled project ID is never authorization. Every externally reachable task, event, trace, memory query, dashboard query, and relay plan operation must first resolve an exact server-owned `{ userId, projectId }` scope. Both values must match before data is delivered, read, changed, or acted upon.

| Concern | P0 delivery rule | Implemented enforcement |
|---|---|---|
| Generic WebSocket events | Unscoped events are not delivered. Scoped events require an exact user-and-project match. | `server/src/ws/voice-event-isolation.ts` and `server/src/ws/server.ts` fail closed at the delivery boundary. |
| Task construction | Routes resolve a server-owned project; raw request project IDs never become task ownership directly. | Agent, chat, voice, live voice, operative, fabrication, relay, and presence paths use `resolveTenantScope`. |
| Traces | Legacy/unscoped traces are hidden whenever a scope is supplied. | Scoped `startTrace`, `getTrace`, and `listTraces`. |
| Memory | All public storage and retrieval requires a scope; database queries join `projects` and require `user_id`. | Scoped memory engine and scoped memory routes. |
| Dashboard | User/project-sensitive data is derived only from the resolved scope. | Agent state, memory, traces, performance, and security events are scope-filtered; host and requester-sensitive metadata were removed. |
| Plans and relay events | New plans persist their existing `project_id`; all read/control/execution paths validate it against the resolved scope. | Scoped plan generation, plan repository query, relay events, and downstream agent tasks. |

## Implemented Changes and Impact Review

| Area | Change | Impact decision |
|---|---|---|
| Tenant resolver | Added `TenantScope`, ownership checks, a managed personal workspace resolver, and task-local async scope propagation. | Reuses existing `projects.user_id` and `agent_memory.project_id`; no schema migration was needed for correctness. |
| Generic event bus | `AgentEvent` now permits scope metadata; generic events without scope are dropped. | This prevents cross-user delivery even when an older internal source omits ownership. |
| Agent execution | Agent manager derives scope from task user/project fields, scopes lifecycle events/traces, and exposes scoped active-task lookup. | Memory calls made inside generators receive task-local scope rather than shared global state. |
| Memory writes | Database insertion uses `RETURNING id`; the engine emits `memory:created` only after a confirmed owned row is inserted. | Avoids phantom public events if a project disappears or ownership changes during the write. |
| Relay plans | New plans store the resolved project ID; plan list/detail/status/control endpoints require an exact matching scope. Relay events and child agent tasks carry the same scope. | Existing null-project legacy plans are intentionally unavailable rather than guessed into a tenant. |
| Task routes | Operative, fabrication, direct agent, live voice, chat, and presence now resolve ownership server-side. Fabrication responses no longer expose bearer-token WebSocket URLs. | A foreign project ID receives an access denial; a missing ID resolves to the caller's personal workspace. |
| Dashboard | Removed process/host/config-adjacent fields, absolute start time, model host/error details, and IP-derived security output. | Remaining models/tools responses are authenticated capability metadata, not tenant data. |
| Secret-safe tests | Missing-key tests use `vi.stubEnv` rather than assertions that can print environment values. | The test-source scan found no direct environment-value assertion or logging pattern. |

## Deliberate Fail-Closed Boundaries

Some pre-existing systems are globally shared and lack project ownership. P0 does **not** invent or guess a tenant boundary for them.

| Surface | P0 behavior | Reason and next gate |
|---|---|---|
| Workflow route and scheduled workflow controls | Authenticated requests return `503` with an explicit ownership-model message. | Workflow persistence has no owner/project relation. Re-enable only with owned workflow storage and scoped events. |
| Sentinel watch route and direct Sentinel Agent invocation | Authenticated requests return `503` with an explicit ownership-model message. | Watch state is a global singleton; scanning it could disclose another tenant's configuration. |
| Ghost Mode broadcasts | They remain unscoped and are therefore suppressed by the WebSocket boundary. | Ghost findings need durable project metadata before delivery can safely resume. |
| Legacy direct Tier 1 test adapter | Historical in-process tests may use an internal `legacy-internal-*` scope; production HTTP always supplies a resolver-produced scope. | The adapter has no persisted project mapping and cannot be selected by an externally connected WebSocket client. Remove after legacy unit tests migrate to explicit scopes. |

## Evidence Captured During Implementation

| Check | Latest observed result | Notes |
|---|---|---|
| Backend TypeScript | Passed | Final typecheck passed after route, relay, memory, dashboard, and test-adapter corrections. |
| Complete server suite | Passed: 64 files, 857 tests | Includes the nested real test-execution, coverage, and concurrency checks. |
| Focused P0 tests | Passed: 4 files, 31 tests | Covers exact scopes, generic WebSocket isolation, direct trace denial, concurrent async scope isolation, memory search/get/delete denial, and context memory scoping. |
| Frontend suite | Passed: 11 files, 63 tests | Existing React `act(...)`, multiple Three.js instance, and Browserslist freshness warnings remain non-blocking pre-existing test/build observations. |
| Frontend lint and production build | Passed | Build retains the non-blocking 1.38 MB minified Three.js vendor-chunk warning. |
| Diff and protected-asset boundary | Passed | `git diff --check` passed; no `.vrm`, `.vrma`, `.glb`, `.fbx`, manifest, catalog, environment, or credential-file path is in the P0 diff. |
| Secret-safe test-source scan | Passed | No direct environment-value assertion or logging pattern remained in server test sources. |

## Publication Verification

The P0 implementation commit was pushed only after the final staged-diff review. Local `main` and `origin/main` both resolved to `ac2d40b61ad83d24a56777f5cebf1240f7aca7a3` immediately after push, and the repository working tree was clean. The committed boundary contained no protected avatar/model/animation assets, manifests, catalogs, environment files, or credential files.

## Next P0 Follow-Up After Release

The next security-gated item is to add durable per-project ownership to Ghost findings, workflow definitions/runs, and Sentinel watches before any of those user-facing flows are re-enabled. This is not included in the current P0 slice.
