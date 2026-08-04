// server/src/orchestration/findings-ledger.ts
// Phase A Section 7: Project Brain — Finding Ledger.
//
// Persists Ghost Mode's scanner output with recurrence tracking + resolution
// detection. A real ledger, not semantic inference — just counting + timestamps.
//
// Storage: server/.runtime/findings-ledger.jsonl (append-on-change, one JSON
// object per line). Loaded into memory at boot for fast lookups, backed by
// the durable file. Same pattern as voice-settings.ts + orchestrator-settings.ts.
//
// Lifecycle:
//   1. recordFinding(finding) — called from _runScanner after reportFinding().
//      Increments detectionCount + updates lastSeenAt if the key exists;
//      creates a new open entry if not.
//   2. markMissingAsResolved() — called after each full scan cycle. Any open
//      entry whose key wasn't seen in this cycle gets status='resolved'.
//   3. Process restart — loadFromDisk() rebuilds the in-memory index from the
//      JSONL file. State survives.

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);
const LEDGER_DIR = join(__dirname_esm, '..', '..', '.runtime');
const LEDGER_FILE = join(LEDGER_DIR, 'findings-ledger.jsonl');

export type FindingStatus = 'open' | 'resolved';

export interface LedgerEntry {
  /** Dedup key: type::filePath::line::description (same as Ghost Mode's reportedFindingKeys) */
  key: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  filePath?: string;
  line?: number;
  description: string;
  firstSeenAt: number;   // epoch ms
  lastSeenAt: number;    // epoch ms
  detectionCount: number;
  status: FindingStatus;
  resolvedAt?: number;   // epoch ms, set when status transitions to 'resolved'
}

// ── In-memory index ─────────────────────────────────────────────────────

const entries = new Map<string, LedgerEntry>();
let loaded = false;
/** Keys seen in the current scan cycle (reset at the start of each cycle) */
const cycleKeys = new Set<string>();

/** Load the ledger from disk into the in-memory index. Called lazily on first access. */
function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;

  if (!existsSync(LEDGER_FILE)) return;

  try {
    const raw = readFileSync(LEDGER_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as LedgerEntry;
        // Last-write-wins: if the same key appears multiple times in the file
        // (append-on-change), the last entry wins.
        entries.set(entry.key, entry);
      } catch {
        // skip malformed line
      }
    }
    console.log(`[findings-ledger] loaded ${entries.size} entries from disk`);
  } catch (err: any) {
    console.warn(`[findings-ledger] failed to load from disk: ${err.message}`);
  }
}

/** Persist the full in-memory index to disk (rewrite, not append — keeps the file small). */
function persistToDisk(): void {
  try {
    if (!existsSync(LEDGER_DIR)) {
      mkdirSync(LEDGER_DIR, { recursive: true });
    }
    const lines = [...entries.values()].map((e) => JSON.stringify(e));
    writeFileSync(LEDGER_FILE, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
  } catch (err: any) {
    console.warn(`[findings-ledger] failed to persist to disk: ${err.message}`);
  }
}

/** Build the dedup key from finding fields (same formula as Ghost Mode's reportedFindingKeys). */
function buildKey(finding: { type: string; filePath?: string; line?: number; description: string }): string {
  const fp = finding.filePath ?? '';
  const ln = finding.line != null ? String(finding.line) : '';
  return `${finding.type}::${fp}::${ln}::${finding.description}`;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Record a finding detected during a scan cycle.
 * - If the key exists: increment detectionCount, update lastSeenAt, ensure status='open'.
 * - If new: create a new open entry with detectionCount=1.
 * - Track the key in cycleKeys for markMissingAsResolved().
 */
export function recordFinding(finding: {
  type: string;
  severity: 'low' | 'medium' | 'high';
  filePath?: string;
  line?: number;
  description: string;
}): void {
  loadFromDisk();

  const key = buildKey(finding);
  cycleKeys.add(key);

  const now = Date.now();
  const existing = entries.get(key);

  if (existing) {
    existing.lastSeenAt = now;
    existing.detectionCount++;
    // If it was previously resolved, reopen it
    if (existing.status === 'resolved') {
      existing.status = 'open';
      existing.resolvedAt = undefined;
    }
  } else {
    entries.set(key, {
      key,
      type: finding.type,
      severity: finding.severity,
      filePath: finding.filePath,
      line: finding.line,
      description: finding.description,
      firstSeenAt: now,
      lastSeenAt: now,
      detectionCount: 1,
      status: 'open',
    });
  }

  persistToDisk();
}

/**
 * Mark any open entries that weren't seen in this scan cycle as resolved.
 * Called after all scanners have run for a cycle.
 */
export function markMissingAsResolved(): void {
  loadFromDisk();

  const now = Date.now();
  let changed = false;

  for (const [key, entry] of entries) {
    if (entry.status === 'open' && !cycleKeys.has(key)) {
      entry.status = 'resolved';
      entry.resolvedAt = now;
      changed = true;
    }
  }

  // Clear cycle keys for the next cycle
  cycleKeys.clear();

  if (changed) persistToDisk();
}

/**
 * Start a new scan cycle — clear the cycleKeys set so markMissingAsResolved
 * can track which findings were seen this cycle.
 */
export function startCycle(): void {
  cycleKeys.clear();
}

// ── Query surface ───────────────────────────────────────────────────────

/**
 * Get all open findings (status='open').
 */
export function getOpenFindings(): LedgerEntry[] {
  loadFromDisk();
  return [...entries.values()].filter((e) => e.status === 'open');
}

/**
 * Get open findings older than the given number of days (by firstSeenAt).
 */
export function getStaleFindings(daysThreshold: number): LedgerEntry[] {
  loadFromDisk();
  const cutoff = Date.now() - daysThreshold * 24 * 60 * 60 * 1000;
  return [...entries.values()].filter(
    (e) => e.status === 'open' && e.firstSeenAt < cutoff
  );
}

/**
 * Get open findings with detectionCount >= minCount (recurring problems).
 */
export function getRecurringFindings(minCount: number): LedgerEntry[] {
  loadFromDisk();
  return [...entries.values()].filter(
    (e) => e.status === 'open' && e.detectionCount >= minCount
  );
}

/**
 * Get all entries (open + resolved) — for debugging / full-state inspection.
 */
export function getAllFindings(): LedgerEntry[] {
  loadFromDisk();
  return [...entries.values()];
}

/**
 * Clear all entries (for tests). Also deletes the file.
 */
export function clear(): void {
  entries.clear();
  cycleKeys.clear();
  loaded = true;
  try {
    if (existsSync(LEDGER_FILE)) {
      writeFileSync(LEDGER_FILE, '', 'utf8');
    }
  } catch {
    // ignore
  }
}

/**
 * Force a reload from disk (for tests that simulate a process restart).
 */
export function reloadFromDisk(): void {
  entries.clear();
  cycleKeys.clear();
  loaded = false;
  loadFromDisk();
}

// ── Test exports ────────────────────────────────────────────────────────

export const __test__ = {
  recordFinding,
  markMissingAsResolved,
  startCycle,
  getOpenFindings,
  getStaleFindings,
  getRecurringFindings,
  getAllFindings,
  clear,
  reloadFromDisk,
  buildKey,
  LEDGER_FILE,
};
