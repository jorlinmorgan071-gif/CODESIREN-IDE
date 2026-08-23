# P1 Scoped, Durable, Quality-Labelled Memory Hardening

## Audited gap

Code Siren’s shared `MemoryEngine` already restricts normal reads and writes to an authenticated `{ userId, projectId }` pair. It does **not** carry session identity, does not expose a first-class quality or retrieval-provenance contract, and silently treats its in-process fallback as the same successful memory operation after a database failure. The main chat path compounds this problem because the browser generates client-local keys such as `cs-<timestamp>`, while generic agent sends default to the constant session identifier `00000000-0000-0000-0000-000000000000`.

The current schema has users, single-owner projects, and durable `sessions` rows, but no organization entity. The safer correction is not to invent an organization identifier or claim multi-organization access. Code Siren will explicitly operate as a **single-owner organization policy**: every durable memory operation is authorized by the authenticated project owner, and organization-level sharing remains unavailable until a real organization data model and membership policy exist.

## Authoritative scope and durability contract

| Concern | Authoritative evidence | Required behavior |
|---|---|---|
| Organization policy | No organization table or membership model exists | Report `single-owner` policy in provenance. Never infer or accept an organization ID. Cross-user sharing is unavailable, not simulated. |
| User and project | Authenticated user plus `projects.user_id` ownership through `WorkspaceService` / tenant resolution | Every query and mutation remains bound to the exact owner and selected project. |
| Session | Server-owned UUID in `sessions`, joined through its project to the authenticated owner | Main chat and generic agent paths create or validate an owned durable session before a memory-bearing task executes. A foreign or malformed session is rejected; no constant fallback session exists. |
| Persistence | `agent_memory` row and session foreign key in PostgreSQL | A database result is `durable`. Existing in-memory fallback may remain only as explicitly labelled `ephemeral` degradation; it is never reported as durable. |
| Quality | Explicit `quality` label with a declared source | Memory records and retrieval results expose `verified`, `derived`, or `degraded` quality. The system must not label fallback persistence as verified. |
| Provenance | Stored source fields plus server-generated retrieval facts | Results carry source type/ref, owner-project-session policy, quality, storage durability, similarity score, and retrieval timestamp. Caller-supplied provenance is not trusted. |

## Implemented correction

The tenant execution scope now carries `SessionScope` for memory-bearing agent execution while generic WebSocket recipient matching remains at its existing `{ userId, projectId }` boundary. `MemoryEngine` applies exact user-project-session comparison. Context assembly passes the authoritative task session to `MemoryEngine.search()`, and agent memory calls inherit it from the existing asynchronous execution scope. An agent with no session scope receives no memory result and performs no memory write rather than silently downgrading to project scope.

`ensureOwnedSession(...)` is the single session-ownership helper. In PostgreSQL mode it validates a UUID and joins `sessions → projects → users`; it creates a missing session only inside the authenticated owner’s selected project and rejects a session belonging to another owner or project. The browser creates UUID chat IDs from the beginning, replacing timestamp and fixed sample IDs. Generic agent requests generate a UUID when absent and no longer use the constant all-zero session identifier. Main chat rejects malformed session IDs before dispatch.

Migration `011_scoped_memory_provenance.sql` adds first-class `session_id`, `quality`, and `provenance` fields plus an owner-project-session index. Normal search, list, detail, and delete operations require an exact owned session. Historic rows without `session_id` are deliberately excluded from those normal paths; there is no project-wide legacy retrieval switch in this P1. Main chat context therefore cannot cross session boundaries.

The memory list/read API requires `sessionId` and returns quality plus safe provenance only for records in that exact authorized scope. Brain View passes its active chat session to every list/detail/delete request and ignores `memory:created` events for other sessions. Context retrieval provenance is captured in the existing scoped trace metadata with score and quality but without re-copying memory content. No model/provider routing, prompt model choice, synthetic answer, second memory engine, or second persistence path was introduced.

## Failure semantics

Memory never invents a successful durable write. If the database is unavailable, the existing local fallback remains explicitly `ephemeral` and `degraded`; it is usable only within its process lifetime and can never be presented as durable across restart. If durable session ownership cannot be proved, memory-bearing execution fails closed before retrieval or write. Context assembly may continue without memory only after a retrieval error, and the trace contains no fabricated retrieval result. An empty exact-session result is not represented as a project-wide search.

## Validation requirements

Focused regressions now prove session creation/ownership and foreign-session rejection (`tenant-scope.test.ts`); no constant generic-agent session plus main-chat UUID validation (`agent-manager.test.ts`); exact-session exclusion, owner/project isolation, quality, and ephemeral provenance (`memory.test.ts`); context provenance propagation (`context/manager.test.ts`); and authenticated list/detail API session denial plus provenance response (`memory-route-scope.test.ts`). The focused backend gate passes **61 tests in 5 files**, and the focused frontend UUID/session gate passes **9 tests in 2 files**. The final server suite passes **70 files and 894 tests**; the final application suite passes **14 files and 69 tests**; server typechecking, application linting, and the production build also pass. The migration runner discovered no PostgreSQL service locally and therefore applied nothing, which is its documented truthful outcome. The migration is type-reviewed but not database-applied here; all local persistence assertions correctly exercise and label the `ephemeral`/`degraded` path. Whitespace, protected-asset, secret, and model-architecture audits remain required before publication.

> **Checked out** for this P1 means that memory scope is derived from authenticated ownership and a server-validated session, durability and quality labels describe the actual storage outcome, and retrieval provenance exposes what evidence was used. It does not mean multi-organization sharing exists; that capability is explicitly unavailable until a real organization model is implemented.
