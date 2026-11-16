// server/src/observability/logger.ts
//
// Structured logging for the Code Siren backend.
//
// Exports:
//   logger        — root pino instance (JSON in production, pretty in dev)
//   childLogger   — create a request/session-scoped child logger
//   captureError  — log an error structurally AND forward to Sentry if
//                   SENTRY_DSN is set (no-op otherwise)
//
// WHY THIS EXISTS
// The server had ~250 console.log/warn/error calls across 40+ files.
// Console output is unstructured, has no levels, no request IDs, and no
// downstream sink. Pino emits newline-delimited JSON that any log shipper
// (Loki, Elasticsearch, Datadog) can ingest without parsing.
//
// This module is the single point where log format is decided. Files that
// import { logger } get JSON in production and colorized pretty output in
// dev — they never need to know which transport is active.
//
// SENTRY
// @sentry/node is an optional dependency. If SENTRY_DSN is set in the
// environment, captureError() dynamically imports @sentry/node and forwards
// the error. If the package isn't installed, the import fails and we log a
// warning — the app keeps running, just without Sentry. This keeps Sentry
// out of the default install for users who don't want it.

import pino from 'pino';
import { config } from '../config.js';

// ── Root logger ────────────────────────────────────────────────────────
//
// In development/test: pino-pretty gives colorized, human-readable output
//   with the time, level, and message on one line and nested fields
//   indented below.
// In production: raw JSON to stdout (one object per line). A log shipper
//   like Fluent Bit or Vector can forward these to Loki/ES/Datadog without
//   a parsing step.
const isDev = config.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  base: {
    service: 'code-siren-server',
    env: config.NODE_ENV,
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
        },
      }
    : {}),
});

// ── Child logger ───────────────────────────────────────────────────────
//
// Create a request-scoped logger that automatically includes the request ID
// and/or session ID in every line. Use in route handlers:
//
//   const log = childLogger({ requestId: req.id, userId: claims.sub });
//   log.info({ path: req.path }, 'incoming request');

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

// ── Error capture (Sentry hook) ────────────────────────────────────────
//
// captureError(err, context?) does two things:
//   1. Logs the error at 'error' level with structured context.
//   2. If SENTRY_DSN is set, forwards to Sentry (dynamic import so
//      @sentry/node stays optional).
//
// The Sentry import is lazy and cached — the first error after SENTRY_DSN
// is set pays the import cost; subsequent calls reuse the cached module.

let sentryModule: any | null = null;
let sentryInitAttempted = false;

async function getSentry(): Promise<any | null> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  if (sentryInitAttempted) return sentryModule;
  sentryInitAttempted = true;
  try {
    // Dynamic import — @sentry/node is an optional dep. If not installed,
    // this throws and we fall back to log-only. The @ts-expect-error is
    // intentional: @sentry/node isn't in package.json deps (it's optional),
    // so TypeScript can't resolve its types — but the runtime import is
    // wrapped in try/catch.
    // @ts-expect-error — optional dependency, not installed by default
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn,
      environment: config.NODE_ENV,
      // Don't spam Sentry in dev/test — only capture production errors.
      beforeSend(event: any) {
        if (config.NODE_ENV !== 'production') return null;
        return event;
      },
    });
    sentryModule = Sentry;
    logger.info({ dsn: dsn.slice(0, 20) + '...' }, 'Sentry initialized');
    return sentryModule;
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      'SENTRY_DSN is set but @sentry/node is not installed — run `npm install @sentry/node` to enable error tracking. Falling back to log-only.',
    );
    return null;
  }
}

/**
 * Capture an error: log it structurally AND forward to Sentry if configured.
 *
 * @param err    the Error (or anything throwable)
 * @param context  optional structured fields (requestId, userId, etc.)
 */
export async function captureError(
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(
    {
      err: { message: error.message, stack: error.stack, name: error.name },
      ...context,
    },
    error.message,
  );

  const Sentry = await getSentry();
  if (Sentry) {
    Sentry.captureException(error, {
      extra: context,
    });
  }
}

// ── Express error handler ──────────────────────────────────────────────
//
// Drop-in error handler for Express 5. Place AFTER all routes:
//
//   app.use(errorHandler);
//
// Logs the error with request context and returns a 500 JSON response.
// In development, includes the stack trace in the response body.
export function errorHandler(err: any, req: any, res: any, _next: any): void {
  captureError(err, {
    requestId: req.id,
    method: req.method,
    path: req.path,
    userId: req.claims?.sub,
  }).catch(() => {});

  const isProd = config.NODE_ENV === 'production';
  res.status(err.status ?? 500).json({
    error: err.code ?? 'INTERNAL_ERROR',
    message: err.message ?? 'An unexpected error occurred',
    ...(isProd ? {} : { stack: err.stack }),
  });
}
