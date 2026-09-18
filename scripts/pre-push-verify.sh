#!/usr/bin/env bash
# scripts/pre-push-verify.sh
#
# Pre-push verification gate — runs lint + typecheck + tests for both
# the app and the server. Exits non-zero if anything fails, which
# makes `git push` (when wired up with a pre-push hook) refuse to push.
#
# Usage:
#   bash scripts/pre-push-verify.sh
#   bash scripts/pre-push-verify.sh --no-tests   # skip tests, just lint + tsc
#
# Exit codes:
#   0 = all green, safe to push
#   1 = one or more checks failed — DO NOT push

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/app"
SERVER_DIR="$ROOT_DIR/server"
RUN_TESTS=1

if [[ "${1:-}" == "--no-tests" ]]; then
  RUN_TESTS=0
fi

# Color helpers (only if stdout is a tty)
if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'
  RED=$'\033[0;31m'
  YELLOW=$'\033[0;33m'
  RESET=$'\033[0m'
else
  GREEN=""
  RED=""
  YELLOW=""
  RESET=""
fi

log_pass() { echo "${GREEN}✓ PASS${RESET}  $1"; }
log_fail() { echo "${RED}✗ FAIL${RESET}  $1"; }
log_info() { echo "${YELLOW}▶ RUN ${RESET}  $1"; }

FAILURES=0

run_check() {
  local label="$1"
  local cmd="$2"
  log_info "$label"
  if eval "$cmd" > /tmp/verify-output.log 2>&1; then
    log_pass "$label"
  else
    log_fail "$label"
    echo "----- last 40 lines of output -----"
    tail -40 /tmp/verify-output.log
    echo "-----------------------------------"
    FAILURES=$((FAILURES + 1))
  fi
}

# ── App checks ────────────────────────────────────────────────────────
if [[ -d "$APP_DIR" ]]; then
  echo ""
  echo "=== App (Vite + React) ==="
  run_check "app: lint"         "cd '$APP_DIR' && npx eslint ."
  run_check "app: typecheck"   "cd '$APP_DIR' && npx tsc --noEmit -p tsconfig.app.json"
  if [[ "$RUN_TESTS" -eq 1 ]]; then
    run_check "app: tests"       "cd '$APP_DIR' && npx vitest run"
  fi
fi

# ── Server checks ─────────────────────────────────────────────────────
if [[ -d "$SERVER_DIR" ]]; then
  echo ""
  echo "=== Server (Express + TS) ==="
  run_check "server: typecheck" "cd '$SERVER_DIR' && npx tsc -p tsconfig.json --noEmit"
  if [[ "$RUN_TESTS" -eq 1 ]]; then
    run_check "server: tests"     "cd '$SERVER_DIR' && npx vitest run"
  fi
fi

echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "${GREEN}═══════════════════════════════════════════════════════════════${RESET}"
  echo "${GREEN}  ALL CHECKS GREEN — safe to push${RESET}"
  echo "${GREEN}═══════════════════════════════════════════════════════════════${RESET}"
  exit 0
else
  echo "${RED}═══════════════════════════════════════════════════════════════${RESET}"
  echo "${RED}  $FAILURES CHECK(S) FAILED — push blocked${RESET}"
  echo "${RED}  Fix the errors above before pushing.${RESET}"
  echo "${RED}═══════════════════════════════════════════════════════════════${RESET}"
  exit 1
fi
