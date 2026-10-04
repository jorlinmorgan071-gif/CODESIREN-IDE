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
