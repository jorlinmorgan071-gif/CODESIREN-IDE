# Code Siren IDE

> AI-powered development environment. Single Express + WS server, single JWT auth, single ModelRouter, single AgentManager.send() — every input modality (typed chat, voice, gesture) routes through the same agent bus.

**Current version:** Phase 6 — DX + Release Readiness
**License:** private
**Status:** production-ready (build green, 96/96 tests pass, no donor-project names in code)

---

## Quick Start (≤10 min from fresh clone)

### Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 20.x | Server + app runtime |
| npm | ≥ 10.x | Package manager |
| (optional) PostgreSQL | ≥ 14 | Persistent storage (server runs in degraded in-memory mode without it) |
| (optional) Ollama | any | Local LLM (server falls back to stub if absent) |

### 1. Clone & install (2 min)

```bash
git clone <repo-url> code-siren
cd code-siren

# Install server deps
cd server
cp .env.example .env
npm install

# Install app deps
cd ../app
npm install
```

### 2. Configure (1 min)

Edit `server/.env` — the only required value is `JWT_SECRET` (must be ≥32 chars). The defaults work for local development.

```bash
# Generate a strong JWT secret
openssl rand -hex 32
# Paste into server/.env as JWT_SECRET=...
```

### 3. Preflight (1 min)

Verify the environment is ready before starting the server:

```bash
cd server
npm run preflight
```

This checks: Node version, env vars, port availability, optional Postgres, optional Ollama. Exits non-zero on critical issues.

### 4. Start the server (1 min)

```bash
cd server
npm run dev        # starts on http://localhost:3001
```

You should see:

```
[server] HTTP  http://localhost:3001
[server] WS    ws://localhost:3001/ws?token=JWT&projectId=UUID
[server] Agents: architect-agent, qa-tester-agent, ... (20 total)
[server] Ghost: state=scanning level=approval-required
```

### 5. Start the app (1 min, separate terminal)

```bash
cd app
npm run dev        # starts on http://localhost:3000
```

Open http://localhost:3000 — the IDE loads, auto-registers a dev user, and connects to the backend via WS.

### 6. Verify (1 min)

Run the doctor (separate terminal, server still running):

```bash
cd server
npm run doctor
```

Expected output: `✓ ALL CHECKS PASSED`.

### 7. Run tests (2 min)

```bash
cd server
npm test           # 96 tests, ~4s
```

**Total: ~9 minutes from clone to verified running system.**

---

## Architecture Map

