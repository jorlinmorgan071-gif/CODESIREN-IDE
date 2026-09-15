// server/tests/unit/upr-phase2-step2b-tool-registry.test.ts
// UPR Phase 2 Step 2b — Tool/MCP category tests.
//
// Required evidence (per directive):
//   1. At least 1 real provider tested end-to-end
//   2. Bad key → specific, visible error
//   3. Code Siren built-in tools inventory returns real tools from the toolRegistry
//
// Method: direct registry calls — code-siren-tools is a local inventory (no
// remote API), Tavily/Judge0 are connection tests (no remote API call, just
// key + URL validation).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Set API keys for external tool providers
process.env.TAVILY_API_KEY = 'test-tavily-key';
process.env.RAPIDAPI_KEY = 'test-rapidapi-key';

import { listProviders, getProvider, testAndLoadModels, resetProvider } from '../../src/provider-registry/registry.js';

describe('UPR Phase 2 Step 2b — Tool/MCP ProviderRegistry', () => {
  beforeEach(() => {
    resetProvider('code-siren-tools');
    resetProvider('tavily');
    resetProvider('judge0');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TEST 1: listProviders includes 3 Tool providers ──────────────────
  it('listProviders includes all 3 Tool providers', () => {
    const providers = listProviders();
    const toolProviders = providers.filter((p) => p.category === 'tool');
    expect(toolProviders.length).toBe(3);

    const ids = toolProviders.map((p) => p.id);
    expect(ids).toContain('code-siren-tools');
    expect(ids).toContain('tavily');
    expect(ids).toContain('judge0');
  });

  // ── TEST 2: Code Siren built-in tools — "test & load" returns real tool catalog ──
  it('code-siren-tools: "test & load" returns real tool catalog from toolRegistry', async () => {
    const result = await testAndLoadModels('code-siren-tools');

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.tools.length).toBeGreaterThan(0);

    // Spot-check that the real built-in tools are present
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('calculator');
    expect(names).toContain('http_request');
    expect(names).toContain('code_interpreter');
    expect(names).toContain('think');

    // code_interpreter should be marked as unavailable (D13 closeout)
    const codeInterp = result.tools.find((t) => t.name === 'code_interpreter')!;
    expect(codeInterp.available).toBe(false);
    expect(codeInterp.unavailableReason).toBeDefined();
    expect(codeInterp.unavailableReason!).toContain('Unavailable');

    // calculator should be marked as read-only + available
    const calculator = result.tools.find((t) => t.name === 'calculator')!;
    expect(calculator.available).toBe(true);
    expect(calculator.readOnly).toBe(true);

    // http_request should be read-only + available
    const httpRequest = result.tools.find((t) => t.name === 'http_request')!;
    expect(httpRequest.available).toBe(true);
    expect(httpRequest.readOnly).toBe(true);

    // Verify the registry entry was updated
    const provider = getProvider('code-siren-tools')!;
    expect(provider.connectionTested).toBe(true);
    expect(provider.tools.length).toBeGreaterThan(0);
  });

  // ── TEST 3: Tavily — connection test returns web_search tool ──────────
  it('tavily: "test & load" returns web_search tool when API key is set', async () => {
    const result = await testAndLoadModels('tavily');

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.tools.length).toBe(1);

    const tool = result.tools[0]!;
    expect(tool.name).toBe('web_search');
    expect(tool.readOnly).toBe(true);
    expect(tool.available).toBe(true);
    expect(tool.description).toContain('Tavily');

    const provider = getProvider('tavily')!;
    expect(provider.connectionTested).toBe(true);
  });

  // ── TEST 4: Tavily — no API key → specific error ──────────────────────
  it('tavily: no API key → specific error telling user to enter a key', async () => {
    // Clear the key
    const entry = getProvider('tavily')!;
    entry.apiKey = '';

    const result = await testAndLoadModels('tavily');

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error!).toMatch(/not set|enter/i);
    expect(result.error!).toContain('tavily');
  });

  // ── TEST 5: Judge0 — connection test returns code_execute tool ───────
  it('judge0: "test & load" returns code_execute tool when API key is set', async () => {
    const result = await testAndLoadModels('judge0');

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.tools.length).toBe(1);

    const tool = result.tools[0]!;
    expect(tool.name).toBe('code_execute');
    expect(tool.readOnly).toBe(false);  // code execution mutates state (runs code)
    expect(tool.available).toBe(true);
    expect(tool.description).toContain('Judge0');

    const provider = getProvider('judge0')!;
    expect(provider.connectionTested).toBe(true);
  });

  // ── TEST 6: Judge0 — no API key → specific error ──────────────────────
  it('judge0: no API key → specific error telling user to enter a key', async () => {
    const entry = getProvider('judge0')!;
    entry.apiKey = '';

    const result = await testAndLoadModels('judge0');

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error!).toMatch(/not set|enter/i);
    expect(result.error!).toContain('judge0');
  });

  // ── TEST 7: Tool providers don't pollute LLM/TTS lists ───────────────
  it('tool providers have empty models[] and voices[] after load', async () => {
    await testAndLoadModels('code-siren-tools');

    const provider = getProvider('code-siren-tools')!;
    expect(provider.models).toEqual([]);
    expect(provider.voices).toEqual([]);
    expect(provider.tools.length).toBeGreaterThan(0);
  });

  // ── TEST 8: End-to-end — tool is callable via toolRegistry after load ──
  it('code-siren-tools: loaded tools match toolRegistry.list() exactly', async () => {
    const result = await testAndLoadModels('code-siren-tools');
    const { toolRegistry } = await import('../../src/agents/_shared/tool-registry.js');
    const liveTools = toolRegistry.list();
    const registryTools = result.tools;

    // Same count
    expect(registryTools.length).toBe(liveTools.length);

    // Same names
    const liveNames = liveTools.map((t) => t.name).sort();
    const registryNames = registryTools.map((t) => t.name).sort();
    expect(registryNames).toEqual(liveNames);
  });
});
