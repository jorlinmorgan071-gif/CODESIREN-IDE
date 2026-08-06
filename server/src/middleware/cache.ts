// server/src/middleware/cache.ts
// Phase 5 — Read-only GET response cache.
//
// Wraps existing GET endpoints with a short-TTL in-memory cache. Only caches
// 200 OK responses to GET requests. Does NOT mutate requests or responses —
// the cached body is returned verbatim with an `X-Cache: HIT` header.
//
// Cache key: `${method}:${userId}:${path}` — per-user to avoid leaking data
// across users (most dashboard endpoints include user-scoped data via
// requireAuth).
//
// Cache TTL: configurable per-endpoint, default 5s. The /api/dashboard/*
// endpoints get 10s by default (they're read-only aggregations that change
// slowly). Auth endpoints are NOT cached.
//
// Cache invalidation: time-based only (no event-based invalidation in Phase 5).
// A manual flush() is exposed for tests.

import type { Request, Response, NextFunction } from 'express';

interface CacheEntry {
  body: unknown;
  status: number;
  headers: Record<string, string>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Default TTLs per route prefix
const TTL_BY_PREFIX: Array<{ prefix: string; ttlMs: number }> = [
  { prefix: '/dashboard/system',       ttlMs: 5_000 },     // 5s — process.memoryUsage changes
  { prefix: '/dashboard/agents',       ttlMs: 10_000 },    // 10s — agent roster changes rarely
  { prefix: '/dashboard/execution',    ttlMs: 5_000 },     // 5s — new traces may arrive
  { prefix: '/dashboard/memory',       ttlMs: 10_000 },    // 10s — memory entries change slowly
  { prefix: '/dashboard/security',     ttlMs: 5_000 },     // 5s — security events change frequently
  { prefix: '/dashboard/models',       ttlMs: 30_000 },    // 30s — Ollama check is expensive (5ms)
  { prefix: '/dashboard/tools',        ttlMs: 60_000 },    // 60s — tool registry changes rarely
  { prefix: '/dashboard/traces-file',  ttlMs: 10_000 },    // 10s — file metadata
  { prefix: '/dashboard/traces',       ttlMs: 3_000 },     // 3s — traces change often
  { prefix: '/dashboard/performance',  ttlMs: 5_000 },     // 5s — derived from traces
  { prefix: '/health',                 ttlMs: 5_000 },     // 5s
];

const DEFAULT_TTL_MS = 5_000;

function getTtl(path: string): number {
  for (const { prefix, ttlMs } of TTL_BY_PREFIX) {
    if (path.startsWith(prefix)) return ttlMs;
  }
  return DEFAULT_TTL_MS;
}

// Metrics — exposed via getCacheStats()
let hits = 0;
let misses = 0;
let skips = 0;
let stores = 0;
let evictions = 0;

export function cacheMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only cache GET requests
  if (req.method !== 'GET') {
    next();
    return;
  }

  // Don't cache auth endpoints (tokens, users) — per-user data
  if (req.path.startsWith('/auth')) {
    next();
    return;
  }

  // Don't cache memory endpoints — per-user data that changes with every
  // memory:created / memory:deleted event. Caching would serve one user's
  // memories to another user.
  if (req.path.startsWith('/memory')) {
    next();
    return;
  }

  // Don't cache voice-live endpoints — per-user session state.
  if (req.path.startsWith('/voice/live')) {
    next();
    return;
  }

  // Don't cache avatar settings OR manifest — user preferences (selectedAvatarId,
  // pipEnabled, pipPosition) change with every POST, and the manifest changes
  // when custom avatars are uploaded/deleted/renamed. Caching causes stale
  // avatar selection and stale manifest reads.
  if (req.path.startsWith('/avatar/settings') || req.path.startsWith('/avatar/manifest') || req.path.startsWith('/avatar/custom')) {
    next();
    return;
  }

  // Don't cache if explicitly disabled via ?nocache=1
  if (req.query.nocache === '1' || req.query.nocache === 'true') {
    skips++;
    next();
    return;
  }

  const userId = req.user?.id ?? 'anonymous';
  const key = `${req.method}:${userId}:${req.originalUrl}`;
  const now = Date.now();

  // Check for hit
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) {
    hits++;
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-TTL', String(Math.ceil((entry.expiresAt - now) / 1000)));
    // Replay status + headers + body
    for (const [k, v] of Object.entries(entry.headers)) {
      res.setHeader(k, v);
    }
    res.status(entry.status).json(entry.body);
    return;
  }

  // Miss — let the request through, intercept the response
  misses++;

  // Capture the JSON response by overriding res.json
  const originalJson = res.json.bind(res);
  res.json = (body: unknown): Response => {
    // Only cache 200 OK responses
    if (res.statusCode === 200) {
      const ttl = getTtl(req.path);
      const expiresAt = now + ttl;
      // Capture select headers (content-type, etc.)
      const headers: Record<string, string> = {};
      const ct = res.getHeader('content-type');
      if (ct) headers['content-type'] = String(ct);

      cache.set(key, {
        body,
        status: res.statusCode,
        headers,
        expiresAt,
      });
      stores++;

      // Set cache headers
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-TTL', String(Math.ceil(ttl / 1000)));
    }
    return originalJson(body);
  };

  next();
}

// Lazy eviction — sweep expired entries every 60s
let sweepTimer: NodeJS.Timeout | null = null;
function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt < now) {
        cache.delete(key);
        evictions++;
      }
    }
  }, 60_000);
  // Don't keep Node alive just for the sweep
  sweepTimer.unref();
}
startSweep();

// ── Public API for stats + manual flush ──────────────────────────────────

export function getCacheStats() {
  return {
    hits,
    misses,
    skips,
    stores,
    evictions,
    hitRate: hits + misses > 0 ? hits / (hits + misses) : 0,
    activeEntries: cache.size,
  };
}

export function flushCache(): void {
  cache.clear();
}

// Reset metrics — used by tests
export function resetCacheMetrics(): void {
  hits = 0;
  misses = 0;
  skips = 0;
  stores = 0;
  evictions = 0;
}
