#!/usr/bin/env bash
# scripts/watch-ci.sh — poll a GitHub Actions workflow run until all jobs finish.
#
# Usage:  GH_TOKEN=<token> REPO=<owner/repo> BRANCH=<branch> ./scripts/watch-ci.sh
#
# Reads GH_TOKEN from the environment only — never echoes or stores it.
# The token travels solely in the curl Authorization header; URLs contain no
# credential. Polls every POLL_SEC seconds, capped at MAX_WAIT.
#
# Prints a per-job status table on each tick and a final run summary.

set -uo pipefail

REPO="${REPO:-jorlinmorgan071-gif/CODESIREN-IDE}"
BRANCH="${BRANCH:-main}"
POLL_SEC="${POLL_SEC:-30}"
MAX_WAIT="${MAX_WAIT:-560}"
: "${GH_TOKEN:?GH_TOKEN env var required}"

auth=(-H "Authorization: token ${GH_TOKEN}" -H "Accept: application/vnd.github+json")
api="https://api.github.com/repos/${REPO}/actions"

# 1. Target workflow run: either an explicit RUN_ID, or the latest for the branch.
if [ -n "${RUN_ID:-}" ]; then
  run_id="$RUN_ID"
  run_url="https://github.com/${REPO}/actions/runs/${RUN_ID}"
else
  run_json=$(curl -s "${auth[@]}" "${api}/runs?branch=${BRANCH}&per_page=1")
  run_id=$(printf '%s' "$run_json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['workflow_runs'][0]['id'])")
  run_url=$(printf '%s' "$run_json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['workflow_runs'][0]['html_url'])")
fi
echo "watching run ${run_id}"
echo "  ${run_url}"
echo ""

elapsed=0
all_done=0
while [ "$elapsed" -le "$MAX_WAIT" ]; do
  jobs_json=$(curl -s "${auth[@]}" "${api}/runs/${run_id}/jobs")
  printf '%s\n' "$jobs_json" | python3 -c "
import sys,json
d=json.load(sys.stdin)
js=d.get('jobs',[])
for j in js:
    print(f\"  {j['name'][:52]:52s} {j['status']:12s} {j.get('conclusion') or '-'}\")
print(f'  ({sum(1 for j in js if j[\"status\"]==\"completed\")}/{len(js)} completed)')
"
  total=$(printf '%s' "$jobs_json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d.get('jobs',[])))")
  done_count=$(printf '%s' "$jobs_json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(sum(1 for j in d.get('jobs',[]) if j['status']=='completed'))")
  if [ "$total" -gt 0 ] && [ "$done_count" = "$total" ]; then
    all_done=1
    echo ""
    echo "=== all ${total} jobs completed ==="
    break
  fi
  sleep "$POLL_SEC"
  elapsed=$((elapsed + POLL_SEC))
done

# 2. Final run conclusion.
final=$(curl -s "${auth[@]}" "${api}/runs/${run_id}")
printf '%s\n' "$final" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('final: status=%s conclusion=%s' % (d['status'], d.get('conclusion')))
print('html_url=%s' % d['html_url'])
"

if [ "$all_done" = "1" ]; then
  exit 0
else
  echo "(reached MAX_WAIT=${MAX_WAIT}s before all jobs finished — re-run to continue)"
  exit 3
fi
