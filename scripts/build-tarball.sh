#!/usr/bin/env bash
# scripts/build-tarball.sh
#
# Builds a verified tarball of the Code Siren IDE working tree.
#
# USAGE:
#   bash scripts/build-tarball.sh <output-path> [commit-message-for-readme]
#
# WHAT THIS SCRIPT DOES:
#   1. Builds a tarball with proper anchored --exclude patterns (so
#      --exclude='./skills' only excludes the top-level skills/ directory,
#      NOT server/src/skills/ — the bug that caused manifest.ts to be
#      missing from previous tarballs).
#   2. After building, runs a VERIFICATION step that compares the tarball's
#      file list against `git ls-files` (minus intentional exclusions) and
#      reports any unexpected missing files.
#   3. Specifically counts files under server/src/ and app/src/ in both
#      the tarball and git, and confirms they match.
#   4. Exits non-zero if verification fails, so this can be used in CI.
#
# The verification step is the actual fix — the anchored exclude pattern
# prevents the original bug, but the verification catches any future
# exclude-pattern regressions or accidental file omissions.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUTPUT="${1:-download/codesiren-tarball.tar.gz}"
mkdir -p "$(dirname "$OUTPUT")"

echo "═══════════════════════════════════════════════════════════════"
echo "Building verified tarball → $OUTPUT"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Build tarball with anchored exclude patterns ────────────────────────
# CRITICAL: --exclude='./skills' is anchored to the tarball root, so it
# only excludes the top-level skills/ directory (the agent-runtime skill
# definitions). It does NOT match server/src/skills/ (the server-side
# Skills Vault module that contains manifest.ts, discovery.ts, executor.ts,
# and library/*.toml).
#
# The previous broken pattern was --exclude='skills' (no anchor), which
# matched ANY path component named 'skills' and silently excluded
# server/src/skills/ from every tarball.

tar -czf "$OUTPUT" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='.cache' \
  --exclude='venv' \
  --exclude='.venv' \
  --exclude='__pycache__' \
  --exclude='*.vrm' \
  --exclude='*.fbx' \
  --exclude='*.glb' \
  --exclude='*.gltf' \
  --exclude='*.bin' \
  --exclude='*.wasm' \
  --exclude='model-cache' \
  --exclude='.runtime' \
  --exclude='coverage' \
  --exclude='.tsbuildinfo' \
  --exclude='*.tsbuildinfo' \
  --exclude='./upload' \
  --exclude='./extracted' \
  --exclude='./skills' \
  --exclude='./tool-results' \
  --exclude='./download' \
  app/ server/ scripts/ .github/ \
  README.md SETUP_REPORT.md RELEASE_REPORT.md RELEASE_GUIDE.md \
  TEST_MATRIX.md PERF_BASELINE.md CODEBASE_HEALTH.md \
  PHASE1_REPORT.md PHASE2_REPORT.md PHASE3_REPORT.md PHASE4_REPORT.md \
  PHASE5_REPORT.md PHASE6_REPORT.md PHASE7_REPORT.md \
  setup-git.sh sync.sh sync.bat .gitignore \
  2>&1

echo "✓ Tarball built: $(ls -lh "$OUTPUT" | awk '{print $5}')"
echo ""

# ── VERIFICATION STEP ───────────────────────────────────────────────────
# Compare tarball contents against git ls-files (minus intentional
# exclusions). Any tracked file that's missing from the tarball is a bug.

