# P1 Capability-Aware Normal Chat

## Audited starting point

Normal chat accepted every request at `POST /api/orchestrator/chat`, then built one `architect-agent` task with `single-shot` execution. The AgentManager lifecycle, tenant scope, workspace resolution, context assembly, WebSocket delivery, and trace creation were authoritative. However, the normal-chat request did not classify capabilities, did not select tools, and could only answer through the general model path.

The shared registry already exposed ReAct and CodeAct dispatch, but normal chat never selected either strategy. Its registry also included an explicitly simulated `code_interpreter`, so routing a normal request into the unrestricted tool inventory would violate the truthfulness boundary. The editor client sent display filenames rather than verified workspace-relative paths, which could not safely name a disk file. Finally, the existing generic plan endpoint generated plans from durable session messages through a configured orchestrator engine; it was not a safe default for a main-chat change request in an environment without a real engine.

## P1 contract

| Request class | Required input | Server action | User-visible result | Verification meaning |
|---|---|---|---|---|
| `read-explain` | A server-derived active workspace-relative path | Run the one scoped read-only workspace-file capability before the agent response | Explanation is grounded in the returned file content and trace evidence identifies the selected capability | Read completion is evidence of a read, not a test, write, or code-change success. |
| `change-plan` | A request containing a write/fix intent | Create a persistent, review-only plan with an explicit test milestone; do not run an agent, tool, write, or test | Open the existing plan-review surface and label the plan as pending user approval and unverified | No success, applied, fixed, or tested claim is emitted. Any later execution still needs real verification evidence. |
| `general-chat` | Any other request | Preserve the existing single-shot Architect Agent lifecycle | Normal chat response | Remains `unverified` unless a separate real verifier records evidence. |

Classification is deliberately conservative. A read/explain request selects a scoped read capability only when its wording explicitly names a file and there is a canonical active file path. A write/fix/test request always becomes a reviewable plan rather than an executable operation. Ambiguous requests remain normal chat; they never gain write access by keyword inference.

## Safety decisions

The workspace-file capability is created from the already resolved `WorkspaceIdentity`. It accepts only an already sanitized relative path, resolves it again with `WorkspaceService`, rejects directories, symlinks, and oversized files, and reads UTF-8 content without accepting a browser filesystem root. It must be available only to the current task and not be registered globally, so the simulated interpreter and external HTTP tool are never exposed by P1 routing.

Impact review during implementation found that the existing normal-chat model router can select its synthetic fallback when no real provider is available. Allowing a successful `read-explain` task to continue through that engine would turn a real file read into an untruthful explanation claim. The safer correction is to keep the real scoped read evidence, but return an explicit model-unavailable outcome instead of dispatching the synthetic engine. General chat keeps its existing behavior outside this P1 capability path; P1 does not broaden or rename that pre-existing fallback.

A full-suite impact check then showed that the first read classifier overmatched ordinary file-reading context requests. The classifier was narrowed again to require an explicit `read`, `open`, or `inspect` verb, a file reference, and an explanation verb. This preserves existing general-chat behavior for requests such as “explain this code” and “read the file and tell me what you see,” while still recognizing “read and explain the active file.”

The change-plan path is policy-generated and explicitly labeled `capability-policy`, rather than being represented as a model-generated plan when no configured planning engine exists. The plan includes a mandatory review and a mandatory real test/verification milestone, but it performs no work before user approval. Plan creation and its WebSocket event stay scoped to the authenticated user and selected project.

## Required proof cases

The P1 regressions must prove that an owned active workspace file is read through the scoped capability, that cross-user and traversal paths are denied, and that normal read/explain routing cannot access `code_interpreter`, `http_request`, or a write capability. They must also prove that a fix/test request creates a persistent draft plan, contains a verification milestone, opens review in the main chat response, performs no write or test, and carries no passed verification result. Existing general-chat lifecycle and execution-truth regressions must remain green.

## Completion meaning

“Checked out” for this P1 means the source route, UI contract, workspace containment, scoped event delivery, trace evidence, plan state, focused regressions, full server suite, full application suite, lint, production build, whitespace scan, protected-asset scan, staged diff review, remote SHA parity, and clean working tree all passed. It does not mean a model was integrated, an arbitrary command was run, a file was changed, or tests were claimed to pass without an authoritative verification record.
