// server/src/sidecars/disk-info.ts
// Phase 3+ — Cross-platform free disk space check for the local-model installer.
//
// Used by the installer to:
//   1. Pre-check: is there enough free space BEFORE starting the install?
//   2. Show the user real numbers: "Need ~1.7 GB, you have 12.3 GB free"
//   3. Refuse to start if insufficient (don't fail halfway through a 1.4 GB download)
//
// Primary path: fs.statfs() (Node 18.15+, we're on Node 24).
// Fallback: spawn `df -k <path>` on Unix, PowerShell on Windows.

import { statfs } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Get the free disk space (in bytes) at the given path.
 *
 * Returns the number of bytes available to unprivileged users (bavail, not
 * bfree — bfree includes reserved blocks that only root can use, which
 * would over-report what the user can actually use).
 *
 * On failure (unsupported platform, path doesn't exist, etc.), returns null
 * — callers should treat null as "couldn't check, proceed with caution."
 */
export async function getFreeDiskBytes(path: string): Promise<number | null> {
  // Ensure the path exists (statfs fails on non-existent paths)
  let checkPath = path;
  while (!existsSync(checkPath) && checkPath !== dirname(checkPath)) {
    checkPath = dirname(checkPath);
  }

  // Primary path: fs.statfs() — available on Node 18.15+
  try {
    const stats = await statfs(checkPath);
    // bavail = blocks available to unprivileged users
    // bsize = block size in bytes
    // Free bytes = bavail × bsize
    const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes > 0 && Number.isFinite(freeBytes)) {
      return freeBytes;
    }
  } catch {
    // statfs not available or failed — fall through to platform-specific path
  }

  // Fallback: df -k on Unix (Linux + macOS)
  if (process.platform !== 'win32') {
    try {
      const result = spawnSync('df', ['-k', checkPath], {
        encoding: 'utf8',
        timeout: 3000,
      });
      if (result.status === 0 && result.stdout) {
        const lines = result.stdout.trim().split('\n');
        if (lines.length >= 2) {
          // Second line: Filesystem 1K-blocks Used Available Use% Mounted-on
          const fields = lines[1].trim().split(/\s+/);
          // Available is the 4th field (index 3), in 1K blocks
          const availKb = parseInt(fields[3], 10);
          if (!isNaN(availKb) && availKb > 0) {
            return availKb * 1024;
          }
        }
      }
    } catch {
      // df not available — fall through
    }
  }

  // Fallback: PowerShell on Windows
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-PSDrive -Name '${checkPath[0]}').Free`,
      ], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (result.status === 0 && result.stdout) {
        const freeBytes = parseInt(result.stdout.trim(), 10);
        if (!isNaN(freeBytes) && freeBytes > 0) {
          return freeBytes;
        }
      }
    } catch {
      // PowerShell not available — fall through
    }
  }

  // Couldn't determine free space — return null so callers can proceed with caution
  return null;
}

/**
 * Format bytes as a human-readable string (e.g. "1.7 GB", "523 MB", "2.1 TB").
 * Uses 1024-based units (binary, not decimal) — consistent with how disk
 * utilities report space on Linux/macOS.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, unitIndex);
  // Show 1 decimal for GB+, 0 for smaller
  const decimals = unitIndex >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/**
 * Check whether a sidecar install has enough disk space.
 *
 * Returns:
 *   - sufficient: true if freeBytes >= requiredBytes (or if freeBytes is null — can't check)
 *   - freeBytes: actual free space (null if couldn't determine)
 *   - requiredBytes: the threshold passed in
 *   - freeHuman / requiredHuman: pre-formatted strings for the UI
 *   - deficitBytes: how much more space is needed (0 if sufficient)
 */
export async function checkDiskSpace(
  path: string,
  requiredBytes: number,
): Promise<{
  sufficient: boolean;
  freeBytes: number | null;
  requiredBytes: number;
  freeHuman: string;
  requiredHuman: string;
  deficitBytes: number;
  deficitHuman: string;
}> {
  const freeBytes = await getFreeDiskBytes(path);
  const sufficient = freeBytes === null ? true : freeBytes >= requiredBytes;
  const deficitBytes = freeBytes === null ? 0 : Math.max(0, requiredBytes - freeBytes);
  return {
    sufficient,
    freeBytes,
    requiredBytes,
    freeHuman: freeBytes === null ? 'unknown' : formatBytes(freeBytes),
    requiredHuman: formatBytes(requiredBytes),
    deficitBytes,
    deficitHuman: formatBytes(deficitBytes),
  };
}
