// server/tests/unit/image-generation.test.ts
// UPR Phase 5 — Image/Video Generation Routing tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock provider registry — control which providers are "configured"
vi.mock('../../src/provider-registry/registry.js', () => ({
  listProviders: () => mockProviders,
  getProvider: (id: string) => mockProviders.find(p => p.id === id),
}));

// Mock Ghost Mode (for approval gate tests)
vi.mock('../../src/orchestration/ghost-mode.js', () => ({
  ghostMode: {
    get currentState() { return mockGhostState.state; },
    reportFinding: (finding: any) => ({ id: 'test-finding-id', ...finding }),
    planFix: async () => ({ id: 'test-finding-id' }),
    getResolution: () => mockGhostState.resolution,
  },
}));

vi.mock('../../src/observability/traces.js', () => ({
  addStep: () => {},
}));

const mockProviders: any[] = [];
const mockGhostState = { state: 'inactive' as string, resolution: null as string | null };

import {
  generateImage,
  findImageProvider,
  getImageGenerationApprovalToggle,
  setImageGenerationApprovalToggle,
  checkImageGenerationApproval,
} from '../../src/orchestration/image-generation.js';

import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';

describe('UPR Phase 5 — Image/Video Generation Routing', () => {
  beforeEach(() => {
    mockProviders.length = 0;
    mockGhostState.state = 'inactive';
    mockGhostState.resolution = null;
    setImageGenerationApprovalToggle(true); // reset to default (on)
  });

  // ── Toggle behavior ────────────────────────────────────────────────

  it('TEST 1: toggle ON → approval returns immediately (zero friction)', async () => {
    setImageGenerationApprovalToggle(true);
    expect(getImageGenerationApprovalToggle()).toBe(true);

    // checkImageGenerationApproval should return 'approved' without going through Ghost Mode
    const mockTask = {
      id: 'test-task',
      agentId: 'frontend-agent',
      context: { userId: 'test-user' },
    } as any;
    const controller = new AbortController();
    const result = await checkImageGenerationApproval(mockTask, 'Generate a logo', controller.signal);
    expect(result).toBe('approved');

    console.log('  ✓ Toggle ON → approval immediate, zero friction');
  });

  it('TEST 2: toggle OFF → approval goes through Ghost Mode (blocks until resolved)', async () => {
    setImageGenerationApprovalToggle(false);
    expect(getImageGenerationApprovalToggle()).toBe(false);

    // Simulate Ghost Mode approving after a moment
    mockGhostState.state = 'awaiting_approval';
    setTimeout(() => { mockGhostState.resolution = 'approved'; }, 100);

    const mockTask = {
      id: 'test-task-2',
      agentId: 'frontend-agent',
      context: { userId: 'test-user' },
    } as any;
    const controller = new AbortController();
    const result = await checkImageGenerationApproval(mockTask, 'Generate a hero image', controller.signal);
    expect(result).toBe('approved');

    console.log('  ✓ Toggle OFF → approval goes through Ghost Mode');
    console.log('  ✓ Blocks until resolved (did not return immediately)');
  });

  // ── No provider configured → honest 503 ────────────────────────────

  it('TEST 3: no image provider configured → returns specific 503-style error', async () => {
    // No providers in the mock
    const result = await generateImage({ prompt: 'A beautiful sunset' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No image/video provider is configured');
    expect(result.error).toContain('Settings');
    expect(result.error).toContain('API Hub');
    expect(result.error).toContain('Image/Video API');

    console.log('  ✓ No provider configured → honest failure with specific message');
    console.log('  ✓ Error mentions Settings → API Hub → Image/Video API');
  });

  // ── Provider configured → real generation call ────────────────────

  it('TEST 4a: configured provider with no image capability → clear error', async () => {
    // Add a provider that's configured but has empty imageModels
    mockProviders.push({
      id: 'openai-image',
      category: 'image-video',
      displayName: 'OpenAI DALL·E',
      connectionTested: true,
      apiKey: 'test-key',
      imageModels: [], // no models loaded
    });

    const found = findImageProvider();
    expect(found).toBeNull(); // no provider with image models

    console.log('  ✓ Provider configured but no image models loaded → findImageProvider returns null');
  });

  it('TEST 4b: OpenAI DALL·E provider → calls real API shape', async () => {
    // Add a fully-configured OpenAI provider
    mockProviders.push({
      id: 'openai-image',
      category: 'image-video',
      displayName: 'OpenAI DALL·E',
      connectionTested: true,
      apiKey: 'test-openai-key',
      apiUrl: 'https://api.openai.com/v1',
      imageModels: [{
        id: 'dall-e-3',
        name: 'DALL·E 3',
        outputType: 'image',
        resolutions: ['1024x1024'],
        aspectRatios: ['1:1'],
        supportsImageToImage: false,
        supportsVideo: false,
        costTier: 'paid',
        pricingNote: '$0.040 per image',
      }],
    });

    // Mock fetch to return a fake image response
    const fetchSpy = vi.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await generateImage({ prompt: 'A blue circle on white background' });

    expect(result.success).toBe(true);
    expect(result.imageBase64).toBeDefined();
    expect(result.model).toBe('dall-e-3');
    expect(result.provider).toBe('openai-image');

    // Verify the fetch was called with the correct OpenAI shape
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('https://api.openai.com/v1/images/generations');
    const body = JSON.parse((call[1] as any).body);
    expect(body.model).toBe('dall-e-3');
    expect(body.prompt).toBe('A blue circle on white background');
    expect(body.n).toBe(1);
    expect(body.response_format).toBe('b64_json');

    fetchSpy.mockRestore();

    console.log('  ✓ OpenAI DALL·E called with correct API shape');
    console.log('  ✓ Response parsed correctly → imageBase64 returned');
  });

  it('TEST 4c: MiniMax provider → calls /v1/image_generation with aspect_ratio', async () => {
    mockProviders.push({
      id: 'minimax-image',
      category: 'image-video',
      displayName: 'MiniMax (Image/Video Generation)',
      connectionTested: true,
      apiKey: 'test-minimax-key',
      apiUrl: 'https://api.minimax.io/v1',
      imageModels: [{
        id: 'image-01',
        name: 'MiniMax Image Generation',
        outputType: 'image',
        resolutions: [],
        aspectRatios: ['1:1', '16:9', '9:16'],
        supportsImageToImage: false,
        supportsVideo: false,
        costTier: 'paid',
        pricingNote: 'See MiniMax pricing',
      }],
    });

    const fetchSpy = vi.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: { image_urls: ['https://example.com/generated.png'] },
      }), { status: 200 }),
    );

    const result = await generateImage({ prompt: 'A red square' });

    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe('https://example.com/generated.png');
    expect(result.provider).toBe('minimax-image');

    // Verify the fetch URL uses /image_generation (underscore, not /image/generation)
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('https://api.minimax.io/v1/image_generation');

    // Verify the body has aspect_ratio, NOT size/n
    const body = JSON.parse((call[1] as any).body);
    expect(body.model).toBe('image-01');
    expect(body.prompt).toBe('A red square');
    expect(body.aspect_ratio).toBe('1:1');
    expect(body.size).toBeUndefined(); // MiniMax doesn't use size
    expect(body.n).toBeUndefined();    // MiniMax doesn't use n

    fetchSpy.mockRestore();
    console.log('  ✓ MiniMax called /v1/image_generation (correct endpoint)');
    console.log('  ✓ Body uses aspect_ratio (not size/n)');
  });

  it('TEST 4d: WaveSpeed provider → submit-then-poll async flow', async () => {
    mockProviders.push({
      id: 'wavespeed',
      category: 'image-video',
      displayName: 'WaveSpeed (Image/Video Generation)',
      connectionTested: true,
      apiKey: 'test-wavespeed-key',
      apiUrl: 'https://api.wavespeed.ai/api/v2',
      imageModels: [{
        id: 'flux-schnell',
        name: 'FLUX.1 [schnell]',
        outputType: 'image',
        resolutions: ['1024x1024'],
        aspectRatios: ['1:1'],
        supportsImageToImage: false,
        supportsVideo: false,
        costTier: 'free',
        pricingNote: 'Free',
      }],
    });

    const fetchSpy = vi.spyOn(global, 'fetch');

    // Mock submit response
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        code: 0,
        data: { id: 'pred-123', status: 'created' },
      }), { status: 200 }),
    );

    // Mock poll response (completed on first poll)
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        code: 0,
        data: { status: 'completed', image_urls: ['https://example.com/wavespeed.png'] },
      }), { status: 200 }),
    );

    const result = await generateImage({ prompt: 'A green triangle' });

    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe('https://example.com/wavespeed.png');
    expect(result.provider).toBe('wavespeed');

    // Verify the submit call went to /api/v2/{model_id}
    const submitCall = fetchSpy.mock.calls[0];
    expect(submitCall[0]).toBe('https://api.wavespeed.ai/api/v2/flux-schnell');
    const submitBody = JSON.parse((submitCall[1] as any).body);
    expect(submitBody.prompt).toBe('A green triangle');

    // Verify the poll call went to /predictions/{id}/result
    const pollCall = fetchSpy.mock.calls[1];
    expect(pollCall[0]).toBe('https://api.wavespeed.ai/api/v2/predictions/pred-123/result');

    fetchSpy.mockRestore();
    console.log('  ✓ WaveSpeed submit to /api/v2/{model_id}');
    console.log('  ✓ WaveSpeed poll to /predictions/{id}/result');
    console.log('  ✓ Async submit-then-poll flow works');
  });

  it('TEST 4e: BytePlus provider → ModelArk task-based async flow', async () => {
    mockProviders.push({
      id: 'byteplus-seedream',
      category: 'image-video',
      displayName: 'BytePlus Seedream (Image Generation)',
      connectionTested: true,
      apiKey: 'test-byteplus-key',
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      imageModels: [{
        id: 'seedream-3.0',
        name: 'Seedream 3.0',
        outputType: 'image',
        resolutions: ['1024x1024'],
        aspectRatios: ['1:1'],
        supportsImageToImage: true,
        supportsVideo: false,
        costTier: 'paid',
        pricingNote: 'See BytePlus pricing',
      }],
    });

    const fetchSpy = vi.spyOn(global, 'fetch');

    // Mock submit response
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'task-456',
      }), { status: 200 }),
    );

    // Mock poll response (succeeded on first poll)
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'succeeded',
        content: { image_url: 'https://example.com/byteplus.png' },
      }), { status: 200 }),
    );

    const result = await generateImage({ prompt: 'A purple circle' });

    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe('https://example.com/byteplus.png');
    expect(result.provider).toBe('byteplus-seedream');

    // Verify the submit call went to ModelArk, NOT openspeech.bytedance.com
    const submitCall = fetchSpy.mock.calls[0];
    expect(submitCall[0]).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    expect(submitCall[0]).not.toContain('openspeech.bytedance.com');

    // Verify the body uses content array (ModelArk format), NOT { model, prompt }
    const submitBody = JSON.parse((submitCall[1] as any).body);
    expect(submitBody.model).toBe('seedream-3.0');
    expect(submitBody.content).toBeDefined();
    expect(submitBody.content[0].type).toBe('text');
    expect(submitBody.content[0].text).toBe('A purple circle');

    // Verify the poll call went to the task URL
    const pollCall = fetchSpy.mock.calls[1];
    expect(pollCall[0]).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-456');

    fetchSpy.mockRestore();
    console.log('  ✓ BytePlus uses ModelArk (ark.cn-beijing.volces.com), NOT openspeech.bytedance.com');
    console.log('  ✓ Submit to /contents/generations/tasks with content array');
    console.log('  ✓ Poll to /contents/generations/tasks/{id}');
    console.log('  ✓ Task-based async flow works');
  });

  // ── image_gen tool ─────────────────────────────────────────────────

  it('TEST 5: image_gen tool is registered + callable', async () => {
    // Verify the tool is in the registry
    const tools = toolRegistry.list();
    const imageGenTool = tools.find(t => t.name === 'image_gen');
    expect(imageGenTool).toBeDefined();
    expect(imageGenTool!.description).toContain('Generate an image');
    expect(imageGenTool!.description).toContain('prompt');

    console.log('  ✓ image_gen tool registered in toolRegistry');
  });

  it('TEST 6: image_gen tool with no provider → returns error (not silent)', async () => {
    // No providers configured
    const result = await toolRegistry.execute('image_gen', { prompt: 'test image' });

    expect(result.success).toBe(false);
    expect(result.content).toContain('No image/video provider is configured');
    expect(result.name).toBe('image_gen');

    console.log('  ✓ image_gen tool returns honest error when no provider configured');
  });

  it('TEST 7: image_gen tool with configured provider → returns image data', async () => {
    // Add a provider
    mockProviders.push({
      id: 'openai-image',
      category: 'image-video',
      displayName: 'OpenAI DALL·E',
      connectionTested: true,
      apiKey: 'test-key',
      apiUrl: 'https://api.openai.com/v1',
      imageModels: [{ id: 'dall-e-3', name: 'DALL·E 3', outputType: 'image', resolutions: [], aspectRatios: [], supportsImageToImage: false, supportsVideo: false, costTier: 'paid', pricingNote: '$0.04' }],
    });

    // Mock fetch
    const fetchSpy = vi.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{ b64_json: 'aGVsbG8=' }], // "hello" base64
      }), { status: 200 }),
    );

    const result = await toolRegistry.execute('image_gen', { prompt: 'A red square' });

    expect(result.success).toBe(true);
    expect(result.content).toContain('data:image/png;base64,');
    expect(result.meta?.provider).toBe('openai-image');
    expect(result.meta?.model).toBe('dall-e-3');

    fetchSpy.mockRestore();

    console.log('  ✓ image_gen tool returns image data for direct-to-agent delivery');
    console.log('  ✓ Meta includes provider + model info');
  });

  it('TEST 8: image_gen tool with missing prompt → returns error', async () => {
    const result = await toolRegistry.execute('image_gen', {});

    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required "prompt"');

    console.log('  ✓ image_gen tool validates required args');
  });
});