```
code_siren/
├── server/                          Node + Express + WS backend
│   ├── src/
│   │   ├── index.ts                 Bootstrap: 1 Express + 1 WS on 1 port
│   │   ├── config.ts                Zod-validated env config
│   │   ├── types.ts                 AgentTask, AgentChunk, AgentDomain, ExecutionMode
│   │   │
│   │   ├── agents/                  20 IAgent implementations
│   │   │   ├── base-agent.ts        abstract IAgent (PDF Section 05)
│   │   │   ├── _shared/
│   │   │   │   ├── tool-registry.ts calculator, code_interpreter, think
│   │   │   │   └── project-files.ts Code Review gate (writeProjectFile)
│   │   │   ├── architect/           Planning agent (Step 0 — first real IAgent)
│   │   │   ├── qa-tester/           Test generation
│   │   │   ├── extension/           Skills Vault manager
│   │   │   ├── frontend/            UI codegen
│   │   │   ├── backend/             API codegen
│   │   │   ├── database/            Schema design
│   │   │   ├── security/            Threat modeling
│   │   │   ├── devops/              CI/CD
│   │   │   ├── documentation/       Docs
│   │   │   ├── performance/         Profiling
│   │   │   ├── terminal/            Shell exec (Ghost Mode approval)
│   │   │   ├── memory/              Recall surface
│   │   │   ├── ui-designer/         Design tokens
│   │   │   ├── research/            Deep research
│   │   │   ├── deployment/          Deploy pipelines
│   │   │   ├── prompt-engineer/     Prompt tuning
│   │   │   ├── code-review/         Review gate
│   │   │   ├── fabrication/         CAD + 3D printer (build123d sidecar)
│   │   │   ├── operative/           Browser + smart home (kasa sidecar)
│   │   │   └── sentinel/            Ambient monitoring (Ghost Mode)
│   │   │
│   │   ├── orchestration/
│   │   │   ├── agent-manager.ts     send(task) — single entry point
│   │   │   ├── model-router.ts      Ollama → OpenRouter → stub fallback
│   │   │   ├── ghost-mode.ts        9-state FSM + 4 autonomy levels
│   │   │   ├── loop-guard.ts        Identical/ping-pong/poll-budget detection
│   │   │   ├── strategies/
│   │   │   │   ├── dispatcher.ts    Picks strategy from executionMode
│   │   │   │   ├── single-shot.ts   One LLM call
│   │   │   │   ├── react.ts         ReAct loop
│   │   │   │   └── codeact.ts       Code-action loop
│   │   │   └── engines/
│   │   │       └── ollama.ts        Real Ollama engine + auto-start
│   │   │
│   │   ├── auth/                    Single JWT auth (register/login/me)
│   │   │   ├── jwt.ts
│   │   │   ├── routes.ts
│   │   │   ├── middleware.ts        requireAuth
│   │   │   └── face-factor.ts       Second factor (biometric template file)
│   │   │
│   │   ├── db/
│   │   │   ├── client.ts            pg Pool + degraded in-memory fallback
│   │   │   ├── migrate.ts           Runs migrations in order
│   │   │   └── migrations/          8 SQL files (001-008)
│   │   │
│   │   ├── ws/
│   │   │   ├── server.ts            Single WS server (PDF Section 13)
│   │   │   └── events.ts            Typed event registry + broadcast sink
│   │   │
│   │   ├── routes/                  14 route files
│   │   │   ├── agents.ts            POST /api/agents/:id/send
│   │   │   ├── health.ts            GET /api/health
│   │   │   ├── system-health.ts     GET /api/system/health (Phase 6)
│   │   │   ├── traces.ts            GET /api/traces
│   │   │   ├── dashboard.ts         11 read-only aggregation endpoints
│   │   │   ├── models.ts            Ollama model listing + selection
│   │   │   ├── skills.ts            Skills Vault API
│   │   │   ├── fabrication.ts       CAD + printer
│   │   │   ├── operative.ts         Browser + devices
│   │   │   ├── sentinel.ts          Sentinel + Ghost Mode
│   │   │   ├── sandbox.ts           isolated-vm sandbox
│   │   │   ├── voice.ts             Voice sessions
│   │   │   ├── presence.ts          Gesture + face auth
│   │   │   └── project-files.ts     Code Review gate funnel
│   │   │
│   │   ├── middleware/
│   │   │   ├── rate-limiter.ts      Per-IP + per-user (Phase 3)
│   │   │   ├── error-handler.ts     Timeout + 404 + error boundary (Phase 3)
│   │   │   ├── circuit-breaker.ts   Downstream failure containment (Phase 3)
│   │   │   └── cache.ts             Short-TTL GET cache (Phase 5)
│   │   │
│   │   ├── monitoring/
│   │   │   ├── security-log.ts      Security event ring buffer (Phase 3)
│   │   │   └── performance-metrics.ts Latency histogram (Phase 5)
│   │   │
│   │   ├── observability/
│   │   │   └── traces.ts            Agent run traces (JSONL + ring buffer)
│   │   │
│   │   ├── memory/
│   │   │   └── engine.ts            MemoryEngine (embed + search, pgvector)
│   │   │
│   │   ├── security/
│   │   │   └── sandbox.ts           isolated-vm v6 (32MB/30s, no require/process/fs)
│   │   │
│   │   ├── sidecars/
│   │   │   └── manager.ts           Spawns+owns Python sidecars (crash → error)
│   │   │
│   │   ├── skills/
│   │   │   ├── manifest.ts          TOML parser + Ed25519 signature verify
│   │   │   ├── executor.ts          Runs skill steps via toolRegistry
│   │   │   └── discovery.ts         Mines traces for recurring sequences
│   │   │
│   │   └── systems/
│   │       └── voice/
│   │           └── voice-client.ts  Voice client interface (5 swap interfaces)
│   │
│   ├── scripts/                     Operator utilities
│   │   ├── doctor.ts                Health check (Phase 1, expanded Phase 6)
│   │   ├── preflight.ts             Pre-startup validation (Phase 6)
│   │   ├── benchmark.ts             Latency benchmark
│   │   ├── reset.ts                 Clear runtime state (legacy)
│   │   ├── safe-reset.ts            Safer reset with confirm + backup (Phase 6)
│   │   ├── backup.ts                Backup DB + traces + biometrics (Phase 6)
│   │   ├── restore.ts               Restore from backup (Phase 6)
│   │   ├── export-traces.ts         Export traces as JSON (Phase 6)
│   │   └── export-settings.ts       Export settings as JSON (Phase 6)
│   │
│   ├── sidecars/                    Python helpers
│   │   ├── build123d/sidecar.py     CAD generation
│   │   └── kasa/sidecar.py          Smart home control
│   │
│   ├── tests/                       96 tests across 9 files
│   │   ├── unit/                    traces, memory, ghost-mode, sandbox, skills, loop-guard
│   │   ├── integration/             auth
│   │   ├── agent/                   agent-manager
│   │   ├── security/                project-files Code Review gate
│   │   └── e2e-architect.ts         End-to-end proof
│   │
│   └── .env.example
│
├── app/                             React 19 + Vite 7 + Tailwind 3 frontend
│   ├── src/
│   │   ├── App.tsx                  Routes: / + /dashboard (lazy)
│   │   ├── pages/
│   │   │   ├── Home.tsx             IDE shell (TitleBar, IconSidebar, FileExplorer, CodeEditor, ChatPanel, Terminal, modals — all lazy)
│   │   │   └── Dashboard.tsx        Control Center (9 views, lazy-loaded)
│   │   ├── components/
│   │   │   ├── layout/              TitleBar, IconSidebar, FileExplorer, StatusBar
│   │   │   ├── editor/              CodeEditor (Monaco, lazy)
│   │   │   ├── chat/                ChatPanel (lazy)
│   │   │   ├── terminal/            Terminal (xterm, lazy)
│   │   │   ├── panels/              InlineAI (lazy)
│   │   │   ├── modals/              AgentPanel, SettingsModal (lazy)
│   │   │   ├── dashboard/           9 read-only views (Phase 4)
│   │   │   └── ui/                  shadcn/ui primitives
│   │   ├── store/                   AppContext, themes, demoData
│   │   ├── lib/                     api, ws, auth, dashboardApi, utils
│   │   ├── systems/presence/        gesture input
│   │   └── types/                   Mirror of server types
│   └── vite.config.ts               manualChunks: react-vendor, radix-vendor, monaco-vendor, etc.
│
├── scripts/
│   └── grep-audit.sh                Naturalization audit (zero donor names)
│
├── .github/workflows/ci.yml         Server + app CI
├── README.md                        This file
├── SETUP_REPORT.md                  Phase 6 onboarding report
├── RELEASE_GUIDE.md                 Phase 6 release runbook
└── PHASE{1-6}_REPORT.md             Phase reports
```

