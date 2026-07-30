# CODEBASE_HEALTH.md
## Code Siren IDE — Phase 0 Audit

**Audit date:** 2026-06-21
**Auditor:** Lead Architect (AI)
**Codebase version:** Post-merge, post-Fix 1/2/3, all 20 agents live

---

## 1. Architecture Score: 8.2 / 10

| Dimension | Score | Notes |
|---|---|---|
| **Separation of concerns** | 9/10 | Clear layers: UI → WS → AgentManager → dispatchStrategy → ModelRouter. Agents don't call each other directly. |
| **Interface boundaries** | 9/10 | 5 deployment-time swap interfaces (PrinterClient, BrowserClient, DeviceClient, VoiceClient, Sandbox). All use get/set pattern. |
| **Governance** | 9/10 | Ghost Mode FSM shared by Sentinel + Terminal. Code Review gate on file writes. Security Sandbox proven catching real violations. |
| **Observability** | 8/10 | Every agent run traced in runs.jsonl with structured steps. API endpoints for inspection. Missing: real-time metrics, cost tracking. |
| **Test coverage** | 3/10 | 1 test file (e2e-architect.ts) for 68 server source files. No unit tests, no integration tests, no CI. |
| **Type safety** | 9/10 | Zero type errors on both server and app. Strict mode enabled. |
| **Error handling** | 7/10 | Agents catch and yield error chunks. Missing: global error boundary on server, structured error codes on all routes. |
| **Documentation** | 6/10 | Inline comments are good. Missing: API reference, contributor guide, deployment guide. |
| **Dependency health** | 7/10 | Server deps are clean. App has 51 deps (some heavy: recharts, embla-carousel). Bundle is 503KB JS. |

---

## 2. Strengths

1. **Proven architecture** — 10-step merge with evidence at every gate. Every system has trace proof.
2. **20 real IAgent implementations** — all routed through one `AgentManager.send()`, all under Ghost Mode governance, all with Trust Scores.
3. **5 deployment-time swap interfaces** — PrinterClient, BrowserClient, DeviceClient, VoiceClient, Sandbox. Drop-in replacement via `set*Client()`.
4. **Security Sandbox** — isolated-vm v6.1.2, 32MB/30s, proven catching `require()`, `process.env`, timeouts BEFORE any agent used it.
5. **Memory Engine** — real embeddings via ModelRouter.embed() (Ollama/OpenAI/stub), pgvector cosine similarity, cross-agent recall proven.
6. **Code Review gate** — `writeProjectFile()` funnel, fast-path security checks (hardcoded secrets, SQL injection, eval, CORS *), LLM-based scoring.
7. **Terminal Agent** — real `execSync()` gated by `validateShellCommand()` blocklist + Ghost Mode approval. No autonomous execution.
8. **Ollama integration** — auto-detect, auto-start `ollama serve`, model picker UI, OpenRouter fallback.
9. **Zero donor references** — grep-audit clean across entire codebase.
10. **8 SQL migrations** — 19 tables total, all following the PDF Section 11 convention.

---

## 3. Technical Debt

| # | Debt item | Severity | Effort | Notes |
|---|---|---|---|---|
| 1 | **Test coverage: 1.5%** | Critical | High | 1 e2e test for 68 source files. Need unit + integration + agent tests. |
| 2 | **No CI/CD** | High | Medium | No GitHub Actions, no pre-commit hooks, no automated testing. |
| 3 | **No rate limiting** | High | Low | Express routes have no rate limiting. WS has no message rate limit. |
| 4 | **WS message handling is stub** | Medium | Medium | `ws.on('message')` just logs. No editor:save, terminal:input, collab:cursor handlers. |
| 5 | **App bundle is 503KB** | Medium | Medium | No code splitting, no lazy loading. recharts + embla-carousel are heavy. |
| 6 | **Degraded DB mode** | Low | Low | Server works without Postgres but persistence is lost. Not a bug — by design. |
| 7 | **No API documentation** | Medium | Low | 42 endpoints across 12 route files, no OpenAPI/Swagger. |
| 8 | **Stub engine for LLM** | Low | Low | By design — activates real Ollama/OpenRouter when available. Not debt. |
| 9 | **30 lint errors in app** | Medium | Low | 29 errors (mostly `react-hooks/refs`), 1 warning. Need to fix gesture.ts ref pattern. |
| 10 | **No dashboard/metrics UI** | Medium | Medium | No real-time agent status, cost tracking, or performance visualization. |