echo "═══════════════════════════════════════════════════════════════"
echo "VERIFICATION: tarball contents vs git ls-files"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Get list of files in tarball (strip leading ./ if present, exclude
# directory entries — tar lists dirs with trailing /, git ls-files doesn't)
TARBALL_FILES=$(tar -tzf "$OUTPUT" | sed 's|^\./||' | grep -v '/$' | sort)

# Get list of tracked files from git, filtered to the paths we tarballed
GIT_FILES=$(git ls-files \
  app/ server/ scripts/ .github/ \
  README.md SETUP_REPORT.md RELEASE_REPORT.md RELEASE_GUIDE.md \
  TEST_MATRIX.md PERF_BASELINE.md CODEBASE_HEALTH.md \
  PHASE1_REPORT.md PHASE2_REPORT.md PHASE3_REPORT.md PHASE4_REPORT.md \
  PHASE5_REPORT.md PHASE6_REPORT.md PHASE7_REPORT.md \
  setup-git.sh sync.sh sync.bat .gitignore \
  | sort)

# Intentional exclusions — files tracked in git but deliberately NOT in
# the tarball (binary blobs, large assets, etc.). These are EXPECTED
# missing, not bugs.
INTENTIONAL_EXCLUSIONS_REGEX='\.vrm$|\.fbx$|\.glb$|\.gltf$|\.bin$|\.wasm$'

# Find files in git but NOT in tarball (unexpected missing)
UNEXPECTED_MISSING=$(comm -23 <(echo "$GIT_FILES") <(echo "$TARBALL_FILES") \
  | grep -vE "$INTENTIONAL_EXCLUSIONS_REGEX" \
  || true)

# Find files in tarball but NOT in git (unexpected extra — shouldn't happen)
UNEXPECTED_EXTRA=$(comm -13 <(echo "$GIT_FILES") <(echo "$TARBALL_FILES") \
  | grep -vE "$INTENTIONAL_EXCLUSIONS_REGEX" \
  || true)

# Count files under key paths in both
TARBALL_SERVER_SRC=$(echo "$TARBALL_FILES" | grep -c "^server/src/" || true)
GIT_SERVER_SRC=$(echo "$GIT_FILES" | grep -c "^server/src/" || true)
TARBALL_APP_SRC=$(echo "$TARBALL_FILES" | grep -c "^app/src/" || true)
GIT_APP_SRC=$(echo "$GIT_FILES" | grep -c "^app/src/" || true)
TARBALL_SKILLS=$(echo "$TARBALL_FILES" | grep -c "^server/src/skills/" || true)
GIT_SKILLS=$(echo "$GIT_FILES" | grep -c "^server/src/skills/" || true)

echo "File counts (tarball vs git):"
echo "  server/src/      tarball=$TARBALL_SERVER_SRC  git=$GIT_SERVER_SRC  $([ "$TARBALL_SERVER_SRC" = "$GIT_SERVER_SRC" ] && echo '✓ match' || echo '✗ MISMATCH')"
echo "  app/src/         tarball=$TARBALL_APP_SRC  git=$GIT_APP_SRC  $([ "$TARBALL_APP_SRC" = "$GIT_APP_SRC" ] && echo '✓ match' || echo '✗ MISMATCH')"
echo "  server/src/skills/  tarball=$TARBALL_SKILLS  git=$GIT_SKILLS  $([ "$TARBALL_SKILLS" = "$GIT_SKILLS" ] && echo '✓ match' || echo '✗ MISMATCH')"
echo ""

# Specifically check that manifest.ts is present (the file that was
# missing from previous broken tarballs)
if echo "$TARBALL_FILES" | grep -q "^server/src/skills/manifest.ts$"; then
  echo "✓ server/src/skills/manifest.ts IS in tarball (the original bug is fixed)"
else
  echo "✗ server/src/skills/manifest.ts is MISSING from tarball — BUG NOT FIXED"
fi
echo ""

# Report unexpected missing files
MISSING_COUNT=$(echo "$UNEXPECTED_MISSING" | grep -c . || true)
if [ "$MISSING_COUNT" -eq 0 ]; then
  echo "✓ 0 unexpected missing files (all git-tracked files are in tarball, modulo intentional exclusions)"
else
  echo "✗ $MISSING_COUNT unexpected missing files:"
  echo "$UNEXPECTED_MISSING" | head -20
  echo "  (showing first 20; run comm -23 <(git ls-files ...) <(tar -tzf $OUTPUT) for full list)"
fi
echo ""

# Report unexpected extra files
EXTRA_COUNT=$(echo "$UNEXPECTED_EXTRA" | grep -c . || true)
# Allowlist: files in tarball but not in git that are EXPECTED (local env,
# newly-created scripts not yet committed, etc.)
EXTRA_ALLOWLIST='^scripts/build-tarball\.sh$|^server/\.env$|^server/\.env\.example$'
UNEXPECTED_EXTRA_FILTERED=$(echo "$UNEXPECTED_EXTRA" | grep -vE "$EXTRA_ALLOWLIST" || true)
UNEXPECTED_EXTRA_FILTERED_COUNT=$(echo "$UNEXPECTED_EXTRA_FILTERED" | grep -c . || true)

if [ "$UNEXPECTED_EXTRA_FILTERED_COUNT" -eq 0 ]; then
  echo "✓ 0 unexpected extra files (tarball contains only git-tracked files + allowlisted local files)"
  if [ "$EXTRA_COUNT" -gt 0 ]; then
    echo "  (allowlisted extras: $(echo "$UNEXPECTED_EXTRA" | grep -E "$EXTRA_ALLOWLIST" | tr '\n' ' '))"
  fi
else
  echo "✗ $UNEXPECTED_EXTRA_FILTERED_COUNT unexpected files in tarball but not in git (review):"
  echo "$UNEXPECTED_EXTRA_FILTERED" | head -10
fi
echo ""

# Final verdict
if [ "$MISSING_COUNT" -eq 0 ] \
  && [ "$TARBALL_SERVER_SRC" = "$GIT_SERVER_SRC" ] \
  && [ "$TARBALL_APP_SRC" = "$GIT_APP_SRC" ] \
  && [ "$TARBALL_SKILLS" = "$GIT_SKILLS" ]; then
  echo "═══════════════════════════════════════════════════════════════"
  echo "✓ TARBALL VERIFIED — $OUTPUT"
  echo "  $TARBALL_SERVER_SRC server/src/ files match git ($GIT_SERVER_SRC)"
  echo "  $TARBALL_APP_SRC app/src/ files match git ($GIT_APP_SRC)"
  echo "  $TARBALL_SKILLS server/src/skills/ files match git ($GIT_SKILLS)"
  echo "  0 unexpected exclusions"
  echo "═══════════════════════════════════════════════════════════════"
  exit 0
else
  echo "═══════════════════════════════════════════════════════════════"
  echo "✗ TARBALL VERIFICATION FAILED — $OUTPUT"
  echo "  Review the mismatches above before handing off this tarball."
  echo "═══════════════════════════════════════════════════════════════"
  exit 1
fi
