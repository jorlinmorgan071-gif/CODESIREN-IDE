# P0 Authoritative Change Transaction Spine

## Contract

Every approved IDE edit now has one server-owned transaction: **plan → authenticated approval → review-gated patch → disk write → disk reread/reconciliation → diff → declared verification → exact result**. The transaction is bound to the existing `WorkspaceService` `{ userId, projectId, rootPath }` identity and never accepts a browser filesystem root.

## Audit findings

The prior Inline AI flow generated a preview through `/orchestrator/refactor` and, after a client-side Accept click, dispatched `code-siren:apply-edit`. Monaco updated only its memory buffer. No workspace file changed, no review gate ran, no diff was computed from disk content, no trace existed, and no verification result could be trusted.

Existing components were reused rather than duplicated. `WorkspaceService` remains the authority for tenant ownership and canonical path containment. `writeProjectFile()` remains the sole review-gated disk-write funnel. Trace verification records remain the authority for executed checks. The new `change-transaction-service` connects those existing components in one ordered flow.

## Stage behavior

| Stage | Enforced behavior |
|---|---|
| Plan | Reads one existing canonical workspace file, requires one unambiguous selected source range, and refuses to plan unless the complete visible Monaco buffer exactly matches current disk content. |
| Approval / applying | Requires the authenticated owner of the transaction. Approval atomically moves `planned` to `applying` before the review await, so a transaction can be approved once and concurrent approval requests cannot race a second write. |
| Patch | Computes an exact replacement from the server-read file; no client diff is trusted as the patch authority. |
| Disk | Reuses `writeProjectFile()` and its Code Review gate. Rejection writes nothing. |
| Reconciliation | Rereads disk and succeeds only when it exactly equals the approved replacement. |
| Diff | Returns a deterministic server-computed preview of the exact full-file before/after state. |
| Verification | Records `disk-reconcile` as an actual custom verification record on the scoped trace. |
| Monaco | Receives only a successful server reconciliation payload and updates the existing AppContext file buffer; no second editor store was introduced. The client rejects approval if Monaco changed after planning. |

## Safety decisions

The transaction refuses a patch if the file changed between planning and approval, so it cannot overwrite a newer disk edit. It rejects missing, absolute, traversal, symlink-escaped, or foreign-project paths through WorkspaceService. Its diff is a complete deterministic server-computed before/after representation, not a truncated model summary. The UI will not perform an in-memory substitute when no real workspace file identity is selected. The workspace router now emits a bounded inventory and exact content reads from the authenticated canonical root; tabs retain that server-derived relative path separately from their display name. Inline AI therefore fails closed only until the user selects one of those real workspace files, rather than guessing a target from demo data. A future command/test verifier may extend the declared check set, but it must record actual execution through the existing verification subsystem rather than generate a success message.

## Evidence before final release gate

Focused backend regression coverage proves a real owned workspace file is planned, approved, written, reread, diffed, and trace-verified; it also proves stale disk plans, stale editor snapshots, concurrent double approval, and cross-user approval are refused. Focused frontend coverage proves that workspace inventories retain only server-derived paths, server file content is accepted only by the matching tab, and successful reconciliation updates the existing buffer and clears only the reconciled tab marker. Full server tests, full frontend tests, lint, production build, whitespace/protected-asset audit, commit, push, and remote parity remain required before this slice is published.
