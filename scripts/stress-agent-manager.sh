#!/usr/bin/env bash
# Stress test: run agent-manager.test.ts 20 times on a given Node version.
# Usage: bash scripts/stress-agent-manager.sh 22   # runs on Node 22
#        bash scripts/stress-agent-manager.sh 24   # runs on Node 24

set -uo pipefail
NODE_VER="${1:-22}"
RUNS=20
cd /home/z/my-project/server

PASS=0
FAIL=0
declare -a FAIL_RUNS

echo "=== Stress test: agent-manager.test.ts x${RUNS} on Node ${NODE_VER} ==="
echo "=== Node version: $(npx -y node@${NODE_VER} --version 2>/dev/null) ==="
echo

for i in $(seq 1 ${RUNS}); do
  printf "  run %02d/${RUNS} ... " "$i"
  # Run vitest with the specified node version; check exit code (0 = pass)
  if npx -y node@${NODE_VER} ./node_modules/vitest/vitest.mjs run tests/agent/agent-manager.test.ts --reporter=dot > /tmp/stress-run-${i}.log 2>&1; then
    # Verify the test actually ran (not just exited 0 with no tests)
    if grep -q "Tests.*passed" /tmp/stress-run-${i}.log; then
      tests_line=$(grep "Tests.*passed" /tmp/stress-run-${i}.log | tail -1)
      echo "PASS (${tests_line})"
      PASS=$((PASS+1))
    else
      echo "FAIL (no test results in output)"
      FAIL=$((FAIL+1))
      FAIL_RUNS+=("$i")
    fi
  else
    exit_code=$?
    echo "FAIL (exit ${exit_code})"
    FAIL=$((FAIL+1))
    FAIL_RUNS+=("$i")
  fi
done

echo
echo "=== Results: Node ${NODE_VER} ==="
echo "  PASS: ${PASS}/${RUNS}"
echo "  FAIL: ${FAIL}/${RUNS}"
if [ ${FAIL} -gt 0 ]; then
  echo "  Failed runs: ${FAIL_RUNS[*]}"
else
  echo "  Failed runs: (none)"
fi
echo

if [ ${FAIL} -eq 0 ]; then
  echo "VERDICT: unreproduced, monitoring"
  exit 0
else
  echo "VERDICT: reproduced (${FAIL}/${RUNS} failures)"
  exit 1
fi
