// server/src/middleware/error-handler.ts
// Error boundary + structured error responses + request timeout.

import type { Request, Response, NextFunction } from 'express';
import { logSecurityEvent } from '../monitoring/security-log.js';
import { logger, captureError } from '../observability/logger.js';

const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS ?? '30000', 10);

// ── Request timeout middleware ───────────────────────────────────────────

export function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      logSecurityEvent({
        type: 'request-rejected',
        severity: 'medium',
        ip: req.ip,
        endpoint: req.path,
        method: req.method,
        description: `Request timeout after ${REQUEST_TIMEOUT_MS}ms: ${req.method} ${req.path}`,
      });
      res.status(504).json({
        error: 'Request timeout',
        code: 'TIMEOUT',
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
  }, REQUEST_TIMEOUT_MS);

  // Clear timeout when response finishes
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));

  next();
}

// ── Error boundary — catches all unhandled errors ────────────────────────
//
// Uses the structured logger (pino JSON) instead of console.error, and
// forwards to Sentry when SENTRY_DSN is set (no-op otherwise). The
// captureError call is fire-and-forget — the HTTP response is sent
// synchronously without waiting for the Sentry network round-trip.

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  // Structured log + Sentry forward (async, fire-and-forget)
  captureError(err, {
    method: req.method,
    path: req.path,
    ip: req.ip,
  }).catch((e) => logger.warn({ err: (e as Error).message }, 'captureError failed in errorHandler'));

  // Log security event for unexpected errors
  logSecurityEvent({
    type: 'request-rejected',
    severity: 'high',
    ip: req.ip,
    endpoint: req.path,
    method: req.method,
    description: `Unhandled error: ${err.message}`,
    meta: { stack: err.stack?.slice(0, 500) },
  });

  // Don't leak internals in production
  const isDev = process.env.NODE_ENV !== 'production';
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL',
      ...(isDev ? { message: err.message, stack: err.stack?.slice(0, 500) } : {}),
    });
  }
}

// ── 404 handler ──────────────────────────────────────────────────────────

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND',
    path: req.path,
  });
}