---

## 4. Unused Code

| Export | File | Status |
|---|---|---|
| `StubBrowserClient` | browser-client.ts | Exported but never imported (used internally by getBrowserClient) |
| `setBrowserClient` | browser-client.ts | Deployment-time swap — intentionally unused in dev |
| `StubDeviceClient` | device-client.ts | Same pattern — used internally |
| `KasaSidecarDeviceClient` | device-client.ts | Same — used internally by activeDeviceClient |
| `setDeviceClient` | device-client.ts | Deployment-time swap |
| `StubPrinterClient` | printer-client.ts | Same pattern |
| `setPrinterClient` | printer-client.ts | Deployment-time swap |
| `manifestBytes` | skills/manifest.ts | Exported for testing, not used in production |
| `StubVoiceClient` | voice-client.ts | Same pattern |
| `setVoiceClient` | voice-client.ts | Deployment-time swap |
| `parseFinalAnswer` | strategies/react.ts | Exported for testing, not used externally |
| `extractCode` | strategies/codeact.ts | Same |
| `stripToolCallText` | strategies/codeact.ts | Same |
| `requireAuthOptional` | auth/middleware.ts | Defined but no route uses it yet |
| `memHas` | db/client.ts | Defined but never called |

**Assessment:** Most "unused" exports are deployment-time swap functions (`set*Client`) or test helpers — they're intentionally exported for future use. Not dead code, just not yet exercised in the default configuration.

---

## 5. Performance Bottlenecks

| Bottleneck | Impact | Fix |
|---|---|---|
| **App bundle: 503KB JS** | Slow cold start on mobile/low-end | Code splitting, lazy load recharts/carousel |
| **No request caching** | Repeated API calls hit server | Add Express middleware caching for /api/health, /api/agents, /api/models |
| **Memory Engine: synchronous embed** | Blocks agent execution during embedding | Queue embeddings, fire-and-forget memorize() |
| **No connection pooling for Ollama** | New HTTP connection per stream | Use keep-alive agent |
| **App re-renders** | AppContext useReducer causes full tree re-render | Split contexts, use selectors |
| **WS broadcast to all clients** | Every event goes to every connected client | Filter by projectId |

---

## 6. Missing Tests

| Area | Current | Needed | Priority |
|---|---|---|---|
| **Unit tests** | 0 | Agent constructors, type validation, config parsing, JWT sign/verify, sandbox validators, shell command validators, skill manifest parser, LoopGuard, memory cosine similarity | Critical |
| **Integration tests** | 0 | API route tests (auth, agents, traces, skills, fabrication, operative, voice, sentinel, presence, models, project-files, sandbox) | High |
| **Agent tests** | 0 | Each agent's execute() with stub engine — verify chunks, traces, memorize calls | High |
| **Tool tests** | 0 | ToolRegistry, writeProjectFile (gate accept/reject), validateShellCommand, validateBrowserAction | High |
| **Security tests** | 0 | Sandbox catches (require, process.env, timeout, memory), face auth (enroll/verify/reject), biometric isolation | Critical |
| **E2E tests** | 1 (e2e-architect.ts, 69 checks) | More scenarios: multi-agent, voice, fabrication pipeline, sidecar lifecycle | Medium |
| **Stress tests** | 0 | Concurrent agent tasks, WS connection limits, memory store limits | Low |

---

## 7. Risk Matrix

| Risk | Probability | Impact | Score | Mitigation |
|---|---|---|---|---|
| **No rate limiting → DoS** | High | High | 9 | Add express-rate-limit middleware |
| **No CI → regressions ship** | High | High | 9 | Add GitHub Actions: typecheck + lint + test |
| **WS stub → no real-time collab** | Medium | Medium | 6 | Implement WS message handlers (Phase 2+) |
| **No input validation on WS** | Medium | High | 7 | Validate WS messages with zod |
| **Bundle size → slow load** | Medium | Low | 4 | Code splitting, lazy loading |
| **Memory store unbounded** | Low | Medium | 4 | Add TTL + eviction (Phase 4) |
| **Sidecar orphan on crash** | Low | High | 5 | Already mitigated (Step 4/7 proofs) |
| **Biometric data leak** | Low | Critical | 5 | Already mitigated (Step 10 proofs) |
| **Prompt injection via agent** | Medium | High | 7 | Sandbox validates evaluate actions |
| **Terminal command injection** | Low | Critical | 4 | Already mitigated (Fix 2 blocklist + Ghost Mode) |

