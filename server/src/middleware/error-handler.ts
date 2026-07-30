// server/src/middleware/error-handler.ts
// Error boundary + structured error responses + request timeout.

import type { Request, Response, NextFunction } from 'express';
import { logSecurityEvent } from '../monitoring/security-log.js';

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

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  // Log the error
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

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
