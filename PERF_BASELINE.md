# PERF_BASELINE.md
## Code Siren IDE — Phase 5 Performance Baseline

**Date:** 2026-06-21
**Measurement environment:** Linux, Node 24, no PostgreSQL (degraded in-memory mode), no Ollama available (stub engine).

---

## Methodology

Each metric was measured with `/home/z/my-project/scripts/perf-measure.ts` running a fresh server instance per metric to avoid cross-test contamination. The script:

- Spawns the server via `tsx src/index.ts` with `NODE_ENV=production`
- Polls `GET /api/health` until 200 OK before measuring
- Uses native `fetch` (Node 24+) and native `WebSocket`
- Runs each metric in isolation, kills the server, and waits for the port to be released before the next metric

**Caveat:** measurements include `tsx` JIT warmup overhead. A real production deployment would use `npm run build` + `node dist/index.js` and would be ~30-40% faster on cold boot. The relative improvements from Phase 5 optimizations should still hold.

---

## Baseline Metrics

| Metric | Baseline Value | Notes |
|---|---|---|
| **Cold boot** | **1,332 ms** | Time from `tsx src/index.ts` to `/api/health` returns 200 |
| **Warm boot** | not measured reliably | Server graceful shutdown takes >10s due to sidecar cleanup, db close, ghost-mode stop — measurement infrastructure couldn't isolate the warm-boot component. Acceptable: cold boot is the meaningful number. |
| **Agent latency** (POST send → first WS chunk) | **19 ms** | Architect agent, single-shot mode, stub engine |
| **Trace lookup** (`GET /api/traces/:taskId`) | **2.2 ms avg** | 5 samples: 3, 3, 2, 1, 2 ms |
| **Dashboard load** (10 endpoints sequential) | **35 ms total** | Per-endpoint: 1-5 ms each (system=4ms, models=5ms, traces-file/info=12ms, others 2-3ms) |
| **Build duration** (`npm run build` app) | **9,419 ms** | Vite production build |
| **Bundle JS** | **587.5 KB** (601,597 bytes) | Single chunk, gzip ~165 KB |
| **Bundle CSS** | **84.7 KB** (86,720 bytes) | Tailwind + custom |
| **Bundle total** | **672.2 KB** | JS + CSS combined |
| **Server RSS** | **103.43 MB** | Resident set size at steady state |
| **Server heap used** | **25.13 MB** | Used JS heap |
| **Server heap total** | **36.54 MB** | Allocated JS heap |
| **Server external** | **6.27 MB** | C++ objects (Buffer, etc.) |

---

## Per-Endpoint Dashboard Breakdown

| Endpoint | Time (ms) |
|---|---|
| `/api/dashboard/system` | 4 |
| `/api/dashboard/agents` | 2 |
| `/api/dashboard/execution` | 2 |
| `/api/dashboard/memory` | 2 |
| `/api/dashboard/security` | 2 |
| `/api/dashboard/models` | 5 |
| `/api/dashboard/tools` | 2 |
| `/api/dashboard/traces` | 2 |
| `/api/dashboard/traces-file/info` | 12 |
| `/api/dashboard/performance` | 3 |
| **Total** | **35** |

**Observations:**
- Most endpoints respond in 2-3 ms (just JSON serialization over a local socket)
- `/api/dashboard/system` is 4 ms — calls `process.memoryUsage()`, lists 20 agents
- `/api/dashboard/models` is 5 ms — calls `checkOllamaAvailable()` which does a fetch with timeout
- `/api/dashboard/traces-file/info` is 12 ms — runs `execSync('wc -l < file')` on the JSONL file

---

## Targets for Phase 5

| Metric | Baseline | Target | Improvement Needed |
|---|---|---|---|
| Bundle JS | 587.5 KB | < 350 KB | ≥ 40% reduction (target from Step 2: 503 KB → <350 KB — actual baseline is higher than user's 503 KB estimate, so target is even more aggressive) |
| Cold boot | 1,332 ms | < 1,200 ms | ≥ 10% reduction |
| Agent latency | 19 ms | < 17 ms | ≥ 10% reduction (likely already at floor — stub engine) |
| Trace lookup | 2.2 ms | < 2.0 ms | ≥ 10% reduction (likely already at floor) |
| Dashboard load | 35 ms | < 32 ms | ≥ 10% reduction (target the 12ms traces-file/info endpoint) |
| Build duration | 9,419 ms | < 8,500 ms | ≥ 10% reduction |
| Server RSS | 103.43 MB | < 95 MB | ≥ 10% reduction (likely difficult — most is Node + tsx runtime) |

---

## What's Already Fast (No Optimization Needed)

- Trace lookup: 2.2 ms — sub-3ms already
- Dashboard endpoints: 2-5 ms each — already at network round-trip floor
- Agent latency: 19 ms — bounded by the LLM call (stub engine returns immediately; real LLM would be 100-2000 ms)

## What's Worth Optimizing

- **Bundle JS (587 KB → target <350 KB)**: biggest user-visible win. Achievable via route splitting (lazy-load Dashboard) and vendor chunk splitting.
- **Build duration (9.4s → target <8.5s)**: achievable via Vite config tuning (disable sourcemaps in production, manual chunks).
- **Cold boot (1.3s → target <1.2s)**: marginal — most time is tsx JIT + module loading. Could lazy-import Ollama engine check on first dashboard call.
- **`/api/dashboard/traces-file/info` (12 ms)**: replace `execSync('wc -l')` with a streaming line count or cached counter. Could go to <1 ms.
- **`/api/dashboard/models` (5 ms)**: cache `checkOllamaAvailable()` result for 30s.

---

## Raw JSON Snapshots

Saved to `/home/z/my-project/scripts/`:
- `perf-baseline-cold-boot.json`
- `perf-baseline-agent-latency.json`
- `perf-baseline-memory.json`
- `perf-baseline-trace.json`
- `perf-baseline-dashboard.json`
- `perf-baseline-bundle.json`

---

**Baseline locked in. Proceeding to Step 2 (Frontend) and Step 3 (Backend) optimizations.**
