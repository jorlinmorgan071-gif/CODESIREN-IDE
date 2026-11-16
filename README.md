# Code Siren IDE

> AI-powered development environment with real terminal, live AI thinking panel, flexible layout, multi-provider model routing, and VRM avatar system.

**License:** private  
**Status:** production-ready  
**Node.js:** >= 22 (pinned via `.nvmrc`)

---

## Features

### Chat Interface
- **Live Thought Process panel** — see the AI's reasoning, tool calls, and command execution in real-time before responses appear
- **Chat modes** — Ask (casual Q&A), Debug (analyze + fix), Build (full agent with tools), Investigate (web search + research)
- **Web search toggle** — real Wikipedia API search, injects results as context with URL citations
- **Auto-save + auto-name** — chats persist to localStorage, auto-named from first message (like ChatGPT)
- **`/` command autocomplete** — type `/` to filter all installed skills, click to insert
- **Raised bubble shadows + smooth typing animation** — no glitches during streaming

### Layout
- **Three-way flexible layout** — full-chat (default), split (chat + view side-by-side), full-view (editor/terminal)
- **Drag-to-split** — drag from chat edges to split, view picker appears
- **Dock navigation** — Chat, Editor, Terminal, Agents, Model Router, Brain, Face, Dashboard, Settings

### Model Router
- **15 LLM providers** — OpenRouter, Anthropic, OpenAI, Gemini, Groq, DeepSeek, Moonshot (Kimi), Qwen, Zhipu (GLM), Mistral, StepFun, BytePlus, MiniMax, Xiaomi (MiMo), LM Studio, Kilo Code
- **Test & load** — paste API key, click Test, real model list loads from the provider's `/v1/models` endpoint
- **3 routing modes** — One Provider (all agents → same model), Mixed Provider (per-agent), Auto Free (auto-route to free models by task type)
- **Companion Provider** — when Auto Free has shortfalls, pick a second provider to fill the gap
- **Context limit recovery** — when an agent exceeds its context window, a panel appears with two fixes: switch globally or manually pick a provider+model for the stuck agent

### Terminal
- **Real PTY terminal** — node-pty + xterm.js, not a stub
- **Security gate** — all commands validated via `validateShellCommand()` before execution (blocks `rm -rf`, shell metacharacters, etc.)
- **User-scoped sessions** — 30-min timeout, cleanup on disconnect

### Skills
- **81 skills total** — 35 built-in TOML skills (Wikipedia, NewsAPI, GitHub, etc.) + 36 imported from GitHub repos (paperclip, ECC, logo-design, leanrea, social-media-skills)
- **Skill importer** — fetches SKILL.md from GitHub repos, converts to TOML, auto-installs at boot
- **`/` autocomplete** — type `/` in chat to filter and insert skill commands

### Agents
- **20 agents** — Architect, Backend, CodeReview, Database, Deployment, DevOps, Documentation, Extension, Fabrication, Frontend, Memory, Operative, Performance, PromptEngineer, QA, Research, Security, Sentinel, Terminal, UIDesigner
- **Ghost Mode** — 3 real scanners (performance anti-patterns, secrets, dependency vulnerabilities), 9-state FSM, 4 autonomy levels, JSONL finding ledger
- **Image/Video generation** — 5 providers (OpenAI DALL-E, Gemini Imagen, MiniMax, WaveSpeed, BytePlus Seedream), per-session approval toggle

### TTS (Text-to-Speech)
- **11 TTS providers** — Kokoro (local), ElevenLabs, OpenAI, Doubao/Volcano, MiniMax, Cartesia, Fish Audio, Speechify, Gemini, Mistral Voxtral + generic OpenAI-compatible engine
- **3 ASR providers** — Whisper (local), Zai (cloud), Stub (testing)

### Security
- JWT auth with httpOnly cookies (XSS-safe)
- Admin role middleware + email verification flow
- Account deletion (GDPR right to erasure)
- Security headers: CSP, X-Frame-Options, HSTS, X-Content-Type-Options
- Row-Level Security migration (PostgreSQL)
- Parameterized SQL queries (no injection)
- File upload validation (type + size limits)
- Rate limiting on all endpoints
- Gitleaks CI job with baseline mode (catches committed-then-deleted secrets)
- Production JWT secret guard (refuses to start with dev defaults)

### Compliance
- Privacy policy, Terms of service, Refund policy, Cookie policy
- Cookie consent banner
- Data deletion request endpoint

---

## Quick Start

### Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | **>= 22.x** (22 LTS recommended) | Server + app runtime. Pinned via `.nvmrc`. |
| npm | >= 10.x | Package manager |

### 1. Clone & install

```bash
git clone <repo-url> code-siren
cd code-siren

# Use the correct Node version (>= 22, pinned via .nvmrc)
nvm use        # reads .nvmrc → Node 22

# Reproducible install from the committed lockfiles (recommended)
npm run ci:all          # runs `npm ci` in both server/ and app/

# …or a plain install (updates the lockfile if deps changed)
npm run install:all     # runs `npm install` in both server/ and app/
```

This is a monorepo with **no shared root dependencies** — the root
`package.json` only holds convenience scripts that delegate to `server/`
and `app/`. Installs happen inside each subproject. The root scripts are:

| Script | What it does |
|---|---|
| `npm run ci:all` | `npm ci` in `server/` then `app/` (reproducible from lockfile) |
| `npm run install:all` | `npm install` in `server/` then `app/` |
| `npm run typecheck` | `tsc --noEmit` in both `server/` and `app/` |
| `npm run test` | server vitest + app vitest (server uses the 5 CI exclusions below) |
| `npm run build` | `tsc -p` in `server/` then `tsc -b && vite build` in `app/` |
| `npm run verify:server` | server typecheck + grep-audit + tests |
| `npm run verify:app` | app typecheck + eslint + tests + build |

You can also run each subproject directly:

```bash
cd server && cp .env.example .env && npm ci      # server deps
cd ../app && npm ci                               # app deps
```

### 2. Configure

Edit `server/.env` — the only required value is `JWT_SECRET` (must be >= 32 chars).

```bash
openssl rand -hex 32
# Paste into server/.env as JWT_SECRET=...
```

Add API keys for any LLM providers you want to use:
```bash
OPENROUTER_API_KEY=...
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
# etc. — see server/.env.example for all options
```

### 3. Run

```bash
# Start the server (dev mode — hot reload via tsx watch)
cd server
npm run dev

# In another terminal, start the app (Vite dev server)
cd app
npm run dev
```

Open http://localhost:5173

### 4. Test & build

```bash
# From the repo root — runs both server and app test suites
npm run test

# Or per subproject:
cd server && npm test          # vitest run (1118 tests across 94 files)
cd app && npm test             # vitest run (136 tests across 19 files)

# Production build (server tsc + app vite build)
npm run build

# Pre-flight verification the CI pipeline runs
npm run verify:server         # typecheck + grep-audit + tests
npm run verify:app            # typecheck + eslint + tests + build
```

The server suite excludes 5 files that require external services
(`run-tests`, `ghost-remediation`, `playwright-client`, `workflow-runner`,
`upr-phase1-step2b-abortsignal-cap`) — these run in dedicated CI jobs or
locally with the backing services started. The exclusion list is encoded
in the root `npm run test` and `test:server` scripts and in `.github/workflows/ci.yml`.

### 5. Model Router

Open the Model Router (Dock → Model Router button) to:
- Paste API keys for providers
- Click "Test & load" to verify connections + load model lists
- Choose a routing mode (One Provider / Mixed / Auto Free)

---

## Architecture

```
code-siren/
├── server/                 # Express 5 + WebSocket server
│   ├── src/
│   │   ├── agents/        # 20 AI agents
│   │   ├── auth/           # JWT auth + httpOnly cookies
│   │   ├── context/        # Token-budget-aware context manager
│   │   ├── orchestration/  # Model router, strategies, agent manager
│   │   ├── provider-registry/  # API Hub: 39+ providers across 5 categories
│   │   ├── skills/         # Skills Vault (81 skills)
│   │   ├── systems/voice/  # TTS (11 providers) + ASR
│   │   ├── terminal/       # Real PTY terminal manager
│   │   └── security/       # Sandbox, egress policy, secret patterns
│   └── tests/              # 94 test files, 1118 tests (1082 run in CI; 5 files excluded — need external services)
├── app/                    # React + Vite + TypeScript
│   ├── src/
│   │   ├── components/     # Chat, editor, terminal, dock, sidebar
│   │   ├── pages/          # Home, ModelRouter, Dashboard, Brain, Face
│   │   ├── store/          # AppContext (state management)
│   │   └── lib/            # API client, auth, chat persistence, performance
│   └── public/legal/       # Privacy policy, ToS, refund, cookie policy
└── .github/workflows/      # CI: server, app, lockfile-hygiene, gitleaks, audit
```

---

## CI

All 6 CI jobs must pass on every push to `main`/`master` and on every pull request:

| Job | What it checks |
|---|---|
| Server | `npm ci` + typecheck + 1082 tests (5 service-dependent files excluded) + grep-audit + boot smoke test (health + login validation) |
| App | `npm ci` + typecheck + eslint `--max-warnings 0` + vitest (136 tests) + `vite build` |
| Lockfile hygiene | No mirror registries (npmmirror) in any lockfile |
| Gitleaks | Full git history scan with baseline (catches new secrets in any commit, even committed-then-deleted) |
| Security Audit | server: 0 vulnerabilities, app: 0 high (`--omit=dev`) |
| Repo hygiene | No tracked file > 2 MB outside the VRM allowlist; no root `skills/` folder; no `.polarfs-test` marker |

The exclusion list for the server test job lives in `.github/workflows/ci.yml`
and in the root `package.json` `test` / `test:server` scripts — keep them in
sync when adding a service-dependent test file.

---

## API Hub Categories

| Category | Providers | Description |
|---|---|---|
| Model API | 15 LLM providers | Chat/completion (OpenRouter, Anthropic, OpenAI, DeepSeek, etc.) |
| Voice API | 11 TTS providers | Text-to-speech (Kokoro, ElevenLabs, OpenAI, Cartesia, etc.) |
| Tool API | 5 tool providers | MCP/tool execution (code interpreter, calculator, http_request, image_gen, ai-prompt) |
| Image/Video API | 5 providers | Image + video generation (DALL-E, Imagen, MiniMax, WaveSpeed, BytePlus) |
| Information API | 5 providers | Read-only data (NewsAPI, OpenWeather, AlphaVantage) |

---

## License

Private. All rights reserved.
