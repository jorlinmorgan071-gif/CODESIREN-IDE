#!/usr/bin/env bash
# scripts/grep-audit.sh — Naturalization grep-audit (directive Step 1 + Section 9 #1).
#
# Confirms zero references to ada / jarvis / openjarvis anywhere in the merged
# Code Siren repo, except in:
#   - this script itself
#   - CHANGELOG.md / acknowledgments (the directive explicitly allows these)
#   - the inventory doc (which references them by name as the donor projects)
#   - .git/ node_modules/ dist/ build venv .venv artifacts
#
# Exit non-zero if any unexpected match is found.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Naturalization grep-audit"
echo "  Searching for: ada | jarvis | openjarvis (case-insensitive, word-boundary)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Allowlist — these files MAY mention the donor project names
ALLOWLIST=(
  "scripts/grep-audit.sh"
  "scripts/secret-scan-donors.sh"
  "CHANGELOG.md"
  "ACKNOWLEDGMENTS.md"
  "download/inventory-and-merge-plan.md"
  "worklog.md"
)

# Build grep include/exclude
EXCLUDE_DIRS=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.cache --exclude-dir=venv --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=model-cache)
EXCLUDE_FILES=(--exclude="package-lock.json" --exclude="yarn.lock" --exclude="pnpm-lock.yaml" --exclude="uv.lock" --exclude="Cargo.lock" --exclude="*.vrm" --exclude="*.fbx" --exclude="*.glb" --exclude="*.gltf" --exclude="*.bin" --exclude="*.wasm")

# Run grep across the whole tree.
# Word boundaries (\b) prevent false positives like `metadata` matching `ada`,
# or base64 hash substrings matching `ada`/`jarvis`.
TMP=$(mktemp)
trap 'rm -f "$TMP" "$FILTERED"' EXIT
FILTERED=$(mktemp)

grep -irnE "\b(ada|jarvis|openjarvis)\b" "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" "$ROOT"/server "$ROOT"/app "$ROOT"/scripts "$ROOT"/.github > "$TMP" 2>/dev/null || true
cp "$TMP" "$FILTERED"

for allowed in "${ALLOWLIST[@]}"; do
  # Strip lines that originate from an allowed file
  # (paths in grep output are like "/path/to/file:line:content")
  grep -vE "(^|/)${allowed}:" "$FILTERED" > "${FILTERED}.tmp" 2>/dev/null || true
  mv "${FILTERED}.tmp" "$FILTERED"
done

# Also exclude matches inside the extracted donor codebases themselves
# (those are reference material, not part of the merged Code Siren repo)
grep -vE "/extracted/(ada_v2|openjarvis)/" "$FILTERED" > "${FILTERED}.tmp" 2>/dev/null || true
mv "${FILTERED}.tmp" "$FILTERED"

# Also exclude the upload directory (source zips + the directive PDF)
grep -vE "/upload/" "$FILTERED" > "${FILTERED}.tmp" 2>/dev/null || true
mv "${FILTERED}.tmp" "$FILTERED"

# Also exclude the code_siren_pdf.txt extract (reference only)
grep -vE "code_siren_pdf\.txt" "$FILTERED" > "${FILTERED}.tmp" 2>/dev/null || true
mv "${FILTERED}.tmp" "$FILTERED"

COUNT=$(wc -l < "$FILTERED" | tr -d ' ')

echo
if [ "$COUNT" -eq 0 ]; then
  echo "  ✓ PASS — zero unexpected matches for ada|jarvis|openjarvis"
  echo
  echo "  (Allowlisted files were skipped: ${ALLOWLIST[*]})"
  echo "  (Donor codebases under /extracted/{ada_v2,openjarvis}/ were skipped — reference only)"
  echo "  (Source materials under /upload/ were skipped — original inputs)"
  exit 0
else
  echo "  ✗ FAIL — $COUNT unexpected matches found:"
  echo
  cat "$FILTERED"
  echo
  echo "  These must be eliminated before proceeding to Step 2 (directive Section 9)."
  exit 1
fi
