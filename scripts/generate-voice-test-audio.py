#!/usr/bin/env python3
"""
Generate a real speech-like audio file for the voice pipeline test.

Uses the z-ai SDK's TTS to generate a short phrase ("what time is it"),
then saves it as a WAV file. This gives us real audio that the z-ai ASR
can transcribe — a proper round-trip test.

Output: /tmp/voice-test-input.wav
"""
import asyncio
import struct
import wave
import sys

async def generate_via_zai_tts():
    """Use z-ai SDK TTS to generate real speech audio."""
    try:
        from zai import ZAI
        zai = await ZAI.create()
        response = await zai.audio.tts.create({
            "input": "What time is it?",
            "voice": "tongtong",
            "speed": 1.0,
            "response_format": "wav",
            "stream": False,
        })
        array_buffer = await response.arrayBuffer()
        audio_bytes = bytes(array_buffer)
        print(f"Generated {len(audio_bytes)} bytes of WAV audio via z-ai TTS")
        return audio_bytes
    except Exception as e:
        print(f"z-ai TTS failed: {e}")
        return None

def generate_fallback_tone():
    """Fallback: generate a simple 440Hz tone WAV (not speech, but valid audio)."""
    sample_rate = 24000
    duration_sec = 2.0
    num_samples = int(sample_rate * duration_sec)
    pcm = bytearray()
    import math
    for i in range(num_samples):
        # 440Hz sine wave at low volume
        sample = int(32767 * 0.3 * math.sin(2 * math.pi * 440 * i / sample_rate))
        pcm += struct.pack('<h', sample)
    # Wrap in WAV
    buf = bytearray()
    buf += b'RIFF'
    buf += struct.pack('<I', 36 + len(pcm))
    buf += b'WAVE'
    buf += b'fmt '
    buf += struct.pack('<I', 16)
    buf += struct.pack('<H', 1)  # PCM
    buf += struct.pack('<H', 1)  # mono
    buf += struct.pack('<I', sample_rate)
    buf += struct.pack('<I', sample_rate * 2)
    buf += struct.pack('<H', 2)
    buf += struct.pack('<H', 16)
    buf += b'data'
    buf += struct.pack('<I', len(pcm))
    buf += pcm
    print(f"Generated {len(buf)} bytes of fallback tone WAV (440Hz, 2s)")
    return bytes(buf)

async def main():
    out_path = "/tmp/voice-test-input.wav"
    audio_bytes = await generate_via_zai_tts()
    if audio_bytes is None:
        print("Falling back to simple tone (z-ai TTS unavailable)...")
        audio_bytes = generate_fallback_tone()
    with open(out_path, 'wb') as f:
        f.write(audio_bytes)
    print(f"Saved: {out_path} ({len(audio_bytes)} bytes)")
    # Verify it's a valid WAV
    with wave.open(out_path, 'rb') as wf:
        print(f"  channels: {wf.getnchannels()}")
        print(f"  sample rate: {wf.getframerate()}")
        print(f"  sample width: {wf.getsampwidth()} bytes")
        print(f"  frames: {wf.getnframes()}")
        print(f"  duration: {wf.getnframes() / wf.getframerate():.2f}s")

asyncio.run(main())
