# TEST_MATRIX.md
## Code Siren IDE — Test Coverage Inventory

**Date:** 2026-06-21
**Current coverage:** ~1.5% (1 e2e file, 0 unit/integration tests)

---

## Priority Matrix

| # | Feature | Current | Criticality | Recommended Tests | Priority |
|---|---|---|---|---|---|
| 1 | AgentManager.send() | e2e only | P0 | Unit: register/list/get, dispatch, error handling, trust score update, trace generation | P0 |
| 2 | Security Sandbox | e2e only | P0 | Unit: executeInSandbox (allow, block require, block process, timeout, memory), validateBrowserAction, validateShellCommand | P0 |
| 3 | Memory Engine | e2e only | P0 | Unit: embed (stub), memorize (store), search (retrieve), cosine similarity, cross-agent recall | P0 |
| 4 | Terminal execution | e2e only | P0 | Unit: validateShellCommand (all blocklist patterns), integration: propose→validate→gate→execute | P0 |
| 5 | Authentication | e2e only | P0 | Integration: register, login, me, face enroll/disable/verify, JWT verify, requireAuth middleware | P0 |
| 6 | API routes | e2e only | P1 | Integration: agents send, traces list/get, skills install/invoke, fabrication, operative, voice, sentinel, presence, models, project-files | P1 |
| 7 | Execution modes | e2e only | P1 | Unit: single-shot (one LLM call), react (Thought-Action-Observation loop), codeact (python block + tool), LoopGuard (identical, ping-pong, budget) | P1 |
| 8 | Tracing | e2e only | P1 | Unit: startTrace, addStep, addToolResult, completeTrace, getTrace, listTraces | P1 |
| 9 | Ghost Mode | e2e only | P1 | Unit: state transitions (inactive→scanning→detected→planning→awaiting_approval→applying→verifying→complete), level setting, finding report | P1 |
| 10 | ModelRouter | e2e only | P1 | Unit: pickEngine (ollama/openrouter/stub), embed (pseudo-embedding), stub engine stream | P1 |
| 11 | Skills Vault | e2e only | P1 | Unit: loadSkill (TOML parse), verifySignature, renderTemplate, executeSkill | P1 |
| 12 | SidecarManager | e2e only | P1 | Unit: spawn, request, kill, crash handling (SidecarCrashedError) | P1 |
| 13 | Code Review gate | e2e only | P1 | Unit: review() fast-path security checks, parseReviewResponse, writeProjectFile gate | P1 |
| 14 | UI components | none | P2 | Component tests: ChatPanel, SettingsModal, gesture handler | P2 |
| 15 | WS events | e2e only | P2 | Integration: connect, auth, broadcast, disconnect | P2 |

---

## Current Test Files

| File | Type | Tests | Coverage area |
|---|---|---|---|
| `server/tests/e2e-architect.ts` | E2E | 69 assertions | All 10 merge steps + 3 fixes |

**That's it.** 1 file, 0 unit tests, 0 integration tests, 0 agent tests, 0 security tests.

---

## Target Coverage

| Layer | Current | Target | Files needed |
|---|---|---|---|
| Critical paths (P0) | ~5% | ≥80% | ~8 test files |
| Overall (P0+P1) | ~1.5% | ≥40% | ~12 test files |
| UI (P2) | 0% | — | Deferred |

---

## Test Framework

- **vitest** — unit + integration tests (fast, ESM-native, TypeScript-native)
- **Coverage** — vitest built-in (c8/v8)
- **No playwright** — UI tests deferred to Phase 6+
