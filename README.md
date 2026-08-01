# Code Siren IDE

> AI-powered development environment. Single Express + WS server, single JWT auth, single ModelRouter, single AgentManager.send() — every input modality (typed chat, voice, gesture) routes through the same agent bus.

**Current version:** Phase E — Multi-Provider Voice Pipeline
**License:** private
**Status:** production-ready (build green, 618/618 tests pass across 36 files, 35 Skills Vault manifests, 3 swappable TTS providers, no donor-project names in code)

---

## What's New (Phases A–E, post-Phase-6)

| Phase | What it added | Evidence |
|---|---|---|
| **Phase A** — Monaco IDE Intelligence | TypeScript IntelliSense, diagnostics, hover docs, multi-file sync, AI completions, format-on-demand | `app/src/components/editor/CodeEditor.tsx` rewrite |
| **Phase B** — Context Manager | Token-budget-aware context bundles (selection, open files, history, memory, project graph) | `server/src/context/{types,budget,manager,project-graph}.ts` |
| **Phase C** — 10 Hardened Agents | CodeReview, Security, Database, Backend, DevOps, Performance, Documentation, Research, UIDesigner, PromptEngineer — each with Tier-1 regex checks + LLM review + tested capabilities | `server/src/agents/*/index.ts`, 24+ tests in `tests/security/` |
| **Phase D** — Skills Vault (35 skills) | `http_request` tool + 35 TOML skill manifests across 8 batches (Wikipedia, NewsAPI, GitHub, TMDb, MapTiler, Alpha Vantage, NASA, YouTube, etc.) | `server/src/skills/library/*.toml`, `server/src/agents/_shared/tool-registry.ts` |
| **Phase E** — Voice Pipeline | 3 swappable TTS providers (Zai cloud, Kokoro local neural, ElevenLabs BYOK cloud) + voice settings + Voice tab in Settings UI | `server/src/systems/voice/`, `server/src/orchestrator/voice-settings.ts`, `app/src/components/modals/SettingsModal.tsx` |

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
│   │   ├── types.ts                 AgentTask, AgentChunk, AgentDomain, ExecutionMode, VoiceSettings
│   │   │
│   │   ├── agents/                  20 IAgent implementations
│   │   │   ├── base-agent.ts        abstract IAgent (PDF Section 05)
│   │   │   ├── _shared/
│   │   │   │   ├── tool-registry.ts calculator, code_interpreter, think, http_request (Phase D)
│   │   │   │   ├── review-parse.ts  Shared fenced-JSON + parseReviewResponse (Phase C)
│   │   │   │   ├── migration-validate.ts  validateMigrationSql 5 hard-block rules (Phase C)
│   │   │   │   └── project-files.ts Code Review gate (writeProjectFile)
│   │   │   ├── architect/           Planning agent (Step 0 — first real IAgent)
│   │   │   ├── qa-tester/           Test generation
│   │   │   ├── extension/           Skills Vault manager (Phase D)
│   │   │   ├── frontend/            UI codegen
│   │   │   ├── backend/             API codegen (Phase C — hardened)
│   │   │   ├── database/            Schema design (Phase C — hardened, migration validation)
│   │   │   ├── security/            Threat modeling (Phase C — hardened)
│   │   │   ├── devops/              CI/CD (Phase C — hardened)
│   │   │   ├── documentation/       Docs (Phase C — hardened)
│   │   │   ├── performance/         Profiling (Phase C — hardened)
│   │   │   ├── terminal/            Shell exec (Ghost Mode approval)
│   │   │   ├── memory/              Recall surface
│   │   │   ├── ui-designer/         Design tokens (Phase C — hardened)
│   │   │   ├── research/            Deep research (Phase C — hardened, real z-ai SDK web_search)
│   │   │   ├── deployment/          Deploy pipelines
│   │   │   ├── prompt-engineer/     Prompt tuning (Phase C — hardened)
│   │   │   ├── code-review/         Review gate (Phase C — 9 Tier-1 regex checks + 3-tier parse)
│   │   │   ├── fabrication/         CAD + 3D printer (build123d sidecar)
│   │   │   ├── operative/           Browser + smart home (kasa sidecar)
│   │   │   └── sentinel/            Ambient monitoring (Ghost Mode)
│   │   │
│   │   ├── context/                 Phase B — Context Manager
│   │   │   ├── types.ts             ContextBundle shape (5 sources)
│   │   │   ├── budget.ts            Token-budget allocation across sources
│   │   │   ├── manager.ts           Assembles context bundles (fail-open on timeout)
│   │   │   └── project-graph.ts     Project structure graph for context
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
│   │   ├── orchestrator/            Phase E — Voice + LLM orchestrator settings
│   │   │   ├── settings.ts          Orchestrator engine/approvalMode/tier1Model (JSON file)
│   │   │   ├── voice-settings.ts    Voice provider/voice settings (JSON file, runtime-built availability)
│   │   │   ├── engine.ts            Active engine selection + availability checks
│   │   │   ├── relay-loop.ts        Gemini/Nemotron relay orchestration
│   │   │   └── tier1-chat.ts        OpenRouter Tier-1 chat routing
│   │   │
│   │   ├── auth/                    Single JWT auth (register/login/me)
│   │   │   ├── jwt.ts
│   │   │   ├── routes.ts
│   │   │   ├── middleware.ts        requireAuth
│   │   │   └── face-factor.ts       Second factor (biometric template file)
│   │   │
│   │   ├── db/
│   │   │   ├── client.ts            pg Pool + degraded in-memory fallback
│   │   │   ├── migrate.ts           Runs migrations in order (SHA-256 checksum verify)
│   │   │   └── migrations/          10 SQL files (001-010, incl. 003_skills_vault, 010_migration_tracking)
│   │   │
│   │   ├── ws/
│   │   │   ├── server.ts            Single WS server (PDF Section 13) + binary voice audio routing
│   │   │   └── events.ts            Typed event registry + broadcast sink
│   │   │
│   │   ├── routes/                  18 route files
│   │   │   ├── agents.ts            POST /api/agents/:id/send
│   │   │   ├── health.ts            GET /api/health
│   │   │   ├── system-health.ts     GET /api/system/health (Phase 6)
│   │   │   ├── traces.ts            GET /api/traces
│   │   │   ├── dashboard.ts         11 read-only aggregation endpoints
│   │   │   ├── models.ts            Ollama model listing + selection
│   │   │   ├── skills.ts            Skills Vault API (Phase D)
│   │   │   ├── fabrication.ts       CAD + printer
│   │   │   ├── operative.ts         Browser + devices
│   │   │   ├── sentinel.ts          Sentinel + Ghost Mode
│   │   │   ├── sandbox.ts           isolated-vm sandbox
│   │   │   ├── voice.ts             Voice sessions + GET/POST /api/voice/settings (Phase E Build 2/3)
│   │   │   ├── voice-live.ts        Live voice pipeline (Phase E)
│   │   │   ├── orchestrator.ts      GET/POST /api/orchestrator/settings
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
│   │   │   └── manager.ts           Spawns+owns Python sidecars (crash → SidecarCrashedError)
│   │   │                            + ensureBuild123dSidecar() + ensureKokoroSidecar() (Phase E)
│   │   │
│   │   ├── skills/                  Phase D — Skills Vault
│   │   │   ├── manifest.ts          TOML parser + Ed25519 signature verify
│   │   │   ├── executor.ts          Runs skill steps via toolRegistry
│   │   │   ├── discovery.ts         Mines traces for recurring sequences
│   │   │   └── library/             35 TOML skill manifests (Batches 1-8)
│   │   │       ├── *.toml           Wikipedia, Open-Meteo, NewsAPI, GNews, GitHub,
│   │   │       │                    TMDb, OMDb, GIPHY, RAWG, PUBG, MapTiler, ORS,
│   │   │       │                    OpenWeatherMap, Alpha Vantage (x2), ExchangeRate-API,
│   │   │       │                    NASA APOD, YouTube Data API v3, + 18 more
│   │   │       └── index.ts         Auto-loader (reads all .toml at boot)
│   │   │
│   │   └── systems/
│   │       └── voice/               Phase E — Multi-Provider Voice Pipeline
│   │           ├── tts-provider.ts      TTSProvider interface + ZaiTTSProvider + StubTTSProvider + DI
│   │           ├── kokoro-provider.ts   KokoroTTSProvider (local neural, Python sidecar)
│   │           ├── elevenlabs-provider.ts  ElevenLabsTTSProvider (BYOK cloud, raw fetch)
│   │           ├── audio-wav.ts         Shared wrapPcmInWav() + pcmDurationMs() utils
│   │           ├── voice-client.ts      VoiceClient interface (Stub + future Gemini Live)
│   │           └── voice-proxy.ts       Live voice pipeline: ASR → AgentManager → TTS
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
│   ├── sidecars/                    Python helpers (JSON-lines stdin/stdout protocol)
│   │   ├── build123d/sidecar.py     CAD generation
│   │   ├── kasa/sidecar.py          Smart home control
│   │   └── kokoro/                  Phase E — Kokoro TTS sidecar
│   │       ├── sidecar.py           Lazy model load, /ping + /tts + /crash
│   │       ├── requirements.txt     kokoro==0.9.4, torch CPU, transformers, misaki
│   │       └── venv/                (gitignored — 1.4 GB, NOT committed)
│   │
│   ├── tests/                       618 tests across 36 files
│   │   ├── unit/                    traces, memory, ghost-mode, sandbox, loop-guard,
│   │   │                            context/{budget,manager,project-graph},
│   │   │                            skills (Batches 1-8), skills-http-request
│   │   ├── integration/             auth
│   │   ├── agent/                   agent-manager
│   │   ├── security/                12 agent test files (Phase C) + project-files gate
│   │   ├── e2e/                     extension-agent-pipeline (Phase D)
│   │   └── e2e-architect.ts         End-to-end proof (Step 0)
│   │
│   └── .env.example                 25+ env slots incl. 20+ API keys (Phase D) + ELEVENLABS_API_KEY (Phase E)
│
├── app/                             React 19 + Vite 7 + Tailwind 3 frontend
│   ├── src/
│   │   ├── App.tsx                  Routes: / + /dashboard (lazy)
│   │   ├── pages/
│   │   │   ├── Home.tsx             IDE shell (TitleBar, IconSidebar, FileExplorer, CodeEditor, ChatPanel, Terminal, modals — all lazy)
│   │   │   └── Dashboard.tsx        Control Center (9 views, lazy-loaded)
│   │   ├── components/
│   │   │   ├── layout/              TitleBar, IconSidebar, FileExplorer, StatusBar
│   │   │   ├── editor/              CodeEditor (Monaco, lazy, Phase A IntelliSense)
│   │   │   ├── chat/                ChatPanel (lazy)
│   │   │   ├── terminal/            Terminal (xterm, lazy)
│   │   │   ├── panels/              InlineAI (lazy)
│   │   │   ├── modals/              AgentPanel, SettingsModal (6 tabs incl. Voice — Phase E)
│   │   │   ├── dashboard/           9 read-only views (Phase 4)
│   │   │   └── ui/                  shadcn/ui primitives
│   │   ├── store/                   AppContext, themes, demoData
│   │   ├── lib/                     api (incl. getVoiceSettings/setVoiceSettings — Phase E), ws, auth, dashboardApi, utils
│   │   ├── systems/presence/        gesture input
│   │   └── types/                   Mirror of server types (incl. VoiceSettings, VoiceProviderOption, KokoroVoiceOption, ElevenLabsVoiceOption)
│   └── vite.config.ts               manualChunks: react-vendor, radix-vendor, monaco-vendor, etc.
│
├── scripts/
│   └── grep-audit.sh                Naturalization audit (zero donor names)
│
├── .github/workflows/ci.yml         Server + app CI (Node 22 for isolated-vm)
├── README.md                        This file
├── SETUP_REPORT.md                  Phase 6 onboarding report
├── RELEASE_GUIDE.md                 Phase 6 release runbook
└── PHASE{1-7}_REPORT.md             Phase reports (1-7)
```

### Key invariants (DO NOT MODIFY — enforced across all phases)

- **One Express server, one WS server, one port** (PDF Section 12+13)
- **One JWT auth flow** — face auth is a second factor on the same token, not a parallel path
- **One `AgentManager.send(task)`** — typed chat, voice, gesture all route here
- **One ModelRouter** — Ollama → OpenRouter → stub fallback, with `embed()` for memory
- **One Ghost Mode FSM** — 9 states, 4 autonomy levels, shared by Sentinel + Terminal
- **One MemoryEngine** — pgvector or in-memory, shared by all 20 agents via base-agent
- **One Security Sandbox** — isolated-vm v6, 32MB/30s, no require/process/fs
- **One ToolRegistry** — calculator, code_interpreter, think, http_request (Phase D) — extensible via Skills Vault
- **One traces system** — JSONL append-only + 1000-entry ring buffer
- **One TTSProvider interface** (Phase E) — ZaiTTSProvider, KokoroTTSProvider, ElevenLabsTTSProvider all implement it; `setTTSProvider()` swaps the active one at runtime
- **One SidecarManager** (Phase E) — owns all Python sidecars (build123d, kasa, kokoro); crashes surface as `SidecarCrashedError`, no silent fallback
- **One Skills Vault** (Phase D) — 35 TOML manifests, auto-loaded at boot, executed via `toolRegistry` with honest missing-key + fabrication guards
- **API keys live ONLY in `.env`** — never in JSON settings files, never in DB tables, never in skill manifests, never logged. The `http_request` tool's `api_key_env` field reads `process.env[KEY_NAME]` at runtime; if empty → honest "Skill unavailable" error without making the network call

---

## Voice Pipeline (Phase E)

Three swappable TTS providers, all implementing the same `TTSProvider` interface (`speak(text: string): Promise<TTSResult>`). Users switch between them via **Settings → Voice tab** in the UI, or via `POST /api/voice/settings`. The active provider is swapped at runtime via `setTTSProvider()` — no server restart needed. The saved setting persists to `server/.runtime/voice-settings.json` and is applied at boot via `applyVoiceProvider(getVoiceSettings())`.

| Provider | Type | Setup | Latency | Voices | Cost |
|---|---|---|---|---|---|
| **Zai** (default) | Cloud | None (uses z-ai SDK built-in creds) | ~1-2s | 1 (tongtong) | Free (z-ai) |
| **Kokoro-82M** | Local neural | Python sidecar (~1.4 GB venv, 312 MB model) | ~2s first call, ~1.4s subsequent (2-core CPU) | 54 across 9 languages | Free (Apache 2.0) |
| **ElevenLabs** | Cloud BYOK | `ELEVENLABS_API_KEY` in `.env` | ~1s (cloud) | 21 premade English | 10k credits/month free |

**Provider selection is dynamic:** `getVoiceProviders()` checks `process.env.ELEVENLABS_API_KEY` at runtime — if not set, ElevenLabs shows as `available: false` with the reason "API key not configured — add ELEVENLABS_API_KEY to server/.env and restart the server." The UI picker shows it as disabled with the reason as a tooltip.

**Failure handling:** every provider throws honest, specific errors — no silent fallback to Stub or another provider:
- Missing key → `"ElevenLabs: ELEVENLABS_API_KEY not configured — add it to server/.env..."`
- Invalid key → `"ElevenLabs: invalid API key — check ELEVENLABS_API_KEY in server/.env."`
- Quota exceeded → `"ElevenLabs: monthly quota exceeded — upgrade your plan at https://elevenlabs.io/pricing..."`
- Invalid voice → `"ElevenLabs: invalid voice_id — ..."`
- Sidecar crash (Kokoro) → `SidecarCrashedError` propagates, no hang, no stub audio
- Empty text → `"TTS: empty text"` (provider-side pre-check, before any network/sidecar call)

**Kokoro sidecar lifecycle:** spawned lazily on first `speak()` call (not at server boot). Model loads lazily inside the sidecar on first `/tts` request. Per Section 0.2 decision, the sidecar is left running on switch-away (no teardown) — the ~1.3 GB RAM stays allocated in case the user switches back. The sidecar is owned by `SidecarManager` and dies with the Node server (no orphan processes).

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

### Core (server + auth + DB + LLM)

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
| `GEMINI_API_KEY` | no | — | Gemini 2.5 Flash orchestrator (Phase 11) |
| `CORS_ORIGINS` | no | http://localhost:3000,... | Comma-separated allowed origins |
| `RATE_LIMIT_PER_IP` | no | 100 | Requests per minute per IP |
| `RATE_LIMIT_PER_USER` | no | 200 | Requests per minute per user |
| `RATE_LIMIT_WS_PER_SEC` | no | 10 | WS messages per second per connection |
| `RATE_LIMIT_WINDOW_MS` | no | 60000 | Rate limit window in ms |
| `REQUEST_TIMEOUT_MS` | no | 30000 | Request timeout in ms |
| `SLOW_REQUEST_THRESHOLD_MS` | no | 500 | Threshold for slow request logging |

### Phase D — Skills Vault API keys (all optional, leave empty to skip the skill)

All keys live in `server/.env` and are read at runtime via `process.env[KEY_NAME]`. When a key is not set, the corresponding skill returns an honest "Skill unavailable: missing KEY_NAME" error without making the network call. See `server/.env.example` for the full commented list.

| Variable | Service | Free tier |
|---|---|---|
| `NEWSAPI_KEY` | NewsAPI | 100 req/day |
| `GNEWS_KEY` | GNews | 100 req/day |
| `MEDIASTACK_KEY` | Mediastack | 500 req/month |
| `GITHUB_TOKEN` | GitHub (skill) | 5000 req/hour |
| `DEVTO_API_KEY` | Dev.to | unlimited (read) |
| `HASHNODE_API_KEY` | Hashnode | GraphQL, rate-limited |
| `TMDB_API_KEY` | TMDb | unlimited (read) |
| `OMDB_API_KEY` | OMDb | 1000 req/day |
| `GIPHY_API_KEY` | GIPHY | 42 req/hour |
| `RAWG_API_KEY` | RAWG | 20000 req/month |
| `PUBG_API_KEY` | PUBG API | rate-limited |
| `MAPTILER_API_KEY` | MapTiler | 100k req/month |
| `OPENROUTESERVICE_KEY` | OpenRouteService | 2000 req/day |
| `OPENWEATHERMAP_KEY` | OpenWeatherMap | 60 req/min |
| `ALPHA_VANTAGE_KEY` | Alpha Vantage | 25 req/day |
| `YOUTUBE_API_KEY` | YouTube Data API v3 | 10000 units/day |
| `NASA_API_KEY` | NASA APOD | DEMO_KEY (shared, 30 req/hr) — slot is documentation-only |

### Phase E — Voice TTS provider keys

| Variable | Service | Free tier | Notes |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs (BYOK cloud TTS) | 10000 credits/month (~1 char = 1 credit) | When not set, ElevenLabs shows as "unavailable" in the Voice tab. Get a key at https://elevenlabs.io → Profile → API Keys. |

**Kokoro** (local neural TTS) needs no API key — it runs entirely locally via a Python sidecar. First-time setup: `cd server/sidecars/kokoro && python3 -m venv venv && source venv/bin/activate && pip install --index-url https://download.pytorch.org/whl/cpu torch && pip install -r requirements.txt` (~1.4 GB venv, 312 MB model downloads on first use). The venv is gitignored — never committed.

**Zai** (cloud TTS via z-ai-web-dev-sdk) needs no API key — it uses the z-ai SDK's built-in credentials (configured at the system level via `/etc/.z-ai-config`).

---

## NPM Scripts

### Server (`cd server`)

| Script | What it does |
|---|---|
| `npm run dev` | Start server in watch mode (tsx watch) |
| `npm start` | Start server without watch |
| `npm run build` | TypeScript compile to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run vitest (618 tests across 36 files, ~2min) |
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
