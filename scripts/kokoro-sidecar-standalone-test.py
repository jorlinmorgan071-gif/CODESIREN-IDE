#!/usr/bin/env python3
"""
Phase E Build 1 — Step 1 standalone sidecar proof.

Starts the Kokoro sidecar process directly (no Node), feeds it JSON-lines
requests via stdin, reads responses from stdout. Confirms real audio is
produced before any Node code is written against it.

Mirrors the Section 0.1 inference test but going through the actual
sidecar protocol the Node SidecarManager will use.
"""

import json
import subprocess
import sys
import time
import uuid

SIDECAR = "/home/z/my-project/extracted/code_siren/server/sidecars/kokoro/sidecar.py"
VENV_PYTHON = "/home/z/my-project/extracted/code_siren/server/sidecars/kokoro/venv/bin/python"

def send(proc, req):
    """Send a JSON request, read one JSON response."""
    line = json.dumps(req) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()
    # Read one line back
    resp_line = proc.stdout.readline()
    if not resp_line:
        raise RuntimeError(f"sidecar closed stdout after request {req.get('id')}")
    return json.loads(resp_line)

def main():
    print("=" * 70)
    print("STEP 1 — Start sidecar process")
    print("=" * 70)
    print(f"Spawning: {VENV_PYTHON} {SIDECAR}")
    t0 = time.time()
    proc = subprocess.Popen(
        [VENV_PYTHON, SIDECAR],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,  # line-buffered
    )
    print(f"Spawned pid={proc.pid}")

    # First line is the "ready" announcement
    ready_line = proc.stdout.readline()
    print(f"Ready announcement: {ready_line.strip()}")
    t1 = time.time()
    print(f"Sidecar startup took {t1 - t0:.2f}s (model NOT loaded yet — lazy)")

    # ─── Test 1: ping (model not loaded yet) ────────────────────────────
    print()
    print("=" * 70)
    print("TEST 1 — ping (model should NOT be loaded yet)")
    print("=" * 70)
    req = {"id": str(uuid.uuid4()), "type": "ping"}
    resp = send(proc, req)
    print(f"Request:  {req}")
    print(f"Response: {resp}")
    assert resp["ok"] is True
    assert resp["pong"] is True
    assert resp["modelLoaded"] is False, "model should NOT be loaded on startup (lazy)"
    print("✓ PASS — sidecar alive, model not yet loaded")

    # ─── Test 2: TTS synthesis (triggers lazy model load) ───────────────
    print()
    print("=" * 70)
    print("TEST 2 — TTS synthesis (triggers lazy model load on first call)")
    print("=" * 70)
    text = "The quick brown fox jumps over the lazy dog."
    req = {
        "id": str(uuid.uuid4()),
        "type": "tts",
        "text": text,
        "voice": "af_heart",
        "langCode": "a",
    }
    print(f"Request text: {text!r}")
    print(f"Voice: af_heart | Lang: a (American English)")
    t0 = time.time()
    resp = send(proc, req)
    t1 = time.time()
    print(f"Response keys: {list(resp.keys())}")
    print(f"  ok: {resp.get('ok')}")
    print(f"  format: {resp.get('format')}")
    print(f"  sampleRate: {resp.get('sampleRate')}")
    print(f"  durationMs: {resp.get('durationMs')}")
    print(f"  audioBase64 length: {len(resp.get('audioBase64', ''))} chars")
    print(f"  phonemes: {resp.get('phonemes', '')[:80]}")
    print(f"  wall-clock: {t1 - t0:.3f}s (includes lazy model load + first inference)")

    assert resp["ok"] is True, f"TTS failed: {resp.get('error')}"
    assert resp["format"] == "wav"
    assert resp["sampleRate"] == 24000
    assert resp["durationMs"] > 0
    assert len(resp["audioBase64"]) > 1000
    print("✓ PASS — real audio produced")

    # Save the audio to verify it's valid WAV-able bytes
    import base64
    audio_bytes = base64.b64decode(resp["audioBase64"])
    out_path = "/home/z/my-project/extracted/code_siren/server/sidecars/kokoro/test-output-step1.wav"
    # Wrap raw int16 PCM in a WAV header
    import wave
    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        wf.writeframes(audio_bytes)
    print(f"Saved WAV: {out_path} ({len(audio_bytes) + 44} bytes)")

    # ─── Test 3: ping again (model should NOW be loaded) ────────────────
    print()
    print("=" * 70)
    print("TEST 3 — ping again (model should NOW be loaded)")
    print("=" * 70)
    req = {"id": str(uuid.uuid4()), "type": "ping"}
    resp = send(proc, req)
    print(f"Response: {resp}")
    assert resp["modelLoaded"] is True, "model should be loaded after first /tts"
    print("✓ PASS — model is now loaded (lazy load worked)")

    # ─── Test 4: second TTS call (should be faster — model already loaded) ─
    print()
    print("=" * 70)
    print("TEST 4 — second TTS call (model already loaded, should be faster)")
    print("=" * 70)
    text2 = "Code Siren is now speaking with Kokoro."
    req = {
        "id": str(uuid.uuid4()),
        "type": "tts",
        "text": text2,
        "voice": "af_heart",
        "langCode": "a",
    }
    print(f"Request text: {text2!r}")
    t0 = time.time()
    resp = send(proc, req)
    t1 = time.time()
    print(f"  ok: {resp.get('ok')}")
    print(f"  durationMs: {resp.get('durationMs')}")
    print(f"  audioBase64 length: {len(resp.get('audioBase64', ''))} chars")
    print(f"  wall-clock: {t1 - t0:.3f}s (model already loaded — should be ~2s)")
    assert resp["ok"] is True
    print("✓ PASS — second call faster, sidecar reuse working")

    # ─── Test 5: empty text input (failure mode — fabrication guard) ─────
    print()
    print("=" * 70)
    print("TEST 5 — empty text input (should fail honestly, no fabricated audio)")
    print("=" * 70)
    req = {"id": str(uuid.uuid4()), "type": "tts", "text": "", "voice": "af_heart", "langCode": "a"}
    resp = send(proc, req)
    print(f"Response: {resp}")
    assert resp["ok"] is False, "empty text should fail"
    assert "audioBase64" not in resp, "no audio should be returned for failure"
    assert "empty" in resp["error"].lower() or "no audio" in resp["error"].lower()
    print("✓ PASS — empty text fails honestly, no fabricated audio")

    # ─── Test 6: invalid voice (failure mode — should throw, not fabricate) ─
    print()
    print("=" * 70)
    print("TEST 6 — invalid voice name (should fail honestly)")
    print("=" * 70)
    req = {"id": str(uuid.uuid4()), "type": "tts", "text": "hello", "voice": "xx_nonexistent", "langCode": "a"}
    resp = send(proc, req)
    print(f"Response: {resp}")
    assert resp["ok"] is False
    assert "audioBase64" not in resp
    print("✓ PASS — invalid voice fails honestly")

    # ─── Clean shutdown ──────────────────────────────────────────────────
    print()
    print("=" * 70)
    print("CLEAN SHUTDOWN — close stdin, sidecar should exit")
    print("=" * 70)
    proc.stdin.close()
    proc.wait(timeout=5)
    print(f"Sidecar exited with code {proc.returncode}")
    assert proc.returncode == 0

    print()
    print("=" * 70)
    print("ALL STEP 1 TESTS PASSED")
    print("=" * 70)
    print("Sidecar is ready for Node-side integration (Step 2).")

if __name__ == "__main__":
    main()
