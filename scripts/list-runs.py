#!/usr/bin/env python3
"""List recent GitHub Actions runs from stdin JSON. Prints id, name, sha, status, conclusion."""
import sys, json

d = json.load(sys.stdin)
for r in d.get("workflow_runs", []):
    name = r["name"][:30]
    sha = r["head_sha"][:7]
    status = r["status"]
    conc = r.get("conclusion") or "-"
    print(f"id={r['id']:<14} name={name:<30} sha={sha} status={status:<12} {conc}")
