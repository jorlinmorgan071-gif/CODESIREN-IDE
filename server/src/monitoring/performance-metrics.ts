// server/src/monitoring/performance-metrics.ts
// Phase 5 — Runtime performance telemetry.
//
// Captures per-request timing, maintains a latency histogram, logs slow
// requests, and exposes aggregate stats. Does NOT mutate requests or responses
// — only observes timing.
//
// Exposed via:
//   - getPerformanceMetrics() — aggregate stats (used by /api/dashboard/performance
//     in a future iteration; for now exposed via the new /api/performance/* routes)
//   - getSlowRequests() — last N slow requests
//   - latencyHistogram — bucketed counts for the latency distribution

import type { Request, Response, NextFunction } from 'express';

// ── Configuration ────────────────────────────────────────────────────────

const SLOW_THRESHOLD_MS = parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS ?? '500', 10);
const MAX_SLOW_REQUESTS = 200;       // ring buffer
const MAX_RECENT_REQUESTS = 1000;    // ring buffer for percentile calc

// Latency histogram buckets (ms) — powers of 2 plus a final overflow bucket
const HISTOGRAM_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// ── State ────────────────────────────────────────────────────────────────

interface RecentRequest {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  timestamp: number;
  userId?: string;
}

interface SlowRequest extends RecentRequest {
  threshold: number;
}

const recentRequests: RecentRequest[] = [];
const slowRequests: SlowRequest[] = [];

// Histogram state — one count per bucket + overflow
const histogram: number[] = new Array(HISTOGRAM_BUCKETS_MS.length + 1).fill(0);

// Aggregate counters
let totalRequests = 0;
let totalErrors = 0;
let totalDurationMs = 0;

// ── Histogram helpers ────────────────────────────────────────────────────

function bucketIndex(ms: number): number {
  for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i++) {
    if (ms <= HISTOGRAM_BUCKETS_MS[i]) return i;
  }
  return HISTOGRAM_BUCKETS_MS.length;  // overflow
}

// ── Middleware ───────────────────────────────────────────────────────────

export function performanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const userId = req.user?.id;

  // Hook into 'finish' to capture the timing
  res.on('finish', () => {
    const elapsedNs = process.hrtime.bigint() - start;
    const durationMs = Number(elapsedNs) / 1_000_000;

    // Note: we can't set headers here — they're already sent by the time
    // 'finish' fires. The timing is captured in metrics only.

    // Update histogram
    histogram[bucketIndex(durationMs)]++;

    // Update aggregate
    totalRequests++;
    totalDurationMs += durationMs;
    if (res.statusCode >= 500) totalErrors++;

    // Push to recent requests ring buffer
    const req_ : RecentRequest = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      timestamp: Date.now(),
      userId,
    };
    recentRequests.push(req_);
    if (recentRequests.length > MAX_RECENT_REQUESTS) recentRequests.shift();

    // Slow request logging
    if (durationMs > SLOW_THRESHOLD_MS) {
      const slow: SlowRequest = { ...req_, threshold: SLOW_THRESHOLD_MS };
      slowRequests.push(slow);
      if (slowRequests.length > MAX_SLOW_REQUESTS) slowRequests.shift();
      console.warn(
        `[perf] SLOW ${durationMs.toFixed(0)}ms ${req.method} ${req.path} → ${res.statusCode} (threshold=${SLOW_THRESHOLD_MS}ms)`
      );
    }
  });

  next();
}

// ── Query API ────────────────────────────────────────────────────────────

export function getPerformanceMetrics() {
  const avgMs = totalRequests > 0 ? totalDurationMs / totalRequests : 0;

  // Compute p50/p95/p99 from recentRequests
  const durations = recentRequests.map((r) => r.durationMs).sort((a, b) => a - b);
  const n = durations.length;
  const p = (pct: number) => n > 0 ? durations[Math.floor(n * pct)] : 0;

  return {
    total: totalRequests,
    errors: totalErrors,
    avgMs: Math.round(avgMs * 100) / 100,
    p50Ms: p(0.50),
    p95Ms: p(0.95),
    p99Ms: p(0.99),
    histogramBucketsMs: HISTOGRAM_BUCKETS_MS,
    histogram: [...histogram],
    histogramOverflow: histogram[histogram.length - 1],
    recentCount: recentRequests.length,
    slowCount: slowRequests.length,
    slowThresholdMs: SLOW_THRESHOLD_MS,
  };
}

export function getSlowRequests(limit = 50): SlowRequest[] {
  return slowRequests.slice(-limit).reverse();
}

export function getRecentRequests(limit = 100): RecentRequest[] {
  return recentRequests.slice(-limit).reverse();
}

export function resetPerformanceMetrics(): void {
  recentRequests.length = 0;
  slowRequests.length = 0;
  histogram.fill(0);
  totalRequests = 0;
  totalErrors = 0;
  totalDurationMs = 0;
}
