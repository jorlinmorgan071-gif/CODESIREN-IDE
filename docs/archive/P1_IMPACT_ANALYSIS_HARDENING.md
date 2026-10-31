# P1 Changed-Surface Impact Analysis Hardening

## Audited gap

Before this P1 slice, Code Siren had an authoritative workspace boundary, exact patch transaction, real disk reconciliation, and spawn-based test execution. It did **not** have a service that derived the impact of a proposed source change from repository evidence. Any assertion that a dependent, route, test, or verification step was affected would therefore have been manual judgment rather than an auditable result.

This record defines and records the single authoritative impact-analysis contract implemented in `server/src/changes/impact.ts`. It does not add a model, a model provider, a natural-language dependency guesser, a second write path, or a second verification executor. TypeScript is an explicit server runtime dependency because this service calls the real compiler API while a transaction is being planned.

## Contract

Impact analysis accepts the same immutable evidence as a change transaction: authenticated user, selected project, canonical workspace-relative path, exact current disk content, and complete proposed replacement content. The service resolves the workspace using `WorkspaceService` and refuses analysis if the client baseline differs from disk. It never accepts a browser root or an arbitrary absolute path.

| Evidence class | Authoritative source | Output rule |
|---|---|---|
| Changed surface | Byte-for-byte `before` and `after` contents | Compute deterministic baseline and proposal ranges by shared prefix/suffix; never infer a change from a prompt. |
| TypeScript symbols | TypeScript AST and compiler program built from the nearest in-workspace `tsconfig.json` | Report declarations overlapping the baseline or immutable proposal range, so both removed and added symbols are evidenced. A module-level change is explicit when no named declaration covers either range. |
| Dependents | TypeScript module resolver and AST import/export declarations | Report only source files whose import resolves to the changed module, with named import evidence where available. |
| Routes | Static Express mount and route declarations in the actual repository source | Report only discovered route modules that are changed or compiler-derived dependents. If static discovery cannot prove a route, return none rather than inventing one. |
| Tests | Actual `*.test.ts` / `*.test.tsx` imports resolved by the compiler plus directly adjacent test files that exist on disk | Distinguish compiler-import evidence from adjacent-file evidence. Do not treat a test name as proof by itself. |
| Verification set | Owning package configuration plus the affected test paths | Return a minimal **declared** typecheck/test set. It is a plan, not an execution result. A successful claim still requires the existing real verification executor later. |

## Scope and failure semantics

The service supports TypeScript files only. A non-TypeScript changed file returns `not-applicable` with an explicit reason, not empty evidence labelled as success. If the workspace has no in-boundary `tsconfig.json`, or compiler configuration cannot be read, TypeScript impact is `unavailable`; a mutation transaction must not label its verification plan complete from that absence.

Analysis creates no process, network request, browser navigation, terminal command, disk write, approval, or model request. It only provides evidence for the existing authoritative transaction. The result carries `status`, `confidence`, and `gaps` so a UI cannot present partial evidence as a complete verification result.

## Transaction integration

`planChangeTransaction()` invokes the one analysis service after it has verified the exact editor/disk baseline and computed the immutable replacement. The plan response exposes the full impact result alongside the server-computed diff. Approval, write, disk reconciliation, and real verification retain their existing meaning; impact planning does not turn a change into an applied or verified result.

The existing Inline AI review preview receives the returned result through the typed client contract. It labels the output **Changed-Surface Analysis** and its commands **Declared verification — not run**. The UI never turns a plan status into a passed result.

## Validation requirements

Focused regressions must prove all of the following with real fixture workspaces:

1. A changed exported TypeScript symbol identifies compiler-resolved direct importers and named import evidence.
2. Tests that import the changed module are included, while unrelated tests are not.
3. A discovered Express route module exposes its mounted HTTP route.
4. The minimal verification set includes the owning package typecheck and only affected test paths.
5. Traversal, cross-user access, stale client baseline, missing TypeScript configuration, and non-TypeScript files fail closed or report explicit non-applicability.
6. Change-transaction planning returns impact evidence without creating a second mutation path.

## Implemented validation evidence

The focused server regression `tests/security/impact-analysis.test.ts` creates real tenant-scoped workspaces through `WorkspaceService`. It proves direct compiler-resolved imports, compiler-resolved tests, static Express mount-plus-method evidence, package-script-derived declared checks, non-TypeScript non-applicability, unavailable output for missing TypeScript configuration, added/deleted declaration coverage, direct traversal rejection by the analyzer itself, and transaction-plan attachment without a write. The existing `tests/security/change-transaction.test.ts` now asserts that an unconfigured project gets explicit unavailable impact output rather than a fabricated zero-impact result.

The focused frontend regression `app/tests/change-impact.test.ts` proves that the review summary reports static evidence counts and preserves unavailable analysis as an explicit message. It also preserves the `planned` verification status instead of presenting a check as executed.

During implementation, review identified a material precision defect in the initial AST approach: inspecting only the current disk file would reduce a newly added declaration to a generic module-surface change. The safer minimal correction was to parse the immutable proposed content as a separate AST and merge only declarations overlapping the baseline or proposal change ranges. A focused added/removed declaration test now protects this behavior.

`checked out` for this P1 means that the output is produced from actual workspace files and TypeScript/compiler resolution, its unknowns are explicit, and the proposed verification commands have not been represented as executed until the existing verification path records their result. It does **not** mean dynamic imports, runtime-only route registration, generated code, reflection, or the declared checks themselves have been verified by this analyzer.
