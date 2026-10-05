// server/src/orchestration/image-generation.ts
// UPR Phase 5 — Image/Video Generation Routing.
//
// Routes image/video generation requests through the ProviderRegistry —
// same pattern as text/vision routing. The active provider is whichever
// configured image-video provider has been tested + has an API key.
//
// Generation is exposed as a tool (image_gen) that any agent can call.
// The tool handles:
//   1. Finding a configured image-video provider
//   2. Calling the provider's real API
//   3. Returning the generated image as base64 (for direct-to-agent delivery)
//
// Approval: when the "allow every request this session" toggle is OFF,
// each generation request goes through Ghost Mode's reportFinding() +
// waitForApproval() pattern — same as fabrication/terminal agents.

import { listProviders, getProvider } from '../provider-registry/registry.js';
import type { ProviderRegistryEntry } from '../provider-registry/types.js';
import { ghostMode } from './ghost-mode.js';
import { addStep } from '../observability/traces.js';
import type { AgentTask } from '../types.js';

// ── Toggle state (in-memory, per-session) ──────────────────────────────

let allowEveryRequest = true; // default: on (zero friction)

export function setImageGenerationApprovalToggle(enabled: boolean): void {
  allowEveryRequest = enabled;
  console.log(`[image-gen] approval toggle: ${enabled ? 'ON (allow every request)' : 'OFF (require approval)'}`);
}

export function getImageGenerationApprovalToggle(): boolean {
  return allowEveryRequest;
}

// ── Find a configured image-video provider ────────────────────────────

export function findImageProvider(): {
  provider: ProviderRegistryEntry;
  modelId: string;
} | null {
  const providers = listProviders().filter(
    p => p.category === 'image-video' && p.connectionTested && p.apiKey && p.imageModels.length > 0
  );
  if (providers.length === 0) return null;

  // Use the first configured provider (user can select via the API Hub)
  const provider = providers[0];
  const model = provider.imageModels[0];
  return { provider, modelId: model.id };
}

// ── Generation result ──────────────────────────────────────────────────

export interface ImageGenerationResult {
  success: boolean;
  imageBase64?: string;
  imageUrl?: string;
  format: string;
  model: string;
  provider: string;
  error?: string;
}

// ── Generate image via the configured provider ────────────────────────

export async function generateImage(opts: {
  prompt: string;
  modelId?: string;
  size?: string;
}): Promise<ImageGenerationResult> {
  const found = findImageProvider();
  if (!found) {
    return {
      success: false,
      format: '',
      model: '',
      provider: '',
      error: 'No image/video provider is configured. Open Settings → API Hub → Image/Video API and click "Test & load" on a provider (OpenAI DALL·E, Gemini Imagen, MiniMax, WaveSpeed, or BytePlus Seedream). At least one provider must be tested + have an API key set.',
    };
  }

  const { provider, modelId } = found;
  const model = opts.modelId ?? modelId;

  try {
    const result = await callImageProvider(provider, model, opts.prompt, opts.size);
    return {
      ...result,
      model,
      provider: provider.id,
    };
  } catch (err: any) {
    return {
      success: false,
      format: '',
      model,
      provider: provider.id,
      error: err?.message ?? String(err),
    };
  }
}

// ── Provider-specific API calls ────────────────────────────────────────

async function callImageProvider(
  provider: ProviderRegistryEntry,
  model: string,
  prompt: string,
  size?: string,
): Promise<Omit<ImageGenerationResult, 'model' | 'provider'>> {
  switch (provider.id) {
    case 'openai-image':
      return callOpenAIImage(provider, model, prompt, size);
    case 'gemini-image':
      return callGeminiImage(provider, model, prompt);
    case 'minimax-image':
      return callMiniMaxImage(provider, model, prompt);
    case 'wavespeed':
      return callWaveSpeedImage(provider, model, prompt);
    case 'byteplus-seedream':
      return callBytePlusImage(provider, model, prompt);
    default:
      // Custom image-video provider — try OpenAI-compatible shape
      return callOpenAICompatibleImage(provider, model, prompt, size);
  }
}

// ── OpenAI DALL·E ──────────────────────────────────────────────────────
// POST https://api.openai.com/v1/images/generations
// Body: { model, prompt, n: 1, size: "1024x1024", response_format: "b64_json" }
// Response: { data: [{ b64_json: "..." }] }

async function callOpenAIImage(
  provider: ProviderRegistryEntry,
  model: string,
  prompt: string,
  size?: string,
): Promise<Omit<ImageGenerationResult, 'model' | 'provider'>> {
  const url = `${provider.apiUrl.replace(/\/+$/, '')}/images/generations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: size ?? '1024x1024',
      response_format: 'b64_json',
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`OpenAI image generation failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> };
  const image = data.data?.[0];
  if (!image) throw new Error('OpenAI returned no image data');

  return {
    success: true,
    imageBase64: image.b64_json,
    imageUrl: image.url,
    format: 'png',
  };
}

// ── Gemini / Imagen ────────────────────────────────────────────────────
// POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predict
// Body: { instances: [{ prompt }], parameters: { sampleCount: 1 } }
// Response: { predictions: [{ bytesBase64Encoded: "..." }] }

