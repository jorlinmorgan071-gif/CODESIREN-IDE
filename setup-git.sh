#!/usr/bin/env bash
# /home/z/my-project/setup-git.sh
#
# Bootstrap script to restore git credentials after a sandbox reset.
#
# PROBLEM: The sandbox reset overwrites /home/z/.gitconfig with the base
# image's version (no [credential] section) and deletes /home/z/.git-credentials
# (not in the base image). This means git push/pull stops working after every
# reset.
#
# SOLUTION: This script reads the GitHub token from /home/z/my-project/.github-token
# (which IS persistent — same device 44 as .env and worklog.md, not touched by
# the base image) and restores both files.
#
# USAGE: After a sandbox reset, run:
#   bash /home/z/my-project/setup-git.sh
#
# Then re-clone the repo:
#   cd /home/z/my-project/extracted
#   git clone https://github.com/jorlinmorgan071-gif/CODESIREN-IDE.git code_siren
#
# The clone will work without a token in the URL because the credential helper
# provides auth transparently.

set -euo pipefail

TOKEN_FILE="/home/z/my-project/.github-token"
GITCRED_FILE="/home/z/.git-credentials"
GITCONFIG_FILE="/home/z/.gitconfig"

# ── 1. Read token from persistent storage ──────────────────────────────
if [ ! -f "$TOKEN_FILE" ]; then
  echo "ERROR: Token file not found at $TOKEN_FILE"
  echo "The token was not persisted. Provide it again and re-run setup."
  exit 1
fi

TOKEN=$(cat "$TOKEN_FILE")
if [ -z "$TOKEN" ]; then
  echo "ERROR: Token file is empty"
  exit 1
fi

echo "✓ Token read from $TOKEN_FILE"

# ── 2. Write .git-credentials ──────────────────────────────────────────
echo "https://jorlinmorgan071-gif:${TOKEN}@github.com" > "$GITCRED_FILE"
chmod 600 "$GITCRED_FILE"
echo "✓ Written: $GITCRED_FILE (permissions 600)"

# ── 3. Set credential.helper=store in .gitconfig ──────────────────────
# The base image's .gitconfig overwrites ours on every reset, so we need
# to re-add the [credential] section each time.
git config --global credential.helper store
echo "✓ Set credential.helper=store in $GITCONFIG_FILE"

# ── 4. Verify ──────────────────────────────────────────────────────────
echo ""
echo "Verifying credential helper..."
if printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | grep -q "username=jorlinmorgan071-gif"; then
  echo "✓ Credential helper working — git will authenticate transparently"
else
  echo "✗ Credential helper NOT working — check token validity"
  exit 1
fi

echo ""
echo "=== Git credentials restored ==="
echo "You can now clone/push/pull without a token in the URL:"
echo "  git clone https://github.com/jorlinmorgan071-gif/CODESIREN-IDE.git"
echo ""
echo "Persistent files (survive resets):"
echo "  /home/z/my-project/.github-token  (the token itself)"
echo "  /home/z/my-project/setup-git.sh   (this script)"
echo ""
echo "After a reset, run: bash /home/z/my-project/setup-git.sh"
