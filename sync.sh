#!/usr/bin/env bash
# =====================================================================
#  Code Siren — sync-to-github.sh
#  One-command workflow: extract latest tarball -> sync to git repo
#  -> commit -> push to GitHub.
#
#  SETUP (one-time):
#    1. Extract the tarball ONCE: tar -xzf code-siren-6bugfix-AF.tar.gz
#    2. cd into the extracted folder
#    3. Initialize git:
#         git init
#         git branch -M main
#         git remote add origin git@github.com:YOUR-USERNAME/code-siren.git
#    4. Set your identity:
#         git config user.name "Your Name"
#         git config user.email "your_email@example.com"
#
#  USAGE (every time you get a new tarball):
#    1. Download the new tarball into this folder
#    2. Run: ./sync.sh
#    3. It extracts, stages, commits with an auto-message, and pushes.
# =====================================================================
set -euo pipefail

# Find the latest tarball in this folder
TARBALL=$(ls -t *.tar.gz 2>/dev/null | head -1)
if [ -z "$TARBALL" ]; then
  echo "[sync] ERROR: No .tar.gz file found in the current folder."
  exit 1
fi
echo "[sync] Latest tarball: $TARBALL"

# Extract (overwrites existing files)
echo "[sync] Extracting..."
tar -xzf "$TARBALL" --overwrite

# Check git is initialized
if [ ! -d .git ]; then
  echo "[sync] ERROR: .git folder not found. Run the SETUP steps in the header of this file first."
  exit 1
fi

# Stage all changes
echo "[sync] Staging changes..."
git add .

# Check if there's anything to commit
if git diff --cached --quiet --exit-code; then
  echo "[sync] No changes to commit — already up to date."
  exit 0
fi

# Commit with timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
COMMIT_MSG="Update from tarball $TARBALL ($TIMESTAMP)"
echo "[sync] Committing: $COMMIT_MSG"
git commit -m "$COMMIT_MSG"

# Push
echo "[sync] Pushing to origin..."
if ! git push origin main; then
  echo "[sync] WARNING: Push failed. Check your SSH key, remote URL, and network."
  echo "[sync] The commit is still local — fix the issue and run 'git push' manually."
  exit 1
fi

echo ""
echo "[sync] SUCCESS — changes pushed to GitHub."
echo "[sync] Commit: $COMMIT_MSG"
