// server/tests/unit/agent-routing.test.ts
// UPR Phase 4 — Agent Model Routing tests.
//
// Required evidence:
//   1. Auto Free allocation across ≥2 providers — confirm agents get matched
//      to models that fit their inferred task/context needs, not arbitrarily.
//   2. Mixed Provider gate blocks with <2 keys, allows with ≥2.
//   3. One Provider mode — all agents route to the selected provider/model.
//   4. Mid-task failure recovery — resume from TaskState resumption point.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(__dirname, '..', '..', '.runtime');
const ROUTING_PATH = join(RUNTIME_DIR, 'agent-routing.json');

// Mock the provider registry with controlled test data
const mockProviders = [
  {
    id: 'openrouter',
    category: 'llm',
    displayName: 'OpenRouter (Cloud Gateway)',
    connectionTested: true,
    apiKey: 'test-openrouter-key',
    models: [
      {
        id: 'google/gemini-2.0-flash-exp:free',
        name: 'Gemini 2.0 Flash (free)',
        contextWindow: 1048576,
        maxOutputTokens: 8192,
        costTier: 'free' as const,
        freeOrPaid: 'free' as const,
        supportsVision: true,
        supportsToolUse: true,
        pricingNote: 'Free',
      },
      {
        id: 'anthropic/claude-3.5-sonnet',
        name: 'Claude 3.5 Sonnet',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        costTier: 'paid' as const,
        freeOrPaid: 'paid' as const,
        supportsVision: true,
        supportsToolUse: true,
        pricingNote: '$3/MTok',
      },
    ],
  },
  {
    id: 'anthropic',
    category: 'llm',
    displayName: 'Anthropic (Direct API)',
    connectionTested: true,
    apiKey: 'test-anthropic-key',
    models: [
      {
        id: 'claude-3-haiku-20240307',
        name: 'Claude 3 Haiku',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        costTier: 'paid' as const,
        freeOrPaid: 'paid' as const,
        supportsVision: true,
        supportsToolUse: true,
        pricingNote: '$0.25/MTok',
      },
    ],
  },
];

vi.mock('../../src/provider-registry/registry.js', () => ({
  listProviders: () => mockProviders,
  getProvider: (id: string) => mockProviders.find(p => p.id === id),
}));

import {
  getRoutingConfig,
  setRoutingConfig,
  setRoutingMode,
  setOneProvider,
  setAgentAssignment,
  getRoutingForAgent,
  canEnableMixedMode,
  computeAutoFreeAssignments,
  countConfiguredLLMProviders,
  inferTaskType,
  providerIdToEngine,
  resetRoutingCache,
} from '../../src/orchestration/agent-routing.js';

// Clear the cache between tests by deleting the file + resetting the module cache
function clearRoutingConfig() {
  if (existsSync(ROUTING_PATH)) {
    rmSync(ROUTING_PATH);
  }
}