### Key invariants (DO NOT MODIFY — enforced across all 6 phases)

- **One Express server, one WS server, one port** (PDF Section 12+13)
- **One JWT auth flow** — face auth is a second factor on the same token, not a parallel path
- **One `AgentManager.send(task)`** — typed chat, voice, gesture all route here
- **One ModelRouter** — Ollama → OpenRouter → stub fallback, with `embed()` for memory
- **One Ghost Mode FSM** — 9 states, 4 autonomy levels, shared by Sentinel + Terminal
- **One MemoryEngine** — pgvector or in-memory, shared by all 20 agents via base-agent
- **One Security Sandbox** — isolated-vm v6, 32MB/30s, no require/process/fs
- **One ToolRegistry** — calculator, code_interpreter, think (extensible via Skills Vault)
- **One traces system** — JSONL append-only + 1000-entry ring buffer

---

## Troubleshooting

### Server won't start

| Symptom | Cause | Fix |
|---|---|---|
| `[config] Invalid environment: JWT_SECRET must be at least 32 chars` | JWT_SECRET missing or too short | `echo "JWT_SECRET=$(openssl rand -hex 32)" >> server/.env` |
| `EADDRINUSE: address already in use :::3001` | Another process on port 3001 | `lsof -i :3001` then kill, OR set `PORT=3002` in `.env` |
| `[db] PostgreSQL unavailable` | Postgres not running | Server starts in degraded in-memory mode — fine for dev. For persistence: `docker run -e POSTGRES_PASSWORD=code_siren -p 5432:5432 postgres:16` |
| `[router] Ollama not available` | Ollama not running | Server falls back to stub engine — fine for dev. For real LLM: `ollama serve` |
| `Cannot find module 'tsx'` | Deps not installed | `cd server && npm install` |
| TypeScript errors on `npm run dev` | Stale build cache | `cd server && npm run typecheck` to see errors, fix, then `npm run dev` |

