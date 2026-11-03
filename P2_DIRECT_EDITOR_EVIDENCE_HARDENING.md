# P2 Direct Editor AI Evidence Hardening

## Audited gap

Code Siren exposed four direct editor AI paths: Monaco inline completion, selected-code explanation, edit-family refactor/document/optimize/convert, and screenshot/image vision analysis. Each path invoked a provider directly and returned a bare payload (`text`, `explanation`, `result`, or `analysis`). Those requests bypassed the authoritative task/trace lifecycle: they had no shared task identifier, no declared-input record, no actual provider disclosure, no output-state record, no uniform apply state, and no explicit verification state.

The edit family subsequently creates an authoritative change transaction, but the model-generation portion is not linked to an evidence record. Completion has no apply boundary because Monaco accepts its ghost text directly. Explain and vision are read-only but do not state that status. Vision additionally must never retain or log raw image bytes.

## Shared contract

| Field | Required truth | Source |
|---|---|---|
| `taskId` | A server-generated UUID for every accepted direct-editor action | Shared direct-editor execution service |
| `action` | `completion`, `explain`, `refactor`, `document`, `optimize`, `convert`, or `vision` | Validated endpoint action |
| `inputs` | Declared field names, character/byte counts, optional language/mode, and no copied code or image payload | Server-generated input summary |
| `provider` | Actual existing routing surface used: selected `modelRouter` engine for text, or `z-ai-vision` for vision | Existing router/service, not a new provider selector |
| `output` | `succeeded`, `timed-out`, or `failed`, with output character count only | Actual collection/catch outcome |
| `apply` | `not-applicable` for completion/explain/vision; `pending-approval` for edit output; transaction approval later reports `applied`, `rejected`, or `failed` | Existing change transaction, never model text |
| `verification` | `unverified` unless an existing change transaction has recorded real disk reconciliation | Existing trace/transaction evidence |

`server/src/orchestrator/direct-editor-evidence.ts` now creates one UUID task/trace record for every accepted action and records it in the existing scoped trace store as ordinary `llm-call` steps. Every `/orchestrator/complete`, `/explain`, `/refactor`, and `/vision` response includes the typed `evidence` object. Its trace input is the action plus a declared-input summary only; it does not include code, prompt, or image bytes. No direct editor action creates a second agent manager, provider router, memory engine, write path, or verification runner.

## Scope and provider policy

Direct editor endpoints now require the existing authenticated owner/project/session boundary so their traces remain tenant-scoped. Monaco, Inline AI, and screen vision supply the active P1 UUID chat session. The server resolves `SessionScope` through `resolveWorkspace` and `ensureOwnedSession` before creating evidence. Foreign users receive `403` before any provider call and no unscoped trace is emitted.

Text actions call the existing `modelRouter`. The evidence service asks that router which engine it would select for the exact request and records that engine ID; it does not alter router priority, model selection, credentials, or provider configuration. Vision records the existing `z-ai-vision` service label only. Existing vision model configuration is not changed in this P2 and no additional hardcoded model is introduced.

## Apply and verification truth

Completion is an editor suggestion; it has no authoritative filesystem apply event, so its apply state is `not-applicable` and verification is `unverified`. Explain and vision are read-only, so they carry the same states. Edit-family model output is only a proposed replacement: it receives `pending-approval` and `unverified` until the existing change transaction is planned and explicitly approved. The UI must never label a declared verification plan as executed.

The existing change transaction remains the only path that can write a workspace file or report actual disk reconciliation. The Inline AI panel now presents direct-editor task/provider/input/output/apply/verification evidence next to read-only output and proposed edits. It continues to render change-impact verification as **declared and not run**.

## Failure semantics

If scope validation fails, the action fails before any provider call and emits no unscoped trace. If a text call times out, the result returns a truthful timed-out output state and an empty output; it does not substitute synthetic output. This P2 corrected the prior fabricated timeout strings for explain and edit-family actions. Vision errors redact image data before entering evidence or logs. Provider absence remains visible through the existing router/service output rather than being presented as a successful real-model answer.

## Focused validation

The authenticated endpoint suites passed with **21 tests across three files**: `explain-endpoint.test.ts` proves explain, completion, trace redaction, and cross-user session denial; `refactor-endpoint.test.ts` proves pending approval/unverified edit evidence; and `vision-endpoint.test.ts` proves evidence is returned on both safe success/failure paths without retaining image bytes. The frontend `direct-editor-evidence.test.ts` passed and proves the UI formatter retains `pending-approval` and `unverified` rather than claiming application or verification. Server TypeScript validation and frontend lint also passed after the implementation correction that restored Monaco request cancellation through the typed client.

The existing direct vision service remains a distinct provider integration and its pre-existing configured model selection is intentionally not changed here. This P2 adds only a truthful `z-ai-vision` service label to evidence; it does not hardcode or alter model-provider routing.

> **Checked out** for this P2 means every supported direct-editor action has a tenant-scoped task ID and a single server-derived evidence record describing declared inputs, actual routing surface, output, apply state, and verification state. It does not mean an edit was applied or verified unless the existing authoritative transaction has actually recorded that outcome.
