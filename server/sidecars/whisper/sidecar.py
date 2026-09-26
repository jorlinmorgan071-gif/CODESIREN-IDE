#!/usr/bin/env python3
"""
Whisper ASR sidecar — spawned and OWNED by the Code Siren Node server.

Uses faster-whisper (CTranslate2-backed, ~4x faster than openai/whisper on CPU,
~50% less RAM). Same JSON-lines protocol as Kokoro/build123d sidecars.

Lifecycle contract (matches existing sidecars):
  1. Node spawns this process via SidecarManager.spawn('whisper', ...).
  2. Communication is stdin/stdout JSON lines (one JSON object per line).
  3. Node is the PARENT process — when it dies, OS sends SIGTERM automatically.
  4. If this process crashes mid-job, Node's 'exit' handler fires, the pending
     promise rejects with SidecarCrashedError, and the calling code throws —
     no silent fallback.
  5. NO daemon mode, NO HTTP server, NO listening port.

Model loads LAZILY on first /transcribe call (not at sidecar startup) — avoids
paying RAM cost if the sidecar is spawned but never used.

The installer triggers /preload to force the model download + load before the
first real /transcribe call, so the user sees progress in the install flow
rather than a long delay on their first transcription.

Protocol (one JSON object per line on stdin, one JSON object per line on stdout):

  Request — health check:
    {"id": "<uuid>", "type": "ping"}
  Response:
    {"id": "<uuid>", "ok": true, "pong": true, "modelLoaded": <bool>}

  Request — preload (download + load model if not already loaded):
    {"id": "<uuid>", "type": "preload", "model_size": "<base>"}
  Response (success):
    {"id": "<uuid>", "ok": true, "modelLoaded": true, "message": "Whisper model downloaded + loaded."}
  Response (failure):
    {"id": "<uuid>", "ok": False, "error": "<message>"}

  Request — transcribe:
    {"id": "<uuid>", "type": "transcribe", "audioBase64": "<base64>", "model_size": "<base>", "language": "<en|auto>"}
  Response (success):
    {"id": "<uuid>", "ok": true, "text": "<transcribed text>", "language": "<detected>", "duration": <float>}
  Response (failure):
    {"id": "<uuid>", "ok": False, "error": "<message>"}
"""

import base64
import json
import os
import signal
import sys
import tempfile
import traceback
from pathlib import Path

# ── Model cache location ─────────────────────────────────────────────────
# Persist the HuggingFace model cache under the sidecar dir (not in ~/.cache)
# so it's covered by .gitignore's model-cache/ rule and never committed.
SIDECAR_DIR = Path(__file__).parent.resolve()
MODEL_CACHE = SIDECAR_DIR / "model-cache"
MODEL_CACHE.mkdir(exist_ok=True)
os.environ.setdefault("HF_HOME", str(MODEL_CACHE))
os.environ.setdefault("HF_HUB_CACHE", str(MODEL_CACHE))
os.environ.setdefault("CT2_CUDA_DISABLE", "1")  # force CPU — no GPU in dev sandbox

# ── Default model ────────────────────────────────────────────────────────
# "base" = 74 MB, multilingual, good balance of speed + accuracy.
# User can override per-call with model_size param.
# Sizes: tiny (39MB), base (74MB), small (244MB), medium (769MB), large (1550MB)
DEFAULT_MODEL_SIZE = "base"
SAMPLE_RATE = 16000  # Whisper requires 16kHz mono

# ── Lazy-loaded model state ──────────────────────────────────────────────
# Loaded on first /transcribe or /preload call, NOT at sidecar startup.
_model = None
_model_size_loaded = None


def die_fast(signum, _frame):
    """SIGTERM/SIGINT handler — exit immediately without flushing buffers."""
    sys.exit(0)


def ensure_model(model_size=None):
    """Lazily load the WhisperModel on first use. Returns the model instance."""
    global _model, _model_size_loaded
    size = model_size or DEFAULT_MODEL_SIZE
    if _model is None or _model_size_loaded != size:
        from faster_whisper import WhisperModel
        import warnings
        warnings.simplefilter("ignore")
        # device="cpu", compute_type="int8" → fastest CPU path, lowest RAM.
        # int8 is ~4x faster than float32 on CPU with negligible accuracy loss.
        _model = WhisperModel(size, device="cpu", compute_type="int8")
        _model_size_loaded = size
        print(f"[whisper] model loaded: {size} (RAM peak during load)", file=sys.stderr, flush=True)
    return _model


def transcribe(audio_base64, model_size=None, language=None):
    """Transcribe audio bytes to text.

    audio_base64: base64-encoded WAV/MP3/M4A/FLAC audio bytes. We write to a
    temp file because faster-whisper's transcribe() takes a file path (it uses
    PyAV internally to decode).
    """
    model = ensure_model(model_size)
    audio_bytes = base64.b64decode(audio_base64)
    if not audio_bytes:
        return {"ok": False, "error": "empty audio data"}

    # Write to temp file — faster-whisper needs a path
    suffix = ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        temp_path = f.name
    try:
        # language=None → auto-detect; language="en" → English-only (faster)
        segments, info = model.transcribe(temp_path, language=language)
        # segments is a generator — consume it
        text = " ".join([seg.text.strip() for seg in segments]).strip()
        return {
            "ok": True,
            "text": text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
        }
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def handle_request(req):
    req_id = req.get("id", "unknown")
    req_type = req.get("type", "")

    if req_type == "ping":
        return {
            "id": req_id,
            "ok": True,
            "pong": True,
            "modelLoaded": _model is not None,
        }

    if req_type == "preload":
        # Installer triggers this to force model download + load before first
        # real /transcribe call. Returns when the model is loaded.
        try:
            ensure_model(req.get("model_size", DEFAULT_MODEL_SIZE))
            return {
                "id": req_id,
                "ok": True,
                "modelLoaded": True,
                "message": f"Whisper model '{_model_size_loaded}' downloaded + loaded. Ready for transcription.",
            }
        except Exception as e:
            tb = traceback.format_exc()
            print(f"[whisper] preload error: {e}\n{tb}", file=sys.stderr, flush=True)
            return {"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"}

    if req_type == "crash":
        # Test path — simulate a crash mid-job
        sys.exit(1)

    if req_type == "transcribe":
        audio_base64 = req.get("audioBase64", "")
        if not audio_base64:
            return {"id": req_id, "ok": False, "error": "missing audioBase64"}
        try:
            result = transcribe(
                audio_base64,
                model_size=req.get("model_size"),
                language=req.get("language"),
            )
            return {"id": req_id, **result}
        except Exception as e:
            tb = traceback.format_exc()
            print(f"[whisper] transcribe error: {e}\n{tb}", file=sys.stderr, flush=True)
            return {"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"}

    return {"id": req_id, "ok": False, "error": f"unknown request type: {req_type!r}"}


def main():
    signal.signal(signal.SIGTERM, die_fast)
    signal.signal(signal.SIGINT, die_fast)

    # NOTE: No "ready" announcement line — matches the build123d and kasa
    # sidecar pattern. SidecarManager doesn't wait for a ready line.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = handle_request(req)
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        except Exception as e:
            tb = traceback.format_exc()
            print(f"[whisper] internal error: {e}\n{tb}", file=sys.stderr, flush=True)
            sys.stdout.write(json.dumps({"id": "unknown", "ok": False, "error": f"internal: {e}"}) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
