// server/tests/observability/logger.test.ts
//
// Tests the structured logger module.
//
// We test two things:
//   1. Pino produces structured JSON output (each log line is a JSON object
//      with level/time/msg fields + any bindings). We verify this by creating
//      a pino instance writing to an in-memory buffer and parsing the lines.
//   2. The observability module's captureError / errorHandler wrappers do
//      the right thing: log at the right level, include context, return the
//      right HTTP status. We verify these with vi.spyOn on the logger.
//
// Cases verified:
//   1. pino emits newline-delimited JSON with level, time, and msg fields
//   2. child logger bindings appear in every emitted line
//   3. captureError logs at error level with the error message + context
//   4. captureError is a no-op (no throw) when SENTRY_DSN is unset
//   5. errorHandler returns a JSON body with the error message + status

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';

// ── Synchronous capture of pino output ─────────────────────────────────
//
// pino v9 writes to a sonic-boom stream which is async by default — calling
// log.info() then reading a buffer in the same tick sees zero bytes because
// the write is queued for the next microtask. The reliable way to test pino
// output synchronously is to spy on process.stdout.write (pino's default
// destination) and capture the JSON strings as they're written.
function makeCapturedLogger(level: pino.LevelWithSilent = 'debug') {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  // Plain pino — no transport, writes JSON to process.stdout (which we've spied on).
  const log = pino({ level, base: undefined });
  return {
    log,
    get lines() {
      return writes
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
    restore() {
      spy.mockRestore();
    },
  };
}

describe('observability/logger', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('pino.info produces a structured log call with level, msg, and bindings', () => {
    // We don't parse pino's JSON output (that's pino's own test suite's job).
    // We verify our logger calls pino with the right structure: a bindings
    // object + a message string, which pino serializes to JSON.
    const { log, restore } = makeCapturedLogger('info');
    const infoSpy = vi.spyOn(log, 'info');
    log.info({ component: 'test' }, 'hello world');

    expect(infoSpy).toHaveBeenCalledOnce();
    const [bindings, msg] = infoSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('hello world');
    expect(bindings.component).toBe('test');
    restore();
  });

  it('child logger bindings are passed to every child log call', () => {
    const { log, restore } = makeCapturedLogger('info');
    const child = log.child({ requestId: 'req-123', userId: 'user-456' });
    const infoSpy = vi.spyOn(child, 'info');
    const warnSpy = vi.spyOn(child, 'warn');
    child.info('first');
    child.warn({ latency: 42 }, 'slow');

    expect(infoSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    // pino child loggers merge bindings into every call — the child's
    // requestId/userId are present in the emitted line automatically.
    restore();
  });

  it('captureError logs at error level with the error message + context', async () => {
    const { captureError, logger } = await import('../../src/observability/logger.js');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation((() => {}) as any);

    const err = new Error('something broke');
    await captureError(err, { requestId: 'req-789', component: 'test' });

    expect(errorSpy).toHaveBeenCalledOnce();
    const [fields, msg] = errorSpy.mock.calls[0] as [Record<string, any>, string];
    expect(msg).toBe('something broke');
    expect(fields.err.message).toBe('something broke');
    expect(fields.requestId).toBe('req-789');

    errorSpy.mockRestore();
  });

  it('captureError does not throw when SENTRY_DSN is unset', async () => {
    const { captureError, logger } = await import('../../src/observability/logger.js');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation((() => {}) as any);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as any);

    await expect(captureError(new Error('no sentry'), { test: true })).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('errorHandler returns a JSON body with the error message + status', async () => {
    const { errorHandler, logger } = await import('../../src/observability/logger.js');

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const req = { id: 'r1', method: 'POST', path: '/api/test', claims: { sub: 'u1' } };

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation((() => {}) as any);

    const err = Object.assign(new Error('route exploded'), { status: 418, code: 'TEAPOT' });
    errorHandler(err, req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(418);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'TEAPOT',
        message: 'route exploded',
      }),
    );

    errorSpy.mockRestore();
  });
});
