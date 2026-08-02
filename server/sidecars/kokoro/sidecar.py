#!/usr/bin/env python3
"""
Kokoro TTS sidecar — spawned and OWNED by the Code Siren Node server.

Follows the SAME stdin/stdout JSON-lines protocol as build123d/sidecar.py
and kasa/sidecar.py. The Node server's existing SidecarManager spawns and
manages this process — no HTTP server, no listening port.

Lifecycle contract (matches existing sidecars):
  1. Node spawns this process via SidecarManager.spawn('kokoro', ...).
  2. Communication is stdin/stdout JSON lines (one JSON object per line).
  3. Node is the PARENT process — when it dies, OS sends SIGTERM
     automatically (we also install signal handlers to die fast).
  4. If this process crashes mid-job, Node's 'exit' handler fires, the
     pending promise rejects with SidecarCrashedError, and the calling
     KokoroTTSProvider.speak() throws — no silent fallback.
  5. NO daemon mode, NO HTTP server, NO listening port.

Model loads LAZILY on first /tts call (not at sidecar startup) — avoids
paying 1.3 GB RAM + 13s load cost if the sidecar is spawned but never
used.

Protocol (one JSON object per line on stdin, one JSON object per line on stdout):

  Request — health check:
    {"id": "<uuid>", "type": "ping"}
  Response:
    {"id": "<uuid>", "ok": true, "pong": true, "modelLoaded": <bool>}

  Request — TTS synthesis:
    {"id": "<uuid>", "type": "tts", "text": "<text>", "voice": "<voice>", "langCode": "<a|b|j|z|...>"}
  Response (success):
    {"id": "<uuid>", "ok": true, "audioBase64": "<base64>", "sampleRate": 24000, "durationMs": <int>, "format": "wav"}
  Response (failure — bad input, model error, etc.):
    {"id": "<uuid>", "ok": false, "error": "<message>"}
  Response (internal error — sidecar itself broke):
    {"id": "<uuid>", "ok": false, "error": "internal: <message>", "fatal": true}

  Special request types:
    {"id": "<uuid>", "type": "crash"}  — sidecar calls sys.exit(1) to simulate a crash
                                         (used by the fabrication-guard test)
"""

import base64
import json
import os
import signal
import sys
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
os.environ.setdefault("TRANSFORMERS_CACHE", str(MODEL_CACHE))

# ── Default voice + sample rate ──────────────────────────────────────────
# Per Section 0.1: af_heart is the A-grade American English female voice.
DEFAULT_VOICE = "af_heart"
DEFAULT_LANG_CODE = "a"  # American English
SAMPLE_RATE = 24000  # Kokoro's fixed output sample rate

# ── Lazy-loaded model state ──────────────────────────────────────────────
# Loaded on first /tts call, NOT at sidecar startup.
_model = None
_pipelines = {}  # lang_code -> KPipeline (one per language, all sharing _model)


def die_fast(signum, _frame):
    """SIGTERM/SIGINT handler — exit immediately without flushing buffers."""
    sys.exit(0)


def ensure_model():
    """Lazily load the KModel on first use. Returns the model instance."""
    global _model
    if _model is None:
        # Import here (not at module top) so the sidecar starts fast and
        # only pays the torch import cost when TTS is actually requested.
        from kokoro import KModel
        # Suppress Python warnings (torch weight_norm deprecation, etc.) —
        # they would otherwise pollute stdout and break the JSON-lines protocol.
        import warnings
        warnings.simplefilter("ignore")
        _model = KModel(repo_id="hexgrad/Kokoro-82M").to("cpu")
        print(f"[kokoro] model loaded (RAM peak during load)", file=sys.stderr, flush=True)
    return _model


def get_pipeline(lang_code: str):
    """Get or create a KPipeline for the given language code. Reuses the
    shared KModel across all pipelines."""
    if lang_code not in _pipelines:
        from kokoro import KPipeline
        import warnings
        warnings.simplefilter("ignore")
        model = ensure_model()
        # Temporarily redirect stdout to suppress the spacy download
        # announcement and any KPipeline init warnings that print to stdout
        # instead of stderr — these would break the JSON-lines protocol.
        import io
        import contextlib
        captured_stdout = io.StringIO()
        with contextlib.redirect_stdout(captured_stdout):
            _pipelines[lang_code] = KPipeline(
                lang_code=lang_code, model=model, repo_id="hexgrad/Kokoro-82M"
            )
        # Log any captured stdout to stderr (visible but not protocol-breaking)
        captured_text = captured_stdout.getvalue().strip()
        if captured_text:
            print(f"[kokoro] pipeline init stdout: {captured_text[:200]}", file=sys.stderr, flush=True)
        print(f"[kokoro] pipeline created for lang_code={lang_code!r}", file=sys.stderr, flush=True)
    return _pipelines[lang_code]


