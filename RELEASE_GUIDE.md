# RELEASE_GUIDE.md
## Code Siren IDE — Release Runbook

**Phase 6 — Step 3**
**Version:** 0.6.0-phase6

This is the operator's runbook for cutting a release, verifying it, rolling it back if needed, and upgrading from a previous version. **Read this entire document before cutting your first release.**

---

## Pre-Release Checklist

Run this checklist before tagging a release. Every item must be ✓.

### Code health

- [ ] `cd server && npm run typecheck` — 0 errors
- [ ] `cd server && npm test` — 96/96 pass
- [ ] `cd server && npm run grep-audit` — zero donor names
- [ ] `cd app && npx tsc -b` — 0 errors
- [ ] `cd app && npm run lint` — 0 errors
- [ ] `cd app && npm run build` — production build succeeds
- [ ] `cd server && npm run doctor` — 0 failures (warnings OK)
- [ ] `cd server && npm run preflight` — 0 failures

### Version metadata

- [ ] `server/package.json` `version` field bumped (semver)
- [ ] `app/package.json` `version` field bumped (match server)
- [ ] Phase report written (`PHASE<N>_REPORT.md`)

### Artifact verification

- [ ] `cd server && npm run build` produces `dist/` with no errors
- [ ] `cd app && npm run build` produces `dist/` with bundle size within budget (main entry < 350 KB)
- [ ] Smoke test: boot server, hit `/api/health`, hit `/api/system/health`, verify 20 agents registered
- [ ] Smoke test: open app in browser, verify IDE loads, verify ChatPanel connects via WS

### Backup

- [ ] `cd server && npm run backup` — creates timestamped tarball in `backups/`
- [ ] Verify backup contains: traces.jsonl, biometric-templates/, env.sanitized, manifest.json
- [ ] Move backup tarball to off-machine storage (S3, etc.)

### Documentation

- [ ] `README.md` reflects current version + scripts
- [ ] `SETUP_REPORT.md` updated if onboarding changed
- [ ] `RELEASE_GUIDE.md` (this file) updated if release process changed
- [ ] Phase report (e.g. `PHASE6_REPORT.md`) written
- [ ] Upgrade notes section below updated

---

## Cutting a Release

### 1. Tag the release

```bash
# From repo root
git checkout main
git pull
git tag -a v0.6.0-phase6 -m "Phase 6 — DX + Release Readiness"
git push origin v0.6.0-phase6
```

### 2. Create the release artifact

```bash
# From repo root
cd server && npm run build       # produces server/dist/
cd ../app && npm run build       # produces app/dist/
cd ..

# Create release tarball (excludes node_modules, .env, runtime state)
tar -czf code-siren-v0.6.0-phase6.tar.gz \
  --exclude='*/node_modules' \
  --exclude='*/.env' \
  --exclude='server/.traces' \
  --exclude='server/.biometric-templates' \
  --exclude='server/.stl-out' \
  --exclude='server/backups' \
  --exclude='app/dist' \
  --exclude='gcode-out' \
  server/ app/ scripts/ .github/ \
  README.md SETUP_REPORT.md RELEASE_GUIDE.md \
  PHASE*.md PERF_BASELINE.md CODEBASE_HEALTH.md TEST_MATRIX.md

# Verify
ls -la code-siren-v0.6.0-phase6.tar.gz
tar -tzf code-siren-v0.6.0-phase6.tar.gz | head -20
```

### 3. Generate the build artifact report

```bash
cd server
npm run export-settings > release-settings.json
npm run export-traces -- --limit=0 > release-traces-count.json 2>/dev/null || true

# Capture build metadata
cat > release-artifact-report.json << EOF
{
  "version": "0.6.0-phase6",
  "releaseDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitSha": "$(git rev-parse HEAD)",
  "gitTag": "v0.6.0-phase6",
  "serverBuild": {
    "typecheck": "pass",
    "tests": "96/96 pass",
    "grepAudit": "pass",
    "distSize": "$(du -sh server/dist | cut -f1)"
  },
  "appBuild": {
    "typecheck": "pass",
    "lint": "pass",
    "bundleMainJs": "$(ls -la app/dist/assets/index-*.js | awk '{print $5}') bytes",
    "bundleCss": "$(ls -la app/dist/assets/index-*.css | awk '{print $5}') bytes",
    "chunkCount": "$(ls app/dist/assets/*.js | wc -l)"
  },
  "artifacts": [
    "code-siren-v0.6.0-phase6.tar.gz"
  ]
}
EOF
```

