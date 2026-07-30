// server/src/middleware/circuit-breaker.ts
// Circuit breaker — prevents cascading failures when downstream services fail.
// Used for: Ollama, OpenRouter, sidecar calls.

type BreakerState = 'closed' | 'open' | 'half-open';

interface BreakerConfig {
  failureThreshold: number;  // open after this many failures
  resetTimeoutMs: number;    // try again after this long
  halfOpenMaxCalls: number;  // allow this many test calls in half-open
}

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 1,
};

interface BreakerState_ {
  state: BreakerState;
  failureCount: number;
  successCount: number;
  openedAt: number;
  halfOpenCalls: number;
}

const breakers = new Map<string, BreakerState_>();

function getBreaker(name: string): BreakerState_ {
  let b = breakers.get(name);
  if (!b) {
    b = { state: 'closed', failureCount: 0, successCount: 0, openedAt: 0, halfOpenCalls: 0 };
    breakers.set(name, b);
  }
  return b;
}

/**
 * Execute a function through the circuit breaker.
 * - closed: normal execution
 * - open: reject immediately (fail fast)
 * - half-open: allow limited test calls
 */
export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  config: Partial<BreakerConfig> = {},
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const b = getBreaker(name);

  // Check if we should transition open → half-open
  if (b.state === 'open' && Date.now() - b.openedAt > cfg.resetTimeoutMs) {
    b.state = 'half-open';
    b.halfOpenCalls = 0;
    console.log(`[circuit:${name}] open → half-open`);
  }

  // Reject if open
  if (b.state === 'open') {
    throw new Error(`Circuit breaker open: ${name} (retry in ${Math.ceil((cfg.resetTimeoutMs - (Date.now() - b.openedAt)) / 1000)}s)`);
  }

  // Limit half-open calls
  if (b.state === 'half-open' && b.halfOpenCalls >= cfg.halfOpenMaxCalls) {
    throw new Error(`Circuit breaker half-open: ${name} (test call in progress)`);
  }

  if (b.state === 'half-open') {
    b.halfOpenCalls++;
  }

  try {
    const result = await fn();

    // Success
    if (b.state === 'half-open') {
      b.state = 'closed';
      b.failureCount = 0;
      console.log(`[circuit:${name}] half-open → closed (recovered)`);
    }
    b.successCount++;
    return result;
  } catch (err) {
    b.failureCount++;

    if (b.state === 'half-open') {
      // Half-open failure → back to open
      b.state = 'open';
      b.openedAt = Date.now();
      console.log(`[circuit:${name}] half-open → open (test call failed)`);
    } else if (b.failureCount >= cfg.failureThreshold) {
      // Closed → open
      b.state = 'open';
      b.openedAt = Date.now();
      console.log(`[circuit:${name}] closed → open (${b.failureCount} failures)`);
    }

    throw err;
  }
}

export function getBreakerStats(): Record<string, { state: BreakerState; failures: number; successes: number }> {
  const result: Record<string, { state: BreakerState; failures: number; successes: number }> = {};
  for (const [name, b] of breakers) {
    result[name] = { state: b.state, failures: b.failureCount, successes: b.successCount };
  }
  return result;
}