---

## 8. Dependency Issues

### Server (12 deps, 10 devDeps)
- **Clean** — no missing, no conflicts, no vulnerabilities on core deps.
- `isolated-vm` is a native addon (requires build tools on install).
- `bcrypt` is also native (alternative: `bcryptjs` for pure JS).

### App (51 deps, 18 devDeps)
- **Missing deps after fresh install** — `node_modules` was wiped. `npm install` restores correctly.
- **Bundle heavyweights**: `recharts` (charts), `embla-carousel-react` (carousel), `@monaco-editor/react` (editor). Consider lazy loading.
- **30 lint errors** — mostly `react-hooks/refs` in gesture.ts (ref update during render).

### Python sidecars
- `build123d` — installed, working. Font warnings are non-fatal.
- `python-kasa` — installed, working. DeprecationWarning on `SmartDevice` import.

---

## 9. Improvement Roadmap

### Phase 1 — Stabilize (immediate)
- [ ] Add `npm run doctor` (health check script)
- [ ] Add `npm run verify` (typecheck + lint + test + grep-audit)
- [ ] Fix 30 lint errors in app
- [ ] Add `.gitignore` for node_modules, dist, .traces, .stl-out, .biometric-templates

### Phase 2 — Agent Evolution (next)
- [ ] Agent metadata (capabilities, stats, health)
- [ ] Agent execution statistics (success rate, avg duration, tool call count)
- [ ] Agent health monitor (stale agents, error rate spikes)
- [ ] Confidence calibration (trust score → confidence mapping)

### Phase 3 — Tool Maturity
- [ ] Add retry/timeout/metrics to ToolRegistry
- [ ] Add rollback to writeProjectFile
- [ ] Tool execution metrics (success, duration, errors, frequency)

### Phase 4 — Memory Improvement
- [ ] Memory TTL + eviction
- [ ] Memory compression (summarize old entries)
- [ ] Retrieval ranking (boost recent, boost high-trust-agent memories)
- [ ] Memory statistics endpoint

### Phase 5 — Dashboard
- [ ] Real-time agent status grid
- [ ] Execution timeline
- [ ] Cost/token tracker
- [ ] Error feed
- [ ] Memory browser

### Phase 6 — Testing
- [ ] Unit tests for critical paths (sandbox, auth, memory, agents)
- [ ] Integration tests for API routes
- [ ] Agent execution tests
- [ ] Security tests
- [ ] 90% critical path coverage

### Phase 7 — Performance
- [ ] Code splitting (lazy load recharts, carousel, monaco)
- [ ] Express response caching
- [ ] App context splitting (reduce re-renders)
- [ ] WS message filtering by projectId

### Phase 8 — Security Hardening
- [ ] Rate limiting (express-rate-limit)
- [ ] WS message validation (zod schemas)
- [ ] Audit logs (all tool calls, all file writes, all auth events)
- [ ] Secret scanning in CI

### Phase 9 — Release
- [ ] UPGRADE_REPORT.md
- [ ] ARCHITECTURE_DIFF.md
- [ ] BENCHMARKS.md
- [ ] FINAL_SCORE.md

---

## 10. Summary

**Architecture is sound.** The 10-step merge produced a well-structured, proven codebase with clear boundaries, real governance, and real tool execution. The main gaps are:

1. **Testing** — almost zero coverage. This is the #1 risk.
2. **No CI** — regressions can ship undetected.
3. **No rate limiting** — DoS vulnerability.
4. **No dashboard** — no visibility into agent health/performance.
5. **Bundle size** — 503KB JS, no code splitting.

None of these require architectural changes. All can be fixed by extending, wrapping, or instrumenting the existing systems — exactly as the Evolution Upgrade rules require.

**Next step:** Phase 1 — Stabilize.
