#!/usr/bin/env python3
"""
python-kasa sidecar — spawned and OWNED by the Code Siren Node server.

Lifecycle contract (same as build123d sidecar — re-proven per Step 7 condition):
  1. The Node server spawns this process via SidecarManager.
  2. Communication is stdin/stdout JSON lines (one JSON object per line).
  3. The Node server is the PARENT process — when it dies, the OS sends SIGTERM
     to this process automatically (we also install signal handlers to die fast).
  4. If this process crashes mid-job, the Node server's 'exit' handler fires,
     the pending promise rejects with SidecarCrashedError, and the Operative
     Agent surfaces it as agent:error — the agent never hangs.
  5. There is NO daemon mode, NO HTTP server, NO listening port.

Protocol (one JSON object per line on stdin, one JSON object per line on stdout):

  Request:
    {"id": "<uuid>", "type": "discover"}
    {"id": "<uuid>", "type": "turn_on", "target": "<ip or alias>"}
    {"id": "<uuid>", "type": "turn_off", "target": "<ip or alias>"}
    {"id": "<uuid>", "type": "set_brightness", "target": "...", "brightness": 50}
    {"id": "<uuid>", "type": "set_color", "target": "...", "color": "red" | [h,s,v]}
    {"id": "<uuid>", "type": "ping"}
    {"id": "<uuid>", "type": "crash"}  — sys.exit(1) to simulate a crash (lifecycle test)

  Response (success):
    {"id": "<uuid>", "ok": true, ...result fields}
  Response (failure):
    {"id": "<uuid>", "ok": false, "error": "<message>"}
"""

import asyncio
import json
import signal
import sys
import traceback

try:
    from kasa import Discover
except ImportError:
    Discover = None  # python-kasa not installed — sidecar will return errors


def die_fast(signum, _frame):
    """SIGTERM/SIGINT handler — exit immediately."""
    sys.exit(0)


# ── Color name → HSV mapping (ported from donor's kasa_agent.py) ──────────

COLOR_MAP = {
    "red": (0, 100, 100),
    "orange": (30, 100, 100),
    "yellow": (60, 100, 100),
    "green": (120, 100, 100),
    "cyan": (180, 100, 100),
    "blue": (240, 100, 100),
    "purple": (300, 100, 100),
    "pink": (300, 50, 100),
    "white": (0, 0, 100),
    "warm": (30, 20, 100),
    "cool": (200, 10, 100),
    "daylight": (0, 0, 100),
}


# ── In-memory device cache (stub mode uses fake devices when kasa unavailable) ──

STUB_DEVICES = [
    {"ip": "192.168.1.100", "alias": "Living Room Light", "model": "KL125(US)", "type": "bulb", "is_on": False, "brightness": 0, "has_color": True, "has_brightness": True},
    {"ip": "192.168.1.101", "alias": "Desk Lamp", "model": "KL110(US)", "type": "dimmer", "is_on": True, "brightness": 75, "has_color": False, "has_brightness": True},
    {"ip": "192.168.1.102", "alias": "Coffee Maker Plug", "model": "HS100(US)", "type": "plug", "is_on": False, "brightness": None, "has_color": False, "has_brightness": False},
]

# Mutable state for stub device operations
stub_state = {d["ip"]: dict(d) for d in STUB_DEVICES}


async def handle_request(req: dict) -> dict:
    req_id = req.get("id", "unknown")
    req_type = req.get("type", "")

    if req_type == "ping":
        return {"id": req_id, "ok": True, "pong": True}

    if req_type == "crash":
        sys.exit(1)

    if req_type == "discover":
        return await handle_discover(req_id)

    if req_type == "turn_on":
        return await handle_turn_on(req_id, req.get("target", ""))

    if req_type == "turn_off":
        return await handle_turn_off(req_id, req.get("target", ""))

    if req_type == "set_brightness":
        return await handle_set_brightness(req_id, req.get("target", ""), req.get("brightness", 50))

    if req_type == "set_color":
        return await handle_set_color(req_id, req.get("target", ""), req.get("color"))

    return {"id": req_id, "ok": False, "error": f"unknown request type: {req_type}"}


