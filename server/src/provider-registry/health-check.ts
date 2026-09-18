// server/src/provider-registry/health-check.ts
// Phase 3 — Background health-check cycle for the API Hub.
//
// Per the user's directive:
//   "lets put some intelligence let say when the key has expired and it cant
//    do anything the system flags it as a problem and suggest you the suitable
//    action to do and this can be done by testing it in the background in cycles"
//
// Every HEALTH_CHECK_INTERVAL_MS, this module:
//   1. Iterates all providers that have an apiKey set
//   2. Calls testAndLoadModels() on each (silently — errors don't propagate)
//   3. Updates each entry's healthy / lastHealthCheckAt / suggestedAction fields
//   4. Logs a summary
//
// The cycle is started lazily (on first listProviders() call from a route) and
// runs for the lifetime of the server process. It does NOT run during tests
// (the test environment sets DISABLE_HEALTH_CHECK=1).
//
// A user can also trigger an immediate health-check via POST /api/hub/:id/health-check.

import { listProviders, getProvider, testAndLoadModels } from './registry.js';
import type { ProviderRegistryEntry } from './types.js';

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_BATCH_DELAY_MS = 500; // stagger checks to avoid burst

let intervalHandle: NodeJS.Timeout | null = null;
let cycleRunning = false;

/**
 * Run a health check on a single provider. Updates the entry in-place.
 * Silent — catches all errors and writes them to the entry's lastError /
 * suggestedAction fields.
 */
export async function runHealthCheckNow(providerId: string): Promise<void> {
  const entry = getProvider(providerId);
  if (!entry) return;

  // Skip providers with no API key (nothing to test)
  if (!entry.apiKey && entry.id !== 'kokoro' && entry.id !== 'code-siren-tools') {
    entry.healthy = false;
    entry.lastHealthCheckAt = Date.now();
    entry.suggestedAction = 'No API key set. Enter your API key and run "Test & load" to activate this provider.';
    return;
  }

  // Run the test-and-load. testAndLoadModels already updates the entry's
  // healthy / lastError / suggestedAction fields on success/failure.
  try {
    await testAndLoadModels(providerId);
  } catch (err: any) {
    // Should not happen — testAndLoadModels catches internally — but just in case
    entry.healthy = false;
    entry.lastError = err?.message ?? String(err);
    entry.suggestedAction = 'Health check failed unexpectedly. Check the error message and try the "Test & load" button.';
  }
  entry.lastHealthCheckAt = Date.now();
}

/**
 * Run a health check on all configured providers (those with an API key set).
 * Staggered to avoid a burst of outbound requests.
 */
export async function runHealthCheckCycle(): Promise<void> {
  if (cycleRunning) return; // prevent overlap
  cycleRunning = true;
  try {
    const providers = listProviders();
    const configured = providers.filter((p) => p.apiKey || p.id === 'kokoro' || p.id === 'code-siren-tools');
    if (configured.length === 0) return;

    console.log(`[health-check] running cycle for ${configured.length} configured provider(s)`);
    let healthy = 0;
    let unhealthy = 0;
    for (const p of configured) {
      await runHealthCheckNow(p.id);
      const updated = getProvider(p.id);
      if (updated?.healthy) healthy++; else unhealthy++;
      // Stagger to avoid burst
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_BATCH_DELAY_MS));
    }
    console.log(`[health-check] cycle complete: ${healthy} healthy, ${unhealthy} unhealthy`);
  } finally {
    cycleRunning = false;
  }
}

/**
 * Start the background health-check cycle. Called once on server startup.
 * No-op if DISABLE_HEALTH_CHECK is set (test environment).
 */
export function startHealthCheckCycle(): void {
  if (process.env.DISABLE_HEALTH_CHECK === '1') {
    console.log('[health-check] cycle disabled (DISABLE_HEALTH_CHECK=1)');
    return;
  }
  if (intervalHandle) return; // already started
  console.log(`[health-check] cycle started (interval: ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
  // Run an initial cycle shortly after startup (don't block startup)
  setTimeout(() => { void runHealthCheckCycle(); }, 10_000);
  // Schedule recurring cycles
  intervalHandle = setInterval(() => {
    void runHealthCheckCycle().catch((err) => {
      console.warn(`[health-check] cycle error:`, err);
    });
  }, HEALTH_CHECK_INTERVAL_MS);
  // Allow Node to exit even if the interval is still running
  if (intervalHandle.unref) intervalHandle.unref();
}

/**
 * Stop the background health-check cycle. For tests.
 */
export function stopHealthCheckCycle(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[health-check] cycle stopped');
  }
}