### App won't load

| Symptom | Cause | Fix |
|---|---|---|
| Blank page at localhost:3000 | Backend not running | Start server first: `cd server && npm run dev` |
| `Unauthorized — token cleared` | JWT secret changed since last login | Clear localStorage: `localStorage.clear()` in browser console, reload |
| WS connection refused | Server not running OR wrong port | Verify `http://localhost:3001/api/health` returns 200 |
| Chunk load error | Stale dist after upgrade | `cd app && rm -rf dist node_modules/.vite && npm install && npm run dev` |

### Tests fail

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE :::3099` in auth test | Leftover server from previous test run | `pkill -f "tsx src/index.ts"` then re-run |
| `Hook timed out in 30000ms` | DB connection attempt timing out | Set `PG_HOST=invalid` to fail fast, or start Postgres |
| Tests pass locally but fail in CI | Node version mismatch | CI uses Node 20 — match locally with `nvm use 20` |

### Ollama-specific

| Symptom | Cause | Fix |
|---|---|---|
| `Ollama not available (fetch failed)` | Ollama not running | `ollama serve` (Linux/Mac) or start Ollama.app (Windows) |
| `OLLAMA_BIN` not set on Windows | Server can't auto-start Ollama | Set `OLLAMA_BIN=C:\Users\YOU\AppData\Local\Programs\Ollama\ollama.exe` in `.env` |
| Models not listed | No models pulled | `ollama pull llama3.2` |

### Performance issues

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard feels slow on first load | All endpoints MISS the cache | Subsequent loads within 5-30s are HITs (3x faster). See `X-Cache: HIT` header. |
| `429 Too Many Requests` | Rate limit hit (default 100/min per IP) | Raise `RATE_LIMIT_PER_IP` in `.env` for dev, or wait 60s |
| Slow request logged (>500ms) | Real bottleneck | `curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/performance/slow-requests` |
| Memory growth over time | V8 heap expansion (normal) | Check `/api/dashboard/system` — RSS growth >50% over an hour indicates a real leak |

### Run the doctor

```bash
cd server
npm run doctor
```

The doctor checks: server reachable, /api/health ok, agents registered, ghost mode running, grep audit passes, typecheck passes.

### Run preflight (before starting server)

```bash
cd server
npm run preflight
```

The preflight checks: Node version, env vars valid, port available, Postgres reachable (warn-only), Ollama reachable (warn-only).

---

## Environment Variables

See `server/.env.example` for the full list with comments. Summary:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | 3001 | Server listen port |
| `NODE_ENV` | no | development | `development` / `test` / `production` |
| `JWT_SECRET` | **yes** | — | ≥32 chars. Generate with `openssl rand -hex 32` |
| `JWT_EXPIRES_IN` | no | 7d | Token TTL |
| `PG_HOST` | no | localhost | Postgres host (server runs in-memory if unreachable) |
| `PG_PORT` | no | 5432 | Postgres port |
| `PG_DB` | no | code_siren | Postgres database name |
| `PG_USER` | no | code_siren | Postgres user |
| `PG_PASSWORD` | no | code_siren | Postgres password |
| `OLLAMA_HOST` | no | http://127.0.0.1:11434 | Ollama API URL |
| `OLLAMA_BIN` | no | — | Ollama binary path (for auto-start; Windows users must set) |
| `OLLAMA_DEFAULT_MODEL` | no | llama3.2 | Default model name |
| `OPENROUTER_API_KEY` | no | — | Cloud LLM fallback (used when Ollama down) |
| `OPENAI_API_KEY` | no | — | Direct OpenAI (not currently routed) |
| `ANTHROPIC_API_KEY` | no | — | Direct Anthropic (not currently routed) |
| `CORS_ORIGINS` | no | http://localhost:3000,... | Comma-separated allowed origins |
| `RATE_LIMIT_PER_IP` | no | 100 | Requests per minute per IP |
| `RATE_LIMIT_PER_USER` | no | 200 | Requests per minute per user |
| `RATE_LIMIT_WS_PER_SEC` | no | 10 | WS messages per second per connection |
| `RATE_LIMIT_WINDOW_MS` | no | 60000 | Rate limit window in ms |
| `REQUEST_TIMEOUT_MS` | no | 30000 | Request timeout in ms |
| `SLOW_REQUEST_THRESHOLD_MS` | no | 500 | Threshold for slow request logging |

---

## NPM Scripts

### Server (`cd server`)

| Script | What it does |
|---|---|
| `npm run dev` | Start server in watch mode (tsx watch) |
| `npm start` | Start server without watch |
| `npm run build` | TypeScript compile to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run vitest (96 tests, ~4s) |
| `npm run test:watch` | Run vitest in watch mode |
| `npm run test:coverage` | Run vitest with coverage report |
| `npm run test:e2e` | End-to-end Architect agent proof |
| `npm run migrate` | Run DB migrations |
| `npm run grep-audit` | Verify zero donor names in code |
| `npm run doctor` | Health check (server reachable + agents + ghost + grep + typecheck) |
| `npm run preflight` | Pre-startup validation (env + port + deps) |
| `npm run benchmark` | Latency benchmark of key endpoints |
| `npm run reset` | Clear runtime state (traces, STL outputs) — legacy |
| `npm run safe-reset` | Safer reset with confirmation + automatic backup first |
| `npm run backup` | Backup DB + traces + biometrics to `backups/` |
| `npm run restore` | Restore from a backup file |
| `npm run export-traces` | Export traces as standalone JSON |
| `npm run export-settings` | Export env + config as JSON (secrets redacted) |
| `npm run verify` | typecheck + grep-audit + test (full pre-commit) |

### App (`cd app`)

| Script | What it does |
|---|---|
| `npm run dev` | Start Vite dev server on port 3000 |
| `npm run build` | Type-check + Vite production build |
| `npm run lint` | ESLint |
| `npm run preview` | Preview production build locally |

---

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push/PR:

- **Server job**: typecheck + tests + `npm audit --audit-level=high` + grep-audit
- **App job**: typecheck + lint + build

Both must pass for PRs to merge.

---

## Reports

| Report | Phase | What it covers |
|---|---|---|
| `PHASE1_REPORT.md` | Stabilize | 30→0 lint errors, scripts, CI |
| `PHASE2_REPORT.md` | Test Foundation | 96 tests across 9 files, 10 P0 paths |
| `PHASE3_REPORT.md` | Security Hardening | Rate limiting, validation, circuit breaker, telemetry |
| `PHASE4_REPORT.md` | Observability | 9-view Control Center dashboard |
| `PHASE5_REPORT.md` | Performance | 59% bundle reduction, O(1) trace lookup, GET cache |
| `PERF_BASELINE.md` | Performance baseline | Pre-optimization measurements |
| `SETUP_REPORT.md` | DX (Phase 6) | Onboarding verification, time-to-first-run |
| `RELEASE_GUIDE.md` | Release (Phase 6) | Release checklist, rollback, upgrade notes |
| `PHASE6_REPORT.md` | DX (Phase 6) | This phase summary |
| `CODEBASE_HEALTH.md` | Audit | Codebase health snapshot |
| `TEST_MATRIX.md` | Tests | Test coverage matrix |

---

## License

Private. See `LICENSE` if present.
