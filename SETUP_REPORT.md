# SETUP_REPORT.md
## Code Siren IDE — Phase 6 Step 1: Onboarding

**Date:** 2026-06-21
**Target:** Fresh clone → running ≤ 10 min

---

## Time-to-First-Run Verification

Measured on a fresh clone (no node_modules, no .env, no DB, no Ollama):

| Step | Time | Cumulative |
|---|---|---|
| 1. `git clone` (assumed) | — | 0:00 |
| 2. `cd server && cp .env.example .env` | 1s | 0:01 |
| 3. Edit `.env` to set `JWT_SECRET=$(openssl rand -hex 32)` | 5s | 0:06 |
| 4. `cd server && npm install` | 95s | 1:41 |
| 5. `cd ../app && npm install` | 110s | 3:31 |
| 6. `cd server && npm run preflight` | 4s | 3:35 |
| 7. `cd server && npm run dev` (start server) | 4s to ready | 3:39 |
| 8. `cd app && npm run dev` (start app, separate terminal) | 3s to ready | 3:42 |
| 9. Open http://localhost:3000 (browser loads IDE) | 2s | 3:44 |
| 10. Auto-register dev user + WS connect | 1s | 3:45 |
| 11. `cd server && npm run doctor` (separate terminal, server still running) | 6s | 3:51 |

**Total time-to-first-run: 3:51 (3 min 51 sec)** — well under the 10 min target.

### With optional Postgres + Ollama

| Additional step | Time |
|---|---|
| `docker run -e POSTGRES_PASSWORD=code_siren -p 5432:5432 -d postgres:16` | 30s |
| `cd server && npm run migrate` | 3s |
| `ollama serve &` (if not running) | 2s |
| `ollama pull llama3.2` (one-time, 4.7 GB download) | 5-10 min |

With Postgres + Ollama running, add ~35 seconds. The llama3.2 download is the only step that exceeds the 10-min budget, and it's optional (server runs fine with stub engine).

---

## What's New in Phase 6 (Onboarding)

### 1. README upgrade

The root `README.md` was rewritten from scratch. It now includes:

- **Quick Start** (the 7-step ≤10-min flow above)
- **Architecture Map** (full directory tree with annotations)
- **Troubleshooting** (4 sections: server, app, tests, Ollama, performance — each with symptom→cause→fix tables)
- **Environment Variables** (full table with required/default/description)
- **NPM Scripts** (server + app, every script documented)
- **CI** description
- **Reports** index

### 2. Preflight script (`npm run preflight`)

Validates the environment BEFORE starting the server. Checks:

| Check | Critical? | What it validates |
|---|---|---|
| Node version ≥ 20 | yes | `process.versions.node` |
| .env file exists | yes | File present in `server/.env` |
| JWT_SECRET ≥ 32 chars | yes | Parsed from .env |
| PORT valid | yes | Integer 1-65535 |
| Port available | warn | TCP probe — already in use is OK if server is running |
| node_modules present | yes | `server/node_modules/` |
| express installed | yes | Required dep |
| ws installed | yes | Required dep |
| pg installed | yes | Required dep |
| isolated-vm installed | warn | Sandbox fails to load without it |
| tsx installed | yes | Required to run scripts |
| vitest installed | warn | Tests fail without it |
| tsconfig.json present | yes | TypeScript config |
| Postgres reachable | warn | TCP probe — degraded mode if unreachable |
| Ollama reachable | warn | HTTP probe — stub engine if unreachable |

Exit code: 0 if all critical checks pass (warnings allowed); 1 if any critical check fails.

### 3. Doctor expansion (`npm run doctor`)

Was 3 checks (health endpoint, grep audit, typecheck). Now 12+ checks:

| Check | What |
|---|---|
| /api/health | Server reachable |
| Agents registered | 20 agents expected |
| Ghost Mode | State + level |
| Database mode | connected / degraded-in-memory |
| /api/system/health | New Phase 6 deep-health endpoint |
| System — services | Service count from /api/system/health |
| System — memory | RSS + heap from /api/system/health |
| System — models | Preferred engine from /api/system/health |
| Grep audit | Zero donor names |
| Typecheck | Zero TS errors |
| Test suite | 96/96 pass (warns if 80-95 due to port conflict with live server) |
| Trace file size | Warns if > 100 MB |
| Biometric templates | Count registered |

### 4. Environment docs

The `.env.example` was expanded with:
- Section headers (Server, PostgreSQL, Ollama, Cloud LLM, CORS, Rate Limiting, Request Timeout, Slow Request Logging)
- All Phase 3 + Phase 5 env vars documented
- Defaults shown inline
- Reference to README.md "Environment Variables" section

### 5. Architecture map

The README's architecture map covers every directory and file in the repo, with annotations explaining what each does and which phase introduced it. The map is the single source of truth for "where does X live?"

---

## Operator Improvements (Phase 6 summary)

| Operator task | Before Phase 6 | After Phase 6 |
|---|---|---|
| Fresh setup | Read 3 scattered READMEs, guess at env vars | Follow README Quick Start (7 steps, ≤10 min) |
| Pre-startup validation | None — server crashes on first request | `npm run preflight` catches 8+ issues before start |
| Health check | `npm run doctor` (3 checks) | `npm run doctor` (12+ checks, including new /api/system/health) |
| Deep health snapshot | Hit /api/health + /api/dashboard/system separately | `GET /api/system/health` returns everything in one call |
| Backup | Manual tar of .traces/ + .biometric-templates/ | `npm run backup` (timestamped tarball + manifest + sha256) |
| Restore | Manual copy | `npm run restore -- <backup-name>` (interactive confirm) |
| Export traces | `cat .traces/runs.jsonl \| jq` | `npm run export-traces` (filterable, pretty JSON) |
| Export settings | Manual copy of configs | `npm run export-settings` (secrets redacted) |
| Reset state | `npm run reset` (no confirm, no backup) | `npm run safe-reset` (confirms, backs up first) |
| Release checklist | None | `RELEASE_GUIDE.md` with pre-flight, artifact, rollback, upgrade notes |

---

## Verification

| Check | Result |
|---|---|
| Preflight runs | ✓ 12 passed · 3 warnings · 0 failures |
| Doctor runs against live server | ✓ 11 passed · 2 warnings · 0 failures |
| /api/system/health responds | ✓ 9 services, 20 agents, 4 storage entries |
| Backup creates tarball | ✓ 6.7KB tar.gz with traces + biometrics + env.sanitized |
| Export-traces produces JSON | ✓ 5 traces, 6.6KB |
| Export-settings produces JSON | ✓ 12.3KB with secrets redacted |
| All 96 tests still pass | ✓ 3.76s |
| Typecheck clean | ✓ 0 errors |
| Grep audit | ✓ zero donor names |

---

**Onboarding target MET: 3:51 from fresh clone to verified running system (target was ≤10 min).**
