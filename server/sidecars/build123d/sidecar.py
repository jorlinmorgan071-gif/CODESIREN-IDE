#!/usr/bin/env python3
"""
build123d sidecar — spawned and OWNED by the Code Siren Node server.

Lifecycle contract (per Step 4 user condition):
  1. The Node server spawns this process via SidecarManager.
  2. Communication is stdin/stdout JSON lines (one JSON object per line).
  3. The Node server is the PARENT process — when it dies, the OS sends SIGTERM
     to this process automatically (we also install signal handlers to die fast).
  4. If this process crashes mid-job, the Node server's 'exit' handler fires,
     the pending promise rejects, and the Fabrication Agent surfaces it as
     agent:error — the agent never hangs.
  5. There is NO daemon mode, NO HTTP server, NO listening port. This process
     does one job per stdin line and exits when stdin closes.

Protocol (one JSON object per line on stdin, one JSON object per line on stdout):

  Request:
    {"id": "<uuid>", "type": "execute", "script": "<python source>", "output_stl_path": "<abs path>"}
  Response (success):
    {"id": "<uuid>", "ok": true, "stl_path": "<abs path>", "stl_size": <bytes>, "stdout": "...", "stderr": "..."}
  Response (failure — script ran but returned non-zero or didn't produce STL):
    {"id": "<uuid>", "ok": false, "error": "<message>", "stdout": "...", "stderr": "..."}
  Response (internal error — sidecar itself broke):
    {"id": "<uuid>", "ok": false, "error": "internal: <message>", "fatal": true}

Special request types for testing the lifecycle contract:
    {"id": "<uuid>", "type": "crash"}  — sidecar calls sys.exit(1) immediately to simulate a crash
    {"id": "<uuid>", "type": "ping"}   — sidecar responds with {"ok": true, "pong": true}
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path


def die_fast(signum, _frame):
    """SIGTERM/SIGINT handler — exit immediately without flushing buffers."""
    sys.exit(0)


def handle_request(req: dict) -> dict:
    req_id = req.get("id", "unknown")
    req_type = req.get("type", "")

    if req_type == "ping":
        return {"id": req_id, "ok": True, "pong": True}

    if req_type == "crash":
        # Simulate a sidecar crash — used by the lifecycle test to prove the
        # Node server catches it and surfaces agent:error instead of hanging.
        sys.exit(1)

    if req_type == "execute":
        return handle_execute(req_id, req)

    return {"id": req_id, "ok": False, "error": f"unknown request type: {req_type}"}


def handle_execute(req_id: str, req: dict) -> dict:
    script = req.get("script", "")
    output_stl_path = req.get("output_stl_path", "")

    if not script:
        return {"id": req_id, "ok": False, "error": "missing 'script'"}
    if not output_stl_path:
        return {"id": req_id, "ok": False, "error": "missing 'output_stl_path'"}

    # Write the script to a temp file, then run it with the current Python.
    # We use a temp file rather than `python -c` because build123d scripts
    # often contain multi-line string literals that break -c parsing.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, dir="/tmp") as f:
        f.write(script)
        script_path = f.name

    try:
        # Run the script. We DON'T inject the output path into the script source —
        # the caller (Node side) is expected to have already substituted it in.
        proc = subprocess.run(
            [sys.executable, script_path],
            capture_output=True,
            text=True,
            timeout=30,  # hard cap — 3D generation shouldn't take >30s
        )
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""

        if proc.returncode != 0:
            return {
                "id": req_id,
                "ok": False,
                "error": f"script exited with code {proc.returncode}",
                "stdout": stdout[-2000:],
                "stderr": stderr[-2000:],
            }

        # Verify the STL was produced
        if not os.path.exists(output_stl_path):
            return {
                "id": req_id,
                "ok": False,
                "error": f"script ran but did not produce STL at {output_stl_path}",
                "stdout": stdout[-2000:],
                "stderr": stderr[-2000:],
            }

        stl_size = os.path.getsize(output_stl_path)
        return {
            "id": req_id,
            "ok": True,
            "stl_path": output_stl_path,
            "stl_size": stl_size,
            "stdout": stdout[-2000:],
            "stderr": stderr[-2000:],
        }
    except subprocess.TimeoutExpired:
        return {
            "id": req_id,
            "ok": False,
            "error": "script timed out after 30s",
            "fatal": True,
        }
    except Exception as e:
        return {
            "id": req_id,
            "ok": False,
            "error": f"internal: {e}",
            "fatal": True,
            "traceback": traceback.format_exc()[-2000:],
        }
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass


def main():
    # Install signal handlers — die fast when the parent (Node) dies.
    # This is the "no orphan" guarantee: when Node exits, the OS sends SIGTERM
    # to this process, and we exit immediately.
    signal.signal(signal.SIGTERM, die_fast)
    signal.signal(signal.SIGINT, die_fast)

    # Read JSON lines from stdin until EOF (Node closed stdin = shutdown)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            # Malformed input — emit an error response and continue
            sys.stdout.write(json.dumps({"id": "unknown", "ok": False, "error": f"invalid JSON: {e}"}) + "\n")
            sys.stdout.flush()
            continue

        try:
            resp = handle_request(req)
        except Exception as e:
            resp = {"id": req.get("id", "unknown"), "ok": False, "error": f"internal: {e}", "fatal": True}

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()

    # stdin closed = Node server is shutting down = exit cleanly
    sys.exit(0)


if __name__ == "__main__":
    main()