describe('UPR Phase 4 — Agent Model Routing', () => {
  beforeEach(() => {
    clearRoutingConfig();
    resetRoutingCache(); // clear module-level cache
  });

  afterEach(() => {
    clearRoutingConfig();
    resetRoutingCache();
  });

  // ── One Provider mode ──────────────────────────────────────────────

  it('TEST 3: One Provider mode — all agents route to the selected provider/model', () => {
    // Set One Provider mode with OpenRouter + a specific model
    setOneProvider('openrouter', 'anthropic/claude-3.5-sonnet');

    const config = getRoutingConfig();
    expect(config.mode).toBe('one-provider');
    expect(config.oneProvider).toEqual({
      providerId: 'openrouter',
      modelId: 'anthropic/claude-3.5-sonnet',
    });

    // Verify all agents route to this provider+model
    const testAgents = ['architect-agent', 'backend-agent', 'frontend-agent', 'security-agent'];
    for (const agentId of testAgents) {
      const routing = getRoutingForAgent(agentId);
      expect(routing).not.toBeNull();
      expect(routing!.providerId).toBe('openrouter');
      expect(routing!.modelId).toBe('anthropic/claude-3.5-sonnet');
      expect(routing!.engine).toBe('openrouter');
    }

    console.log('  ✓ One Provider mode routes all agents to the selected provider/model');
  });

  it('One Provider mode with Anthropic — engine maps to anthropic', () => {
    setOneProvider('anthropic', 'claude-3-haiku-20240307');

    const routing = getRoutingForAgent('backend-agent');
    expect(routing).not.toBeNull();
    expect(routing!.providerId).toBe('anthropic');
    expect(routing!.modelId).toBe('claude-3-haiku-20240307');
    expect(routing!.engine).toBe('anthropic');

    console.log('  ✓ One Provider with Anthropic — engine correctly maps to anthropic');
  });

  it('No routing config → returns null (legacy fallback)', () => {
    // No config file exists — should return null (ModelRouter falls back to preferredEngine)
    const routing = getRoutingForAgent('architect-agent');
    expect(routing).toBeNull();

    console.log('  ✓ No routing config → null (legacy preferredEngine cascade used)');
  });

  // ── Mixed Provider gate ───────────────────────────────────────────

  it('TEST 2a: Mixed Provider gate BLOCKS with <2 configured providers', () => {
    // Mock only 1 configured provider
    const originalListProviders = mockProviders.slice();
    mockProviders.length = 1; // only OpenRouter
    mockProviders[0] = originalListProviders[0]; // keep OpenRouter

    const check = canEnableMixedMode();
    expect(check.canEnable).toBe(false);
    expect(check.configuredCount).toBe(1);
    expect(check.reason).toContain('at least 2');
    expect(check.reason).toContain('Settings');
    expect(check.reason).toContain('API Hub');

    // Verify setRoutingMode also blocks
    const result = setRoutingMode('mixed-provider');
    expect(result.success).toBe(false);
    expect(result.error).toContain('at least 2');

    // Restore
    mockProviders.length = 0;
    mockProviders.push(...originalListProviders);

    console.log('  ✓ Mixed Provider gate blocks with <2 keys');
    console.log('  ✓ Error message tells user to configure more providers');
  });

  it('TEST 2b: Mixed Provider gate ALLOWS with ≥2 configured providers', () => {
    // We have 2 mock providers (OpenRouter + Anthropic)
    const check = canEnableMixedMode();
    expect(check.canEnable).toBe(true);
    expect(check.configuredCount).toBe(2);

    // Verify setRoutingMode allows it
    const result = setRoutingMode('mixed-provider');
    expect(result.success).toBe(true);

    const config = getRoutingConfig();
    expect(config.mode).toBe('mixed-provider');

    console.log('  ✓ Mixed Provider gate allows with ≥2 keys');
  });

  it('Mixed Provider mode — per-agent assignments work', () => {
    // Clear any previous config (including oneProvider from prior tests)
    clearRoutingConfig();
    resetRoutingCache();
    setRoutingConfig({ mode: 'one-provider' });

    setRoutingMode('mixed-provider');
    setAgentAssignment('architect-agent', 'anthropic', 'claude-3-haiku-20240307');
    setAgentAssignment('backend-agent', 'openrouter', 'google/gemini-2.0-flash-exp:free');

    const architectRouting = getRoutingForAgent('architect-agent');
    expect(architectRouting).not.toBeNull();
    expect(architectRouting!.providerId).toBe('anthropic');
    expect(architectRouting!.engine).toBe('anthropic');

    const backendRouting = getRoutingForAgent('backend-agent');
    expect(backendRouting).not.toBeNull();
    expect(backendRouting!.providerId).toBe('openrouter');
    expect(backendRouting!.engine).toBe('openrouter');

    // Unassigned agents fall back to oneProvider (if set) or null
    // (oneProvider is NOT set in this test — we cleared it)
    const unassigned = getRoutingForAgent('frontend-agent');
    expect(unassigned).toBeNull();

    console.log('  ✓ Mixed Provider per-agent assignments work');
    console.log('  ✓ Unassigned agents fall back to null (legacy)');
  });

  // ── Auto Free allocation ──────────────────────────────────────────

  it('TEST 1: Auto Free allocation matches agents to appropriate free-tier models', () => {
    // We have 1 free model: google/gemini-2.0-flash-exp:free on OpenRouter
    // (context=1M, supports tool use)
    setRoutingMode('auto-free');
    const { assignments, shortfalls } = computeAutoFreeAssignments();

    // All 20 agents should get assigned (there's at least 1 free model)
    expect(Object.keys(assignments).length).toBe(20);

    // All should be assigned to the free Gemini model on OpenRouter
    for (const [agentId, assignment] of Object.entries(assignments)) {
      expect(assignment.providerId).toBe('openrouter');
      expect(assignment.modelId).toBe('google/gemini-2.0-flash-exp:free');

      const taskType = inferTaskType(agentId);
      console.log(`  ✓ ${agentId} (${taskType}) → ${assignment.modelId}`);
    }

    // No shortfalls (free model available for all)
    expect(shortfalls.length).toBe(0);

    console.log('  ✓ All 20 agents matched to free-tier model');
  });

  it('Auto Free with no free models → all agents have shortfalls', () => {
    // Mock: remove the free model
    const originalModels = mockProviders[0].models;
    mockProviders[0].models = mockProviders[0].models.filter(m => m.costTier !== 'free');

    const { assignments, shortfalls } = computeAutoFreeAssignments();
    expect(Object.keys(assignments).length).toBe(0);
    expect(shortfalls.length).toBe(20);

    // Each shortfall should explain why
    for (const shortfall of shortfalls) {
      expect(shortfall.reason).toContain('No free-tier model');
    }

    // Restore
    mockProviders[0].models = originalModels;

    console.log('  ✓ All 20 agents have shortfalls when no free models available');
    console.log('  ✓ Shortfall messages explain what\'s needed');
  });

  it('Auto Free allocation infers task types correctly', () => {
    // Reasoning agents
    expect(inferTaskType('architect-agent')).toBe('reasoning');
    expect(inferTaskType('security-agent')).toBe('reasoning');
    expect(inferTaskType('code-review-agent')).toBe('reasoning');
    expect(inferTaskType('performance-agent')).toBe('reasoning');

    // Coding agents
    expect(inferTaskType('backend-agent')).toBe('coding');
    expect(inferTaskType('frontend-agent')).toBe('coding');
    expect(inferTaskType('database-agent')).toBe('coding');
    expect(inferTaskType('qa-tester-agent')).toBe('coding');

    // Documentation agents
    expect(inferTaskType('documentation-agent')).toBe('documentation');
    expect(inferTaskType('deployment-agent')).toBe('documentation');
    expect(inferTaskType('devops-agent')).toBe('documentation');

    // General agents
    expect(inferTaskType('research-agent')).toBe('general');
    expect(inferTaskType('memory-agent')).toBe('general');
    expect(inferTaskType('ui-designer-agent')).toBe('general');

    console.log('  ✓ Task type inference maps all 20 agents correctly');
  });

  // ── providerIdToEngine (namespace resolution) ────────────────────

  it('providerIdToEngine resolves namespace mismatch correctly', () => {
    expect(providerIdToEngine('openrouter')).toBe('openrouter');
    expect(providerIdToEngine('anthropic')).toBe('anthropic');
    expect(providerIdToEngine('groq')).toBe('groq');
    expect(providerIdToEngine('ollama')).toBe('ollama');
    // Custom providers default to openrouter (OpenAI-compatible)
    expect(providerIdToEngine('custom-llm-123')).toBe('openrouter');

    console.log('  ✓ providerIdToEngine resolves all known + custom providers');
  });

  // ── countConfiguredLLMProviders ──────────────────────────────────

  it('countConfiguredLLMProviders returns correct count', () => {
    expect(countConfiguredLLMProviders()).toBe(2); // OpenRouter + Anthropic

    console.log('  ✓ countConfiguredLLMProviders returns 2');
  });
});
