// server/src/routes/providers.ts
// API Hub REST routes.
//
// Phase 3 (current):
//   GET    /api/hub                       — list all providers (grouped by category on the client)
//   GET    /api/hub/:id                   — get one provider
//   POST   /api/hub/:id/test              — "Test & load" — hits the real provider endpoint
//   PATCH  /api/hub/:id                   — update apiUrl / apiKey for a provider
//   POST   /api/hub/:id/select-voice      — select a voice system-wide (TTS only)
//   POST   /api/hub/:id/reset-key         — Phase 3: fully clear the API key + all loaded state
//   DELETE /api/hub/:id                   — Phase 3: delete a custom provider (built-ins cannot be deleted)
//   POST   /api/hub/onboard               — onboard a custom provider (with auto-classification)
//   POST   /api/hub/test-url              — Phase 3: pre-onboarding URL probe with shape detection
//
// For backward compatibility, the old /api/providers/* routes are also mounted
// (see server.ts). New code should use /api/hub/*.
//
// All routes require auth. API keys are returned to the frontend masked
// (only whether they're set, not the actual value) — EXCEPT when the user
// is actively editing them via PATCH.

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import {
  listProviders,
  getProvider,
  updateProviderConfig,
  testAndLoadModels,
  selectVoice,
  onboardCustomProvider,
  classifyProvider,
  deleteProvider,
  clearProviderKey,
  testCustomProviderUrl,
} from '../provider-registry/registry.js';
import { runHealthCheckNow } from '../provider-registry/health-check.js';
import { sidecarManager, ensureKokoroSidecar, SidecarCrashedError } from '../sidecars/manager.js';
import type { ProviderRegistryEntry, ProviderCategory, OnboardingAnswer } from '../provider-registry/types.js';

export const providersRouter = Router();

/**
 * Mask an API key for display — shows whether it's set without revealing the value.
 * Returns '••••••••' (8 dots) if set, empty string if not.
 */
function maskApiKey(key: string): string {
  return key ? '••••••••' : '';
}

/**
 * Serialize a provider entry for the API response.
 * Masks the API key — the frontend never sees the actual key value via GET.
 * (PATCH accepts a new key value; the user is explicitly setting it.)
 *
 * Phase 3: includes the new health-check fields (healthy, lastHealthCheckAt,
 * suggestedAction) + isCustom flag (so the UI can show a "Delete" button only
 * on custom providers) + infoEndpoints (Information category).
 */
function serializeProvider(entry: ProviderRegistryEntry) {
  return {
    id: entry.id,
    category: entry.category,
    displayName: entry.displayName,
    defaultApiUrl: entry.defaultApiUrl,
    apiUrl: entry.apiUrl,
    apiKeyMasked: maskApiKey(entry.apiKey),
    apiKeyIsSet: !!entry.apiKey,
    connectionTested: entry.connectionTested,
    models: entry.models,
    voices: entry.voices,
    tools: entry.tools,
    imageModels: entry.imageModels,
    infoEndpoints: entry.infoEndpoints,
    selectedVoiceId: entry.selectedVoiceId,
    lastError: entry.lastError,
    lastLoadedAt: entry.lastLoadedAt,
    // Phase 3 fields
    isCustom: entry.isCustom,
    healthy: entry.healthy,
    lastHealthCheckAt: entry.lastHealthCheckAt,
    suggestedAction: entry.suggestedAction,
    // Convenience counts for the UI
    modelCount: entry.models.length,
    voiceCount: entry.voices.length,
    toolCount: entry.tools.length,
    imageModelCount: entry.imageModels.length,
    infoEndpointCount: entry.infoEndpoints.length,
  };
}

// GET /api/hub — list all
providersRouter.get('/', requireAuth, (_req, res) => {
  const providers = listProviders().map(serializeProvider);
  res.json({ providers });
});

// GET /api/hub/:id — get one
providersRouter.get('/:id', requireAuth, (req, res) => {
  const entry = getProvider(req.params.id);
  if (!entry) {
    res.status(404).json({ error: `Unknown provider: ${req.params.id}` });
    return;
  }
  res.json({ provider: serializeProvider(entry) });
});

// POST /api/hub/:id/test — "Test & load models"
providersRouter.post('/:id/test', requireAuth, async (req, res) => {
  const providerId = req.params.id;
  const entry = getProvider(providerId);
  if (!entry) {
    res.status(404).json({ error: `Unknown provider: ${providerId}` });
    return;
  }

  // If the user sent a new apiKey in the body, apply it before testing.
  // This allows the "Test" button to work even if the user hasn't saved yet.
  if (typeof req.body?.apiKey === 'string' && req.body.apiKey) {
    updateProviderConfig(providerId, { apiKey: req.body.apiKey });
  }
  if (typeof req.body?.apiUrl === 'string' && req.body.apiUrl) {
    updateProviderConfig(providerId, { apiUrl: req.body.apiUrl });
  }

  const result = await testAndLoadModels(providerId);

  // Re-fetch the updated entry for the response
  const updated = getProvider(providerId)!;
  res.json({
    success: result.success,
    provider: serializeProvider(updated),
    modelsLoaded: result.models.length,
    voicesLoaded: result.voices.length,
    toolsLoaded: result.tools.length,
    imageModelsLoaded: result.imageModels.length,
    infoEndpointsLoaded: result.infoEndpoints.length,
    error: result.error,
    durationMs: result.durationMs,
  });
});