def synthesize(text: str, voice: str, lang_code: str) -> dict:
    """Run Kokoro TTS on the input text and return a TTSResult-shaped dict."""
    if not text or not text.strip():
        return {"ok": False, "error": "empty text"}

    pipeline = get_pipeline(lang_code)
    chunks = list(pipeline(text, voice=voice))

    if len(chunks) == 0:
        # Kokoro yields zero chunks for whitespace-only input (Section 0.1 finding)
        return {"ok": False, "error": "no audio produced (input may be whitespace-only)"}

    # Concatenate audio from all chunks into a single buffer
    import numpy as np
    audio_parts = []
    for chunk in chunks:
        if chunk.audio is None:
            return {"ok": False, "error": "chunk produced null audio"}
        # Kokoro returns torch.Tensor — convert to numpy float32
        audio_np = chunk.audio.detach().cpu().numpy() if hasattr(chunk.audio, "detach") else np.array(chunk.audio)
        audio_parts.append(audio_np)

    audio_combined = np.concatenate(audio_parts)

    # Convert float32 [-1.0, 1.0] → int16 PCM
    audio_int16 = (audio_combined * 32767).clip(-32768, 32767).astype("<i2")
    audio_bytes = audio_int16.tobytes()
    audio_base64 = base64.b64encode(audio_bytes).decode("ascii")

    duration_ms = int(len(audio_combined) / SAMPLE_RATE * 1000)

    return {
        "ok": True,
        "audioBase64": audio_base64,
        "sampleRate": SAMPLE_RATE,
        "durationMs": duration_ms,
        # Raw int16 PCM, NOT WAV. The Node-side KokoroTTSProvider wraps it
        # in a WAV header using the shared wrapPcmInWav() util before
        # returning TTSResult. Keeping the sidecar output as raw PCM is
        # simpler (no Python wave module needed) and consistent with how
        # ElevenLabsTTSProvider handles its raw pcm_24000 API response.
        "format": "pcm",
        "phonemes": chunks[0].phonemes if chunks else "",
    }


def handle_request(req: dict) -> dict:
    req_id = req.get("id", "unknown")
    req_type = req.get("type", "")

    if req_type == "ping":
        return {
            "id": req_id,
            "ok": True,
            "pong": True,
            "modelLoaded": _model is not None,
        }

    if req_type == "crash":
        # Fabrication-guard test path — simulate a crash mid-job
        sys.exit(1)

    if req_type == "tts":
        text = req.get("text", "")
        voice = req.get("voice", DEFAULT_VOICE)
        lang_code = req.get("langCode", DEFAULT_LANG_CODE)
        try:
            result = synthesize(text, voice, lang_code)
            return {"id": req_id, **result}
        except Exception as e:
            tb = traceback.format_exc()
            print(f"[kokoro] tts error: {e}\n{tb}", file=sys.stderr, flush=True)
            return {"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"}

    return {"id": req_id, "ok": False, "error": f"unknown request type: {req_type!r}"}


def main():
    # Install signal handlers — die fast on SIGTERM/SIGINT
    signal.signal(signal.SIGTERM, die_fast)
    signal.signal(signal.SIGINT, die_fast)

    # NOTE: No "ready" announcement line — matches the build123d and kasa
    # sidecar pattern. SidecarManager doesn't wait for a ready line; it just
    # spawns and trusts the process is alive. Emitting an unsolicited JSON
    # line at startup would be parsed as an orphan response (id=undefined,
    # no matching pending request) and logged as a warning.

    # Read JSON requests line-by-line from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            # Malformed input — respond with error, don't crash
            resp = {"id": "unknown", "ok": False, "error": f"invalid JSON: {e}"}
            print(json.dumps(resp), flush=True)
            continue

        resp = handle_request(req)
        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()
