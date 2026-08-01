// server/src/systems/voice/audio-wav.ts
// Shared audio utilities for TTS providers.
//
// Extracted from StubTTSProvider's inline WAV-header logic (Phase E Build 3)
// so ElevenLabsTTSProvider and future providers can reuse the same PCM→WAV
// wrapping. The Kokoro sidecar does its own WAV wrapping in Python (sidecar.py)
// because the audio arrives as a torch.Tensor — that path doesn't need this util.

/**
 * Wrap raw int16 PCM samples in a WAV file header and return as a Buffer.
 *
 * @param pcmBytes raw little-endian int16 PCM samples (no header)
 * @param sampleRate sample rate in Hz (e.g. 24000)
 * @param channels number of channels (1 = mono, 2 = stereo)
 * @returns Buffer containing a complete WAV file (44-byte header + PCM data)
 */
export function wrapPcmInWav(
  pcmBytes: Uint8Array | Buffer,
  sampleRate: number,
  channels: number = 1,
): Buffer {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;  // 2
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBytes.length;
  const totalSize = 44 + dataSize;

  const buffer = Buffer.alloc(totalSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);              // subchunk size (PCM = 16)
  buffer.writeUInt16LE(1, 20);                // audio format (1 = PCM)
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // PCM samples
  Buffer.from(pcmBytes).copy(buffer, 44);

  return buffer;
}

/**
 * Calculate the duration in milliseconds of raw PCM audio.
 *
 * @param pcmBytes raw PCM samples (int16, little-endian)
 * @param sampleRate sample rate in Hz
 * @param channels number of channels
 * @returns duration in milliseconds
 */
export function pcmDurationMs(
  pcmBytes: Uint8Array | Buffer,
  sampleRate: number,
  channels: number = 1,
): number {
  const bytesPerSample = 2;  // int16
  const bytesPerFrame = channels * bytesPerSample;
  const numFrames = pcmBytes.length / bytesPerFrame;
  return Math.round((numFrames / sampleRate) * 1000);
}
