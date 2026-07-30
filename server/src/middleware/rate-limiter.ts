// server/src/middleware/rate-limiter.ts
// Rate limiting — per-IP and per-user, burst protection.
// Configurable via environment variables. Observable via security events.

import type { Request, Response, NextFunction } from 'express';
import type { WebSocket } from 'ws';
import { logSecurityEvent } from '../monitoring/security-log.js';

// ── Configuration (env-driven) ───────────────────────────────────────────

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10); // 1 min default
const MAX_REQUESTS_PER_IP = parseInt(process.env.RATE_LIMIT_PER_IP ?? '100', 10);
const MAX_REQUESTS_PER_USER = parseInt(process.env.RATE_LIMIT_PER_USER ?? '200', 10);
const WS_MAX_MESSAGES_PER_SEC = parseInt(process.env.RATE_LIMIT_WS_PER_SEC ?? '10', 10);

// ── In-memory rate limit store ───────────────────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, RateBucket>();
const userBuckets = new Map<string, RateBucket>();
const wsBuckets = new Map<string, number[]>(); // wsId → timestamps

function getBucket(store: Map<string, RateBucket>, key: string): RateBucket {
  const now = Date.now();
  let bucket = store.get(key);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    store.set(key, bucket);
  }
  return bucket;
}

// Cleanup old buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of ipBuckets) {
    if (bucket.resetAt < now) ipBuckets.delete(key);
  }
  for (const [key, bucket] of userBuckets) {
    if (bucket.resetAt < now) userBuckets.delete(key);
  }
  for (const [key, timestamps] of wsBuckets) {
    const fresh = timestamps.filter(t => t > now - 1000);
    if (fresh.length === 0) wsBuckets.delete(key);
    else wsBuckets.set(key, fresh);
  }
}, 300_000);

// ── Express middleware ───────────────────────────────────────────────────

export function rateLimitApi(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const userId = req.user?.id ?? 'anonymous';

  const ipBucket = getBucket(ipBuckets, ip);
  ipBucket.count++;

  if (ipBucket.count > MAX_REQUESTS_PER_IP) {
    logSecurityEvent({
      type: 'rate-limit-exceeded',
      severity: 'medium',
      ip,
      userId,
      endpoint: req.path,
      method: req.method,
      description: `IP rate limit: ${ipBucket.count}/${MAX_REQUESTS_PER_IP} on ${req.method} ${req.path}`,
      meta: { count: ipBucket.count, limit: MAX_REQUESTS_PER_IP },
    });
    res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_IP',
      retryAfter: Math.ceil((ipBucket.resetAt - Date.now()) / 1000),
    });
    return;
  }

  if (userId !== 'anonymous') {
    const userBucket = getBucket(userBuckets, userId);
    userBucket.count++;

    if (userBucket.count > MAX_REQUESTS_PER_USER) {
      logSecurityEvent({
        type: 'rate-limit-exceeded',
        severity: 'medium',
        ip,
        userId,
        endpoint: req.path,
        method: req.method,
        description: `User rate limit: ${userBucket.count}/${MAX_REQUESTS_PER_USER} on ${req.method} ${req.path}`,
        meta: { count: userBucket.count, limit: MAX_REQUESTS_PER_USER },
      });
      res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMIT_USER',
        retryAfter: Math.ceil((userBucket.resetAt - Date.now()) / 1000),
      });
      return;
    }
  }

  // Add rate limit headers
  res.setHeader('X-RateLimit-Limit', MAX_REQUESTS_PER_IP);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, MAX_REQUESTS_PER_IP - ipBucket.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(ipBucket.resetAt / 1000));

  next();
}

// ── WebSocket rate limiter ───────────────────────────────────────────────

export function wsRateLimit(wsId: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  let timestamps = wsBuckets.get(wsId) ?? [];
  // Keep only last 1 second
  timestamps = timestamps.filter(t => t > now - 1000);
  timestamps.push(now);
  wsBuckets.set(wsId, timestamps);

  if (timestamps.length > WS_MAX_MESSAGES_PER_SEC) {
    return { allowed: false, reason: `WS rate limit: ${timestamps.length} msgs/sec (limit: ${WS_MAX_MESSAGES_PER_SEC})` };
  }
  return { allowed: true };
}

// ── Stats endpoint ───────────────────────────────────────────────────────

export function getRateLimitStats() {
  return {
    config: {
      windowMs: WINDOW_MS,
      maxPerIp: MAX_REQUESTS_PER_IP,
      maxPerUser: MAX_REQUESTS_PER_USER,
      wsMaxPerSec: WS_MAX_MESSAGES_PER_SEC,
    },
    active: {
      ipBuckets: ipBuckets.size,
      userBuckets: userBuckets.size,
      wsBuckets: wsBuckets.size,
    },
  };
}
