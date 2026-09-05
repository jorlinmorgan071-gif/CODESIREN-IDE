// server/src/orchestration/engines/_retry.ts
// UPR Phase 1 Step 2a — Shared retry helper for the 4 cloud engines.
//
// Pre-Step-2a: only OrchestratorEngine (engine.ts:41-51) had retry logic.
// The 4 cloud engines in ModelRouter (OpenRouter, Anthropic, Groq, Ollama)
// had NO retry on 429/5xx — they just yielded an error delta and terminated.
// Section 0 finding #10 called this out as an asymmetry: orchestrator engines
// retry with exponential backoff, ModelRouter engines do not.
//
// Step 2a fix: port the BACKOFF_DELAYS_MS retry logic from engine.ts:41-51
// into this shared helper, then wire it into all 4 cloud engines.
//
// The helper is AbortSignal-aware (Step 2b will require this). For Step 2a
// the signal is optional — existing callers don't pass one. Step 2b will add
// the actual cap-at-remaining-time logic.
//
// Retry policy (mirrors engine.ts:88-134 exactly):
//   - 3 retries max
//   - Delays: 2s, 4s, 8s (exponential)
//   - Retryable: 429, 500, 502, 503, 504
//   - Network errors (fetch throws) are retryable

export const BACKOFF_DELAYS_MS = [2_000, 4_000, 8_000] as const;
export const MAX_RETRIES = BACKOFF_DELAYS_MS.length;

/**
 * Is this HTTP status code retryable?
 * 429 = rate limit. 500/502/503/504 = transient server errors worth one retry.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Sleep for `ms` milliseconds. Returns a Promise that resolves after the delay.
 * If an AbortSignal is supplied and aborts during the sleep, the Promise
 * rejects with an AbortError. Step 2b uses this to cap total retry time.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Result of a retryable attempt.
 * - `ok: true` + `value: T` — the operation succeeded, return this value.
 * - `ok: false` + `status: number` — the operation returned a non-retryable
 *   or exhausted-retries HTTP error. The caller should yield the error to
 *   the stream and terminate.
 * - `ok: false` + `networkError: string` — the operation threw a network
 *   error and retries were exhausted. The caller should yield the error.
 *
 * The caller decides what to do with the error — `withRetry` does NOT throw
 * on retry-exhausted. This is so streaming engines can yield an error delta
 * to the open AsyncGenerator instead of throwing and breaking the stream
 * abruptly.
 */
export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; status?: number; networkError?: string; attempts: number };

/**
 * Run an async operation with retry + exponential backoff.
 *
 * The operation returns either:
 *   - { ok: true; value: T } — succeeded, return value
 *   - { ok: false; status: number } — HTTP error with status code; retryable
 *     if isRetryableStatus(status) returns true
 *   - throws — network error; always retryable
 *
 * The helper handles the retry loop + backoff sleep. After MAX_RETRIES
 * attempts, returns the last failure as a RetryResult.
 *
 * `engineLabel` is used for log messages (e.g. 'anthropic', 'groq').
 *
 * `signal` is optional. If supplied, the helper checks it before each retry
 * sleep AND before each attempt. If the signal aborts, the helper returns
 * immediately with the current failure. Step 2b will pass the caller's
 * AbortSignal so retries don't blow past caller timeouts.
 */
export async function withRetry<T>(
  operation: () => Promise<{ ok: true; value: T } | { ok: false; status: number }>,
  opts: { engineLabel: string; signal?: AbortSignal },
): Promise<RetryResult<T>> {
  const { engineLabel, signal } = opts;
  let lastFailure: { status?: number; networkError?: string } = {};
  let attempts = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Check abort signal before each attempt
    if (signal?.aborted) {
      return { ok: false, ...lastFailure, attempts };
    }

    attempts++;
    try {
      const result = await operation();
      if (result.ok) {
        if (attempt > 0) {
          console.log(`[${engineLabel}] recovered after ${attempt} retry attempt(s)`);
        }
        return { ok: true, value: result.value, attempts };
      }

      // HTTP error
      lastFailure = { status: result.status };
      if (!isRetryableStatus(result.status) || attempt >= MAX_RETRIES) {
        // Non-retryable OR exhausted retries — return the failure
        return { ok: false, status: result.status, attempts };
      }
      // Retryable — back off and retry
      const delay = BACKOFF_DELAYS_MS[attempt];
      console.log(`[${engineLabel}] ${result.status} — backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      try {
        await sleep(delay, signal);
      } catch (abortErr) {
        // Sleep was aborted — return immediately
        return { ok: false, status: result.status, attempts };
      }
    } catch (err: any) {
      // Network error — always retryable
      lastFailure = { networkError: err?.message ?? String(err) };
      if (attempt >= MAX_RETRIES) {
        return { ok: false, networkError: lastFailure.networkError, attempts };
      }
      const delay = BACKOFF_DELAYS_MS[attempt];
      console.log(`[${engineLabel}] network error: ${lastFailure.networkError} — backing off ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      try {
        await sleep(delay, signal);
      } catch (abortErr) {
        return { ok: false, networkError: lastFailure.networkError, attempts };
      }
    }
  }

  // Should be unreachable, but for type safety
  return { ok: false, ...lastFailure, attempts };
}