async def handle_discover(req_id: str) -> dict:
    # Step 7: always return stub devices. Real network discovery via python-kasa
    # is a deployment-time concern — the stub proves the pipeline. The Discover
    # module can hang on networks without Kasa devices, which would block the
    # sidecar. Stub-first is the safe default.
    return {"id": req_id, "ok": True, "devices": list(stub_state.values()), "source": "stub"}


def resolve_device(target: str):
    """Resolve target (IP or alias) to a stub device dict."""
    for ip, dev in stub_state.items():
        if ip == target or dev["alias"].lower() == target.lower():
            return dev
    return None


async def handle_turn_on(req_id: str, target: str) -> dict:
    dev = resolve_device(target)
    if not dev:
        return {"id": req_id, "ok": False, "error": f"device not found: {target}"}
    dev["is_on"] = True
    if dev["type"] in ("bulb", "dimmer") and dev["brightness"] == 0:
        dev["brightness"] = 100
    return {"id": req_id, "ok": True, "device": dev, "action": "turn_on"}


async def handle_turn_off(req_id: str, target: str) -> dict:
    dev = resolve_device(target)
    if not dev:
        return {"id": req_id, "ok": False, "error": f"device not found: {target}"}
    dev["is_on"] = False
    return {"id": req_id, "ok": True, "device": dev, "action": "turn_off"}


async def handle_set_brightness(req_id: str, target: str, brightness: int) -> dict:
    dev = resolve_device(target)
    if not dev:
        return {"id": req_id, "ok": False, "error": f"device not found: {target}"}
    if not dev.get("has_brightness"):
        return {"id": req_id, "ok": False, "error": f"device {target} does not support brightness"}
    dev["brightness"] = max(0, min(100, int(brightness)))
    if dev["brightness"] > 0:
        dev["is_on"] = True
    else:
        dev["is_on"] = False
    return {"id": req_id, "ok": True, "device": dev, "action": "set_brightness"}


async def handle_set_color(req_id: str, target: str, color) -> dict:
    dev = resolve_device(target)
    if not dev:
        return {"id": req_id, "ok": False, "error": f"device not found: {target}"}
    if not dev.get("has_color"):
        return {"id": req_id, "ok": False, "error": f"device {target} does not support color"}

    hsv = None
    if isinstance(color, str):
        hsv = COLOR_MAP.get(color.lower().strip())
        if not hsv:
            return {"id": req_id, "ok": False, "error": f"unknown color name: {color}"}
    elif isinstance(color, (list, tuple)) and len(color) == 3:
        hsv = tuple(int(c) for c in color)
    else:
        return {"id": req_id, "ok": False, "error": "color must be a name string or [h,s,v] array"}

    dev["hsv"] = list(hsv)
    dev["is_on"] = True
    return {"id": req_id, "ok": True, "device": dev, "action": "set_color", "hsv": list(hsv)}


def main():
    signal.signal(signal.SIGTERM, die_fast)
    signal.signal(signal.SIGINT, die_fast)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stdout.write(json.dumps({"id": "unknown", "ok": False, "error": f"invalid JSON: {e}"}) + "\n")
            sys.stdout.flush()
            continue

        try:
            req_type = req.get("type", "")
            # ping and crash are synchronous — no need for asyncio.run()
            if req_type == "ping":
                resp = {"id": req.get("id", "unknown"), "ok": True, "pong": True}
            elif req_type == "crash":
                sys.exit(1)
            else:
                resp = asyncio.run(handle_request(req))
        except SystemExit:
            raise
        except Exception as e:
            resp = {"id": req.get("id", "unknown"), "ok": False, "error": f"internal: {e}", "traceback": traceback.format_exc()[-500:]}

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()

    sys.exit(0)


if __name__ == "__main__":
    main()
