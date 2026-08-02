#!/usr/bin/env bash
# scripts/restore-git-credentials.sh
#
# Restores git credentials after a sandbox reset.
#
# PROBLEM: The sandbox reset overwrites /home/z/.gitconfig with the base
# image's version (no [credential] section) and deletes /home/z/.git-credentials
# (not in the base image). This means git push/pull stops working after every
# reset.
#
# SOLUTION: This script reads GITHUB_PAT from server/.env (which IS durable —
# it's on device 44, the persistent overlay layer, same as all our other .env
# values that have survived every reset this session). It then:
#   1. Writes /home/z/.git-credentials with the token
#   2. Sets credential.helper=store in /home/z/.gitconfig
#   3. Re-adds the origin remote if missing
#
# USAGE: After a sandbox reset + re-clone:
#   cd code_siren
#   bash scripts/restore-git-credentials.sh
#
# Then git push/pull/fetch work without any manual token entry.

set -euo pipefail

# ── 1. Find server/.env (try multiple locations) ───────────────────────
ENV_FILE=""
for candidate in \
  "server/.env" \
  "extracted/code_siren/server/.env" \
  "/home/z/my-project/extracted/code_siren/server/.env"; do
  if [ -f "$candidate" ]; then
    ENV_FILE="$candidate"
    break
  fi
done

if [ -z "$ENV_FILE" ]; then
  echo "ERROR: server/.env not found. Make sure you're in the repo root."
  echo "  Tried: server/.env, extracted/code_siren/server/.env"
  exit 1
fi

echo "Found .env: $ENV_FILE"

# ── 2. Read GITHUB_PAT from .env ───────────────────────────────────────
# Use grep + cut to avoid sourcing the whole .env (which might have special chars)
TOKEN=$(grep "^GITHUB_PAT=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '[:space:]')

if [ -z "$TOKEN" ]; then
  echo "ERROR: GITHUB_PAT not found in $ENV_FILE"
  echo "  Add GITHUB_PAT=your_token_here to server/.env"
  exit 1
fi

echo "✓ GITHUB_PAT read from $ENV_FILE (length: ${#TOKEN})"

# ── 3. Write .git-credentials ──────────────────────────────────────────
GITCRED_FILE="/home/z/.git-credentials"
echo "https://jorlinmorgan071-gif:${TOKEN}@github.com" > "$GITCRED_FILE"
chmod 600 "$GITCRED_FILE"
echo "✓ Written: $GITCRED_FILE (permissions 600)"

# ── 4. Set credential.helper=store in .gitconfig ──────────────────────
# The base image's .gitconfig overwrites ours on every reset, so we need
# to re-add the [credential] section each time.
git config --global credential.helper store
echo "✓ Set credential.helper=store in /home/z/.gitconfig"

# ── 5. Re-add origin remote if missing ────────────────────────────────
REPO_URL="https://github.com/jorlinmorgan071-gif/CODESIREN-IDE.git"

if ! git remote get-url origin &>/dev/null; then
  git remote add origin "$REPO_URL"
  echo "✓ Added origin remote: $REPO_URL"
else
  CURRENT_URL=$(git remote get-url origin)
  if [ "$CURRENT_URL" != "$REPO_URL" ]; then
    git remote set-url origin "$REPO_URL"
    echo "✓ Updated origin remote: $REPO_URL (was: $CURRENT_URL)"
  else
    echo "✓ Origin remote already correct: $REPO_URL"
  fi
fi

# ── 6. Verify ──────────────────────────────────────────────────────────
echo ""
echo "Verifying credential helper..."
if printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | grep -q "username=jorlinmorgan071-gif"; then
  echo "✓ Credential helper working — git will authenticate transparently"
else
  echo "✗ Credential helper NOT working — check token validity"
  exit 1
fi

echo ""
echo "Verifying git fetch..."
if git fetch origin --dry-run 2>/dev/null; then
  echo "✓ git fetch works"
else
  echo "✗ git fetch failed — check network or token permissions"
  exit 1
fi

echo ""
echo "=== Git credentials restored ==="
echo "git push/pull/fetch now work without manual token entry."