// PATCH /api/hub/:id — update apiUrl / apiKey
providersRouter.patch('/:id', requireAuth, (req, res) => {
  const providerId = req.params.id;
  const entry = getProvider(providerId);
  if (!entry) {
    res.status(404).json({ error: `Unknown provider: ${providerId}` });
    return;
  }

  const patch: { apiUrl?: string; apiKey?: string } = {};
  if (typeof req.body?.apiUrl === 'string') patch.apiUrl = req.body.apiUrl;
  if (typeof req.body?.apiKey === 'string') patch.apiKey = req.body.apiKey;

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'No fields to update — send apiUrl or apiKey in the body' });
    return;
  }

  const updated = updateProviderConfig(providerId, patch);
  res.json({ provider: serializeProvider(updated!) });
});

// POST /api/hub/:id/select-voice — select a voice system-wide (TTS category only)
providersRouter.post('/:id/select-voice', requireAuth, async (req, res) => {
  const providerId = req.params.id;
  const voiceId = req.body?.voiceId;
  if (typeof voiceId !== 'string' || !voiceId) {
    res.status(400).json({ error: 'Missing voiceId in body' });
    return;
  }

  const entry = getProvider(providerId);
  if (!entry) {
    res.status(404).json({ error: `Unknown provider: ${providerId}` });
    return;
  }
  if (entry.category !== 'tts') {
    res.status(400).json({ error: `Provider ${providerId} is not a TTS provider (category: ${entry.category})` });
    return;
  }

  const result = await selectVoice(providerId, voiceId);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  const updated = getProvider(providerId)!;
  res.json({ success: true, provider: serializeProvider(updated) });
});

// POST /api/hub/:id/reset-key — Phase 3: fully clear the API key
// Per the user's directive: "when the user resets a key, the key is fully gone
// and the system does not have any key until a new one is present."
providersRouter.post('/:id/reset-key', requireAuth, (req, res) => {
  const providerId = req.params.id;
  const result = clearProviderKey(providerId);
  if (!result.success) {
    res.status(404).json({ error: result.error });
    return;
  }
  const updated = getProvider(providerId)!;
  res.json({ success: true, provider: serializeProvider(updated) });
});

// POST /api/hub/:id/health-check — Phase 3: manually trigger a health check
providersRouter.post('/:id/health-check', requireAuth, async (req, res) => {
  const providerId = req.params.id;
  const entry = getProvider(providerId);
  if (!entry) {
    res.status(404).json({ error: `Unknown provider: ${providerId}` });
    return;
  }
  await runHealthCheckNow(providerId);
  const updated = getProvider(providerId)!;
  res.json({ success: true, provider: serializeProvider(updated) });
});

// DELETE /api/hub/:id — Phase 3: delete a custom provider
// Built-in providers cannot be deleted (use reset-key instead).
providersRouter.delete('/:id', requireAuth, (req, res) => {
  const providerId = req.params.id;
  const result = deleteProvider(providerId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ success: true, message: `Provider ${providerId} deleted.` });
});

// POST /api/hub/onboard — onboard a custom provider
// Body: { displayName, apiUrl, apiKey?, whatDoesItDo }
// whatDoesItDo is classified into a category via classifyProvider().
// For TTS providers, apiUrl may be empty (skipped per spec).
providersRouter.post('/onboard', requireAuth, (req, res) => {
  const { displayName, apiUrl, apiKey, whatDoesItDo } = req.body ?? {};

  if (typeof displayName !== 'string' || !displayName.trim()) {
    res.status(400).json({ error: 'Missing displayName' });
    return;
  }
  const validAnswers: OnboardingAnswer[] = [
    'generate-text',
    'generate-speech',
    'execute-tools',
    'generate-images',
    'fetch-information', // Phase 3 — new
  ];
  if (!validAnswers.includes(whatDoesItDo)) {
    res.status(400).json({
      error: `Invalid whatDoesItDo — must be one of: ${validAnswers.join(', ')}`,
    });
    return;
  }

  // Classify the provider into a category. Phase 3: classifyProvider now
  // returns { category, warning } — the warning is non-null when the user's
  // answer contradicts the URL probe's detectedCategory (if provided).
  const detectedCategory = typeof req.body?.detectedCategory === 'string' ? (req.body.detectedCategory as ProviderCategory) : undefined;
  const classification = classifyProvider({ whatDoesItDo, detectedCategory });

  // TTS providers may skip the URL (per spec)
  const finalApiUrl = typeof apiUrl === 'string' ? apiUrl : '';

  // Onboard the custom provider
  const entry = onboardCustomProvider({
    displayName: displayName.trim(),
    category: classification.category,
    apiUrl: finalApiUrl,
    apiKey: typeof apiKey === 'string' ? apiKey : '',
  });

  res.status(201).json({
    success: true,
    provider: serializeProvider(entry),
    category: classification.category,
    warning: classification.warning, // null when no mismatch
    message: `Custom provider "${displayName}" onboarded as ${classification.category}. It now appears in the API Hub under the ${classification.category} category and can be tested/loaded like any preset provider.`,
  });
});