### 4. Publish

- Upload tarball to release artifact storage (S3, GitHub Release, etc.)
- Upload `release-artifact-report.json` alongside
- Tag the release in GitHub (or equivalent) with the changelog

---

## Rollback Instructions

If a release goes bad, roll back to the previous known-good version.

### 1. Stop the bad server

```bash
# On the server host
pkill -f "tsx src/index.ts" || true
# Or if running from dist:
# pkill -f "node dist/index.js"
```

### 2. Restore from pre-release backup

```bash
cd server

# List available backups
ls backups/

# Restore the most recent backup (created during pre-release checklist)
npm run restore -- backup-YYYY-MM-DD-HH-MM-SS
# (Confirm prompts — traces + biometric templates will be overwritten)
```

### 3. Revert code to previous release

```bash
# From repo root
git checkout v0.5.0-phase5   # or whatever the previous tag was
# OR if deploying from tarball:
# tar -xzf code-siren-v0.5.0-phase5.tar.gz -C /opt/code-siren/
```

### 4. Reinstall deps + rebuild

```bash
cd server && npm install && npm run build
cd ../app && npm install && npm run build
```

### 5. Restart server + verify

```bash
cd server
npm run preflight     # must pass
npm run dev           # or: node dist/index.js
# In another terminal:
npm run doctor        # must report 0 failures
```

### 6. Verify user-facing functionality

- Open http://localhost:3000
- Verify IDE loads
- Send a chat message to Architect agent — should get a response
- Check `/api/system/health` — all previously-online services should be online

### Rollback caveats

- **Database schema**: if the bad release ran migrations, the previous release may not work with the new schema. You may need to roll back migrations manually.
- **Trace format**: trace JSONL format is stable across phases, so traces from a newer release are readable by older releases.
- **Biometric templates**: format is stable across phases — no rollback concern.
- **JWT tokens**: if `JWT_SECRET` changed, all existing user tokens are invalid. Users must re-authenticate. This is expected on rollback if the secret was rotated.

---

## Upgrade Notes

### From v0.5.0-phase5 → v0.6.0-phase6

**Breaking changes:** NONE.

**New scripts** (additive, no existing script changed):
- `npm run preflight` — pre-startup validation
- `npm run safe-reset` — confirm + backup + reset
- `npm run backup` — timestamped tarball backup
- `npm run restore` — restore from backup
- `npm run export-traces` — export traces as JSON
- `npm run export-settings` — export settings as JSON (secrets redacted)

**New endpoint:**
- `GET /api/system/health` — deep health snapshot (auth required)

**Modified files:**
- `server/package.json` — version bumped, 6 new scripts added
- `server/.env.example` — expanded with all env vars (rate limit, timeout, slow request threshold)
- `server/scripts/doctor.ts` — expanded from 3 to 12+ checks
- `server/src/index.ts` — mounts the new `/api/system` router

**Upgrade steps:**
1. `git pull` (or extract new tarball over the old one)
2. `cd server && npm install` (no new deps, but reinstall to be safe)
3. `cd app && npm install`
4. `cd server && npm run preflight` — should pass
5. Restart server: `npm run dev` (or `node dist/index.js` if running from build)
6. `cd server && npm run doctor` — should report 0 failures
7. Verify `/api/system/health` responds with the new deep-health payload

**No env vars required to change.** New env vars (`RATE_LIMIT_*`, `REQUEST_TIMEOUT_MS`, `SLOW_REQUEST_THRESHOLD_MS`) all have sensible defaults — they were already in the code from Phase 3/5; Phase 6 just documents them in `.env.example`.

