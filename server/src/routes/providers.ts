// server/src/routes/providers.ts
// UPR Phase 1 Step 3 — ProviderRegistry REST routes.
//
//   GET    /api/providers              — list all registered providers + their loaded models
//   POST   /api/providers/:id/test     — "Test & load models" — hits the real provider /models endpoint
//   PATCH  /api/providers/:id          — update apiUrl / apiKey for a provider
//
// All routes require auth. API keys are returned to the frontend masked
// (only whether they're set, not the actual value) — EXCEPT when the user
// is actively editing them via PATCH. This is acceptable for Phase 1's
// single-user dev model; a future phase may add server-side secret storage.

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listProviders, getProvider, updateProviderConfig, testAndLoadModels } from '../provider-registry/registry.js';
import type { ProviderRegistryEntry } from '../provider-registry/types.js';

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
    lastError: entry.lastError,
    lastLoadedAt: entry.lastLoadedAt,
    modelCount: entry.models.length,
  };
}

// GET /api/providers — list all
providersRouter.get('/', requireAuth, (_req, res) => {
  const providers = listProviders().map(serializeProvider);
  res.json({ providers });
});

// GET /api/providers/:id — get one
providersRouter.get('/:id', requireAuth, (req, res) => {
  const entry = getProvider(req.params.id);
  if (!entry) {
    res.status(404).json({ error: `Unknown provider: ${req.params.id}` });
    return;
  }
  res.json({ provider: serializeProvider(entry) });
});

// POST /api/providers/:id/test — "Test & load models"
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
    error: result.error,
    durationMs: result.durationMs,
  });
});

// PATCH /api/providers/:id — update apiUrl / apiKey
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