// POST /api/hub/kokoro-status — Phase 3: check if Kokoro model is downloaded + loaded
// Returns { running: bool, modelLoaded: bool }
// Does NOT trigger a download — just pings the sidecar (spawns it if not running).
providersRouter.post('/kokoro-status', requireAuth, async (_req, res) => {
  try {
    ensureKokoroSidecar();
    const result = await sidecarManager.request('kokoro', { type: 'ping' }, 5_000);
    res.json({
      running: true,
      modelLoaded: !!(result as { modelLoaded?: boolean }).modelLoaded,
    });
  } catch (err: any) {
    // Sidecar not running, crashed, or timed out — return a graceful status
    res.json({
      running: false,
      modelLoaded: false,
      error: err?.message ?? String(err),
    });
  }
});

// POST /api/hub/kokoro-download — Phase 3: trigger Kokoro model download + load
// Per the user's directive: "the user can start a download from there and then
// the user can use his offline voice for normal use".
//
// This route is LONG-RUNNING (5-30s for download, ~5s for load). The client
// should show a spinner / progress indicator while the request is in-flight.
// We do NOT stream progress (HuggingFace's download progress isn't easily
// piped through the sidecar protocol); instead, the client polls
// /kokoro-status to see when modelLoaded becomes true.
providersRouter.post('/kokoro-download', requireAuth, async (req, res) => {
  // Optional: client can send { wait: true } to wait for the preload to finish
  // before responding. Default: wait=true (the UI shows a spinner).
  const wait = req.body?.wait !== false;
  try {
    ensureKokoroSidecar();
    if (wait) {
      // Long timeout — model download + load can take up to 5 minutes on slow
      // connections. Pre-load is idempotent (if already loaded, returns immediately).
      const result = await sidecarManager.request('kokoro', { type: 'preload' }, 5 * 60_000);
      res.json({
        success: true,
        modelLoaded: !!(result as { modelLoaded?: boolean }).modelLoaded,
        message: (result as { message?: string }).message ?? 'Kokoro model loaded.',
      });
    } else {
      // Fire-and-forget — kick off the preload but don't wait for it.
      // The client can poll /kokoro-status to track progress.
      sidecarManager.request('kokoro', { type: 'preload' }, 5 * 60_000)
        .then(() => console.log('[kokoro] background preload complete'))
        .catch((err) => console.warn('[kokoro] background preload failed:', err?.message ?? err));
      res.json({
        success: true,
        message: 'Download started. Poll /api/hub/kokoro-status to track progress.',
      });
    }
  } catch (err: any) {
    if (err instanceof SidecarCrashedError) {
      res.status(500).json({
        success: false,
        error: `Kokoro sidecar crashed during preload: ${err.message}`,
        suggestedAction: 'The Kokoro Python sidecar crashed. Check that Python 3 + pip are installed, then run "npm run kokoro:setup" from the server directory to install dependencies.',
      });
    } else {
      res.status(500).json({
        success: false,
        error: err?.message ?? String(err),
        suggestedAction: 'Failed to start the Kokoro download. Check that Python 3 is installed and reachable.',
      });
    }
  }
});

// POST /api/hub/test-url — Phase 3: pre-onboarding URL probe
// Body: { apiUrl, apiKey?, claimedCategory? }
// Probes the URL with a lightweight GET request + tries to detect what kind
// of API it is based on the response shape. Returns the detected category +
// a sample of the response so the user can confirm before onboarding.
providersRouter.post('/test-url', requireAuth, async (req, res) => {
  const { apiUrl, apiKey, claimedCategory } = req.body ?? {};

  if (typeof apiUrl !== 'string' || !apiUrl.trim()) {
    res.status(400).json({ error: 'Missing apiUrl' });
    return;
  }

  const result = await testCustomProviderUrl({
    apiUrl: apiUrl.trim(),
    apiKey: typeof apiKey === 'string' ? apiKey : undefined,
    claimedCategory: typeof claimedCategory === 'string' ? (claimedCategory as ProviderCategory) : undefined,
  });

  res.json(result);
});
