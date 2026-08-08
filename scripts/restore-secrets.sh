#!/usr/bin/env bash
# scripts/restore-secrets.sh
#
# Credential Durability v3 — uses PolarFS (/tmp/my-project) as the canonical
# durable secrets store.
#
# PROBLEM: server/.env and ~/.git-credentials live on the ephemeral overlay
# rootfs and are wiped on every sandbox reset. PolarFS (/tmp/my-project) is
# the only genuinely persistent layer.
#
# SOLUTION: This script restores secrets from PolarFS to the working
# directories at the start of each session:
#   1. GITHUB_PAT: from /tmp/my-project/.github-token → ~/.git-credentials + server/.env
#   2. JWT_SECRET: from .env.example (dev default, always safe)
#   3. Any other secrets stored in /tmp/my-project/.env.secrets → server/.env
#
# USAGE: After a sandbox reset + re-clone:
#   cd /home/z/my-project
#   bash scripts/restore-secrets.sh
#
# GOING FORWARD: When adding/rotating a real secret, write it to
# /tmp/my-project/.env.secrets (NOT just server/.env), so it survives resets.

set -euo pipefail

POLARFS="/tmp/my-project"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$PROJECT_ROOT/server"
SECRETS_FILE="$POLARFS/.env.secrets"

echo "═══════════════════════════════════════════════════════════════"
echo "Credential Durability v3 — Restoring secrets from PolarFS"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── 1. Restore server/.env from .env.example (always works) ──────────────
if [ ! -f "$SERVER_DIR/.env" ]; then
  echo "[1/3] server/.env missing — restoring from .env.example"
  cp "$SERVER_DIR/.env.example" "$SERVER_DIR/.env"
  echo "  ✓ server/.env restored (dev defaults)"
else
  echo "[1/3] server/.env already exists — skipping base restore"
fi

# ── 2. Restore GITHUB_PAT → ~/.git-credentials + server/.env ─────────────
GITHUB_PAT=""

# Check PolarFS .github-token first
if [ -f "$POLARFS/.github-token" ]; then
  GITHUB_PAT=$(cat "$POLARFS/.github-token" | tr -d '[:space:]')
  echo "[2/3] GITHUB_PAT found in PolarFS (.github-token)"
fi

# Also check .env.secrets
if [ -z "$GITHUB_PAT" ] && [ -f "$SECRETS_FILE" ]; then
  GITHUB_PAT=$(grep "^GITHUB_PAT=" "$SECRETS_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '[:space:]' || true)
  if [ -n "$GITHUB_PAT" ]; then
    echo "[2/3] GITHUB_PAT found in PolarFS (.env.secrets)"
  fi
fi

if [ -n "$GITHUB_PAT" ]; then
  # Write to ~/.git-credentials for git push/pull
  echo "https://jorlinmorgan071-gif:${GITHUB_PAT}@github.com" > ~/.git-credentials
  chmod 600 ~/.git-credentials
  git config --global credential.helper store
  echo "  ✓ ~/.git-credentials configured"

  # Also write to server/.env for consistency (some scripts read it from there)
  if grep -q "^GITHUB_PAT=" "$SERVER_DIR/.env" 2>/dev/null; then
    sed -i "s|^GITHUB_PAT=.*|GITHUB_PAT=${GITHUB_PAT}|" "$SERVER_DIR/.env"
  else
    echo "GITHUB_PAT=${GITHUB_PAT}" >> "$SERVER_DIR/.env"
  fi
  echo "  ✓ server/.env GITHUB_PAT updated"
else
  echo "[2/3] GITHUB_PAT not found in PolarFS — git push will require manual token"
  echo "  To persist: echo 'YOUR_TOKEN' > $POLARFS/.github-token"
fi

# ── 3. Restore any additional secrets from .env.secrets ──────────────────
if [ -f "$SECRETS_FILE" ]; then
  echo "[3/3] Additional secrets found in $SECRETS_FILE"
  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    # Skip GITHUB_PAT (already handled above)
    [[ "$key" == "GITHUB_PAT" ]] && continue

    if grep -q "^${key}=" "$SERVER_DIR/.env" 2>/dev/null; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$SERVER_DIR/.env"
      echo "  ✓ $key updated in server/.env"
    else
      echo "${key}=${value}" >> "$SERVER_DIR/.env"
      echo "  ✓ $key added to server/.env"
    fi
  done < "$SECRETS_FILE"
else
  echo "[3/3] No .env.secrets file in PolarFS — using .env.example defaults"
  echo "  To persist additional secrets (ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, etc.):"
  echo "    echo 'ELEVENLABS_API_KEY=your_key' > $SECRETS_FILE"
  echo "    echo 'ANTHROPIC_API_KEY=your_key' >> $SECRETS_FILE"
  echo "  Then re-run this script."
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Secrets restore complete."
echo ""
echo "Verified state:"
echo "  server/.env exists: $([ -f "$SERVER_DIR/.env" ] && echo 'YES' || echo 'NO')"
echo "  ~/.git-credentials exists: $([ -f ~/.git-credentials ] && echo 'YES' || echo 'NO')"
echo "  JWT_SECRET present: $(grep -q '^JWT_SECRET=.\{32,\}' "$SERVER_DIR/.env" 2>/dev/null && echo 'YES' || echo 'NO')"
echo "  GITHUB_PAT present: $([ -n "$GITHUB_PAT" ] && echo 'YES' || echo 'NO')"
echo "═══════════════════════════════════════════════════════════════"