async function callGeminiImage(
  provider: ProviderRegistryEntry,
  model: string,
  prompt: string,
): Promise<Omit<ImageGenerationResult, 'model' | 'provider'>> {
  const url = `${provider.apiUrl.replace(/\/+$/, '')}/models/${model}:predict`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': provider.apiKey,
    },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1 },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`Gemini image generation failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { predictions?: Array<{ bytesBase64Encoded?: string }> };
  const prediction = data.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) throw new Error('Gemini returned no image data');

  return {
    success: true,
    imageBase64: prediction.bytesBase64Encoded,
    format: 'png',
  };
}

// ── MiniMax ────────────────────────────────────────────────────────────
// POST https://api.minimax.io/v1/image_generation
// Body: { model, prompt, aspect_ratio }
// Response: { data: { image_urls: ["..."] } }
//
// Real docs (platform.minimax.io):
//   - Endpoint: POST /v1/image_generation (underscore, not /image/generation)
//   - Domain: api.minimax.io (not api.minimax.chat)
//   - Body: { model: "image-01", prompt: "...", aspect_ratio: "1:1" }
//   - aspect_ratio (not size/n like OpenAI): "1:1", "16:9", "9:16", "4:3", "3:4"

async function callMiniMaxImage(
  provider: ProviderRegistryEntry,
  model: string,
  prompt: string,
): Promise<Omit<ImageGenerationResult, 'model' | 'provider'>> {
  const base = provider.apiUrl.replace(/\/+$/, '');
  // Use the correct endpoint — api.minimax.io/v1/image_generation
  // If the configured URL is api.minimax.chat, redirect to api.minimax.io
  const url = base.includes('api.minimax.chat')
    ? `https://api.minimax.io/v1/image_generation`
    : `${base}/image_generation`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      aspect_ratio: '1:1', // default; MiniMax uses aspect_ratio, NOT size
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`MiniMax image generation failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { data?: { image_urls?: string[] } };
  const imageUrl = data.data?.image_urls?.[0];
  if (!imageUrl) throw new Error('MiniMax returned no image data');

  return {
    success: true,
    imageUrl,
    format: 'png',
  };
}

// ── WaveSpeed (async submit-then-poll) ────────────────────────────────
// Step 1: POST https://api.wavespeed.ai/api/v3/{model_id}
//   Body: { prompt }
//   Response: { code: 0, data: { id: "prediction_id", status: "created" } }
//
// Step 2: Poll GET https://api.wavespeed.ai/api/v3/predictions/{id}/result
//   Response: { code: 0, data: { status: "completed", image_urls: ["..."] } }
//
// This is a genuinely different pattern from OpenAI/Gemini/MiniMax (sync).
// The submit-then-poll loop runs inside the tool call — agents don't see
// the intermediate steps, just the final image.

async function callWaveSpeedImage(
  provider: ProviderRegistryEntry,
  model: string,
  prompt: string,
): Promise<Omit<ImageGenerationResult, 'model' | 'provider'>> {
  const base = provider.apiUrl.replace(/\/+$/, '');
  const submitUrl = `${base}/${model}`;

  // Step 1: Submit the prediction
  const submitRes = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text().catch(() => '(no body)');
    throw new Error(`WaveSpeed submit failed (HTTP ${submitRes.status}): ${body.slice(0, 200)}`);
  }

  const submitData = await submitRes.json() as {
    code?: number;
    data?: { id?: string; status?: string };
  };
  const predictionId = submitData.data?.id;
  if (!predictionId) {
    throw new Error(`WaveSpeed submit returned no prediction ID: ${JSON.stringify(submitData).slice(0, 200)}`);
  }

  // Step 2: Poll for the result
  const pollUrl = `${base}/predictions/${predictionId}/result`;
  const maxPollAttempts = 60; // 60 × 2s = 120s max wait
  const pollIntervalMs = 2000;

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    const pollRes = await fetch(pollUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!pollRes.ok) {
      const body = await pollRes.text().catch(() => '(no body)');
      throw new Error(`WaveSpeed poll failed (HTTP ${pollRes.status}): ${body.slice(0, 200)}`);
    }

    const pollData = await pollRes.json() as {
      code?: number;
      data?: {
        status?: string;
        image_urls?: string[];
        error?: string;
      };
    };

    const status = pollData.data?.status;
    if (status === 'completed') {
      const imageUrl = pollData.data?.image_urls?.[0];
      if (!imageUrl) throw new Error('WaveSpeed completed but returned no image URL');
      return { success: true, imageUrl, format: 'png' };
    }
    if (status === 'failed') {
      throw new Error(`WaveSpeed generation failed: ${pollData.data?.error ?? 'unknown error'}`);
    }
    // status is 'created' or 'processing' — keep polling
  }

  throw new Error(`WaveSpeed generation timed out after ${maxPollAttempts * pollIntervalMs / 1000}s`);
}

// ── BytePlus Seedream (ModelArk — async task-based) ────────────────────
// Step 1: POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
//   Body: { model: "<endpoint_id>", content: [{ type: "text", text: prompt }] }
//   Response: { id: "task_id" }
//
// Step 2: Poll GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}
//   Response: { status: "succeeded", content: { image_url: "..." } }
//
// Real docs (docs.byteplus.com/en/docs/modelark/image-generation-api):
//   - Uses ModelArk (ark.cn-beijing.volces.com), NOT openspeech.bytedance.com
//   - The "model" is actually an Endpoint ID configured in ModelArk
//   - Async task-based: submit → get task ID → poll until done
//   - Content uses the same message-style format as chat completions

async function callBytePlusImage(
  provider: ProviderRegistryEntry,
  model: string,
  prompt: string,
): Promise<Omit<ImageGenerationResult, 'model' | 'provider'>> {
  // Fix the base URL — if still pointing at the speech API domain, use ModelArk
  const base = provider.apiUrl.includes('openspeech.bytedance.com')
    ? 'https://ark.cn-beijing.volces.com/api/v3'
    : provider.apiUrl.replace(/\/+$/, '');

  const submitUrl = `${base}/contents/generations/tasks`;

  // Step 1: Submit the task
  const submitRes = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model, // this is the Endpoint ID in ModelArk
      content: [{ type: 'text', text: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text().catch(() => '(no body)');
    throw new Error(`BytePlus task submit failed (HTTP ${submitRes.status}): ${body.slice(0, 200)}`);
  }

  const submitData = await submitRes.json() as { id?: string };
  const taskId = submitData.id;
  if (!taskId) {
    throw new Error(`BytePlus submit returned no task ID: ${JSON.stringify(submitData).slice(0, 200)}`);
  }

  // Step 2: Poll for the result
  const pollUrl = `${base}/contents/generations/tasks/${taskId}`;
  const maxPollAttempts = 60;
  const pollIntervalMs = 2000;

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    const pollRes = await fetch(pollUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!pollRes.ok) {
      const body = await pollRes.text().catch(() => '(no body)');
      throw new Error(`BytePlus poll failed (HTTP ${pollRes.status}): ${body.slice(0, 200)}`);
    }

    const pollData = await pollRes.json() as {
      status?: string;
      content?: { image_url?: string; image_urls?: string[] };
      error?: { message?: string };
    };

    if (pollData.status === 'succeeded') {
      const imageUrl = pollData.content?.image_url ?? pollData.content?.image_urls?.[0];
      if (!imageUrl) throw new Error('BytePlus succeeded but returned no image URL');
      return { success: true, imageUrl, format: 'png' };
    }
    if (pollData.status === 'failed') {
      throw new Error(`BytePlus generation failed: ${pollData.error?.message ?? 'unknown error'}`);
    }
    // status is 'queued' or 'running' — keep polling
  }

  throw new Error(`BytePlus generation timed out after ${maxPollAttempts * pollIntervalMs / 1000}s`);
}

// ── OpenAI-compatible (for custom providers) ──────────────────────────

async function callOpenAICompatibleImage(
  provider: ProviderRegistryEntry,
  model: string,
  prompt: string,
  size?: string,
): Promise<Omit<ImageGenerationResult, 'model' | 'provider'>> {
  return callOpenAIImage(provider, model, prompt, size);
}

// ── Approval gate (reuses Ghost Mode pattern) ──────────────────────────

const APPROVAL_TIMEOUT_MS = 120_000; // 2 min

/**
 * Check if image generation needs approval.
 * When the toggle is ON (allowEveryRequest=true), returns 'approved' immediately.
 * When OFF, goes through Ghost Mode's reportFinding() + waitForApproval() pattern.
 */
export async function checkImageGenerationApproval(
  task: AgentTask,
  prompt: string,
  signal: AbortSignal,
): Promise<'approved' | 'rejected' | 'timeout' | 'aborted'> {
  if (allowEveryRequest) {
    return 'approved';
  }

  // Reuse Ghost Mode's approval pattern — same as fabrication agent
  const finding = ghostMode.reportFinding({
    type: 'image-generation',
    severity: 'medium', // image generation is a side effect but not destructive
    description: `Image generation requested: "${prompt.slice(0, 150)}"`,
    userId: task.context.userId,
    agentId: task.agentId,
    taskId: task.id,
  });

  addStep(task.id, {
    kind: 'tool-call',
    label: `ghostMode.reportFinding() — image generation approval requested`,
    meta: { viaGhostMode: true, findingId: finding.id, prompt: prompt.slice(0, 100) },
  });

  const plan = await ghostMode.planFix(finding);

  if (ghostMode.currentState !== 'awaiting_approval') {
    return 'approved';
  }

  const waitStart = Date.now();
  while (Date.now() - waitStart < APPROVAL_TIMEOUT_MS) {
    if (signal.aborted) return 'aborted';

    const resolution = ghostMode.getResolution(finding.id);
    if (resolution === 'approved') return 'approved';
    if (resolution === 'rejected') return 'rejected';

    await new Promise(r => setTimeout(r, 500));
  }

  return 'timeout';
}
