# Code Siren Server — Step 0 Skeleton

Single Express + WS server, single JWT auth flow, single Model Router, single `AgentManager.send()`. No donor-project names anywhere in code, files, env vars, or UI strings. Step 0 of the Naturalized Merge Directive.

## What's in here (Step 0 only)

- **Express + WS on one port** (`src/index.ts`, `src/ws/server.ts`) — `http://localhost:3001/api/*` and `ws://localhost:3001/ws?token=JWT&projectId=UUID`. No second server.
- **PostgreSQL migrations 001 + 002** (`src/db/migrations/`) — the 14 tables from PDF Section 11. Falls back to in-memory mode if Postgres isn't available, so Step 0 proof works without a DB.
- **JWT auth** (`src/auth/`) — `/api/auth/register`, `/api/auth/login`, `/api/auth/me`, plus `requireAuth` middleware. One auth system.
- **AgentManager** (`src/orchestration/agent-manager.ts`) — typed message bus. `send(task)` is the single entry point for any agent invocation, whether the task originated from a typed chat message, a spoken command, or (later) a gesture. PDF Section 14 contract.
- **Ghost Mode FSM** (`src/orchestration/ghost-mode.ts`) — 9-state machine (`inactive → scanning → detected → planning → awaiting_approval → applying → verifying → complete/rolled_back`) + 4 autonomy levels. PDF Section 16. The Sentinel Agent (Step 9) will reuse this exact shape.
- **IAgent abstract class** (`src/agents/base-agent.ts`) — PDF Section 05 interface: `init / execute / review / pause / resume / recall / memorize / emit / on`. Every absorbed agent (Fabrication, Operative, Sentinel) will implement this — no exceptions.
- **Model Router** (`src/orchestration/model-router.ts`) — single router. Step 0 ships a stub engine that streams synthetic output, so end-to-end plumbing can be proven without LLM API keys. The `offline → Ollama` branch (per directive) is a stub for now; the donor project's local-runtime techniques get ported in later steps.
- **Architect Agent** (`src/agents/architect/index.ts`) — the FIRST real `IAgent` implementation. Converted from a static `demoData.ts` row into a live agent routed through `AgentManager.send()`, observable in the UI.

## What is NOT in here (gated for later steps)

- Fabrication, Operative, Sentinel agents (Steps 4–9)
- Voice, CAD, printer, browser, smart-home, gesture, face-auth (Steps 4–10)
- Skills Vault, executionMode strategies, Security Sandbox (Steps 2–3, 6)
- MCP / A2A transports

## Run

```bash
cd server
cp .env.example .env       # then edit if needed
npm install
npm run typecheck
npm run dev                # starts on http://localhost:3001
```

In a separate terminal:

```bash
cd server
npm run test:e2e           # proves Architect agent end-to-end (no browser needed)
```

## Naturalization grep-audit

```bash
cd server
npm run grep-audit
```

Expected: zero matches for the donor project names (case-insensitive, word-boundary) outside `CHANGELOG.md`/acknowledgments. The directive's Definition of Done #1.

## File layout

```
server/
  package.json
  tsconfig.json
  .env.example
  README.md
  src/
    index.ts                        Express + WS bootstrap
    config.ts                       env config (zod-validated)
    types.ts                        AgentTask, AgentChunk, AgentDomain, ExecutionMode, AgentEvent
    db/
      client.ts                     pg Pool (graceful in-memory fallback)
      migrate.ts                    runs migrations in order
      migrations/
        001_core.sql                users, projects, sessions, messages, agent_states, agent_tasks
        002_memory_intelligence.sql snapshots, knowledge_docs, agent_memory, deployments, code_dna, pattern_library, dependency_health
    auth/
      jwt.ts                        sign + verify
      routes.ts                     /api/auth/register, /login, /me
      middleware.ts                 requireAuth
    ws/
      server.ts                     single WS server on Express HTTP server
      events.ts                     typed event registry (agent:*, editor:*, ghost:*, terminal:*, preview:*, collab:*)
    orchestration/
      agent-manager.ts              AgentManager.send() — typed message bus
      ghost-mode.ts                 9-state FSM + 4 autonomy levels
      model-router.ts               single router; stub engine for Step 0
    agents/
      base-agent.ts                 abstract IAgent
      architect/
        index.ts                    ArchitectAgent — first real IAgent impl
    routes/
      agents.ts                     POST /api/agents/:agentId/send
      health.ts                     GET /api/health
  tests/
    e2e-architect.ts                end-to-end proof (Node, no browser)
```