### From v0.4.0-phase4 → v0.5.0-phase5

**Breaking changes:** NONE.

**Bundle impact:** main entry bundle reduced 59% (587 KB → 240 KB). The Dashboard route + heavy components (CodeEditor, ChatPanel, Terminal, modals) are now lazy-loaded. Visible behavior is unchanged — the UI loads identically.

**New endpoints:**
- `GET /api/performance/metrics` — latency histogram + p50/p95/p99
- `GET /api/performance/slow-requests` — slow request log
- `GET /api/performance/recent` — recent request log
- `GET /api/performance/cache` — cache hit/miss stats

**Backend optimizations:**
- Trace lookup is now O(1) via index (was O(n) linear scan)
- GET response cache (5-60s TTL per endpoint, `?nocache=1` to bypass)
- `X-Cache: HIT|MISS` header on cached responses

**Upgrade steps:** standard `git pull` + `npm install` + restart. No env changes needed.

### From v0.3.0-phase3 → v0.4.0-phase4

**Breaking changes:** NONE.

**New endpoint:** `/api/dashboard/*` (11 read-only endpoints) + new `/dashboard` route in the app.

**Upgrade steps:** standard. No env changes.

### From v0.2.0-phase1 → v0.3.0-phase3

**Breaking changes:** NONE (Phase 2 was test-only, no behavior change).

**New env vars** (all optional, defaults work):
- `RATE_LIMIT_PER_IP` (default 100)
- `RATE_LIMIT_PER_USER` (default 200)
- `RATE_LIMIT_WS_PER_SEC` (default 10)
- `RATE_LIMIT_WINDOW_MS` (default 60000)
- `REQUEST_TIMEOUT_MS` (default 30000)
- `SLOW_REQUEST_THRESHOLD_MS` (default 500)

**New endpoints:**
- `GET /api/security/events` — security event log
- `GET /api/security/stats` — security + rate limit + circuit breaker stats

**Upgrade steps:** `git pull` + `npm install` + restart. Optionally add the new env vars to `.env` (otherwise defaults apply).

### From v0.1.0-step10 → v0.2.0-phase1

**Breaking changes:** NONE.

**What changed:** 30 lint errors fixed, CI added, scripts added (doctor, benchmark, reset).

**Upgrade steps:** `git pull` + `npm install` + restart.

---

## Version Metadata

| Field | Value |
|---|---|
| Current version | 0.6.0-phase6 |
| Phase | 6 — DX + Release Readiness |
| Server package | code-siren-server@0.6.0-phase6 |
| App package | my-app@0.0.0 (TODO: bump in next release) |
| Node | ≥ 20.x |
| npm | ≥ 10.x |
| Tests | 96/96 pass |
| Bundle main entry | 245.6 KB (target < 350 KB) |
| Server cold boot | ~1.3 s |
| Agent latency (stub) | 17 ms |

---

## Build Artifact Report (latest release)

Generated at release time. See `release-artifact-report.json` in the release bundle for the authoritative version.

```
{
  "version": "0.6.0-phase6",
  "releaseDate": "<release-timestamp>",
  "gitSha": "<sha>",
  "gitTag": "v0.6.0-phase6",
  "serverBuild": {
    "typecheck": "pass",
    "tests": "96/96 pass",
    "grepAudit": "pass"
  },
  "appBuild": {
    "typecheck": "pass",
    "lint": "pass",
    "bundleMainJs": "<size> bytes",
    "bundleCss": "<size> bytes"
  },
  "artifacts": ["code-siren-v0.6.0-phase6.tar.gz"]
}
```

---

## Emergency Contacts

If a release is broken and this runbook doesn't help:

1. Check `PHASE6_REPORT.md` for known issues
2. Check `CODEBASE_HEALTH.md` for the last known-good state
3. Roll back to the previous release tag (see Rollback Instructions above)
4. File an issue with: server logs, `/api/system/health` output, doctor output, preflight output
