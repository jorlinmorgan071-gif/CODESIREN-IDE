// server/src/orchestration/agent-routing.ts
// UPR Phase 4 — Agent Model Routing.
//
// Replaces the hardcoded preferredEngine + pickModelForDomain with a
// configurable routing system that supports 3 modes:
//   1. One Provider — all agents use a single selected provider/model
//   2. Mixed Provider — each agent gets its own provider/model assignment
//   3. Auto Free — infer each agent's task type + context need, match
//      against available free-tier models across the active provider pool
//
// The routing config is stored at server/.runtime/agent-routing.json
// (same pattern as voice-settings.ts — JSON file, module-level cache,
// lazy-load + write-through).
//
// ModelRouter.stream() consults this config via getRoutingForAgent(agentId)
// before falling back to the legacy preferredEngine cascade. This means
// Phase 4 routing is additive — if no routing config exists, the old
// behavior is unchanged.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineId, AgentDomain } from '../types.js';
import { listProviders, getProvider } from '../provider-registry/registry.js';
import type { ProviderRegistryEntry, ProviderModel } from '../provider-registry/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(__dirname, '..', '..', '.runtime', 'agent-routing.json');

// ── Types ────────────────────────────────────────────────────────────────

export type RoutingMode = 'one-provider' | 'mixed-provider' | 'auto-free';

export interface AgentRoutingAssignment {
  /** The provider ID from the ProviderRegistry (e.g. 'openrouter', 'anthropic') */
  providerId: string;
  /** The model ID within that provider (e.g. 'anthropic/claude-3.5-sonnet') */
  modelId: string;
}

export interface AgentRoutingConfig {
  /** Current routing mode */
  mode: RoutingMode;
  /** One Provider mode: the single provider+model all agents use */
  oneProvider?: AgentRoutingAssignment;
  /** Mixed Provider mode: per-agent assignments (agentId → assignment) */
  mixedAssignments?: Record<string, AgentRoutingAssignment>;
  /** Auto Free mode: computed assignments (recomputed when providers change) */
  autoFreeAssignments?: Record<string, AgentRoutingAssignment>;
}

// ── Agent task-type inference (for Auto Free mode) ──────────────────────

export type TaskType = 'reasoning' | 'coding' | 'documentation' | 'general';

const DOMAIN_TASK_MAP: Record<string, TaskType> = {
  ARCHITECT: 'reasoning',
  SECURITY: 'reasoning',
  REVIEW: 'reasoning',
  PERFORMANCE: 'reasoning',
  SENTINEL: 'reasoning',
  FRONTEND: 'coding',
  BACKEND: 'coding',
  DATABASE: 'coding',
  QA: 'coding',
  TERMINAL: 'coding',
  FABRICATION: 'coding',
  DOCUMENTATION: 'documentation',
  DEPLOYMENT: 'documentation',
  DEVOPS: 'documentation',
  RESEARCH: 'general',
  MEMORY: 'general',
  DESIGN: 'general',
  EXTENSION: 'general',
  OPERATIVE: 'general',
  PROMPT: 'general',
};

const AGENT_DOMAINS: Record<string, AgentDomain> = {
  'architect-agent': 'ARCHITECT',
  'backend-agent': 'BACKEND',
  'code-review-agent': 'REVIEW',
  'database-agent': 'DATABASE',
  'deployment-agent': 'DEPLOYMENT',
  'devops-agent': 'DEVOPS',
  'documentation-agent': 'DOCUMENTATION',
  'extension-agent': 'EXTENSION',
  'fabrication-agent': 'FABRICATION',
  'frontend-agent': 'FRONTEND',
  'memory-agent': 'MEMORY',
  'operative-agent': 'OPERATIVE',
  'performance-agent': 'PERFORMANCE',
  'prompt-engineer-agent': 'PROMPT',
  'qa-tester-agent': 'QA',
  'research-agent': 'RESEARCH',
  'security-agent': 'SECURITY',
  'sentinel-agent': 'SENTINEL',
  'terminal-agent': 'TERMINAL',
  'ui-designer-agent': 'DESIGN',
};

/**
 * Infer the task type for an agent based on its domain.
 * Used by Auto Free mode to match agents to appropriate free-tier models.
 */
export function inferTaskType(agentId: string): TaskType {
  const domain = AGENT_DOMAINS[agentId];
  if (!domain) return 'general';
  return DOMAIN_TASK_MAP[domain] ?? 'general';
}

// ── Config persistence (same pattern as voice-settings.ts) ──────────────

let cachedConfig: AgentRoutingConfig | null = null;

const DEFAULT_CONFIG: AgentRoutingConfig = {
  mode: 'one-provider',
  // No oneProvider set — falls back to legacy preferredEngine cascade
};

function ensureRuntimeDir(): void {
  const dir = dirname(SETTINGS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getRoutingConfig(): AgentRoutingConfig {
  if (cachedConfig) return cachedConfig;

  if (!existsSync(SETTINGS_PATH)) {
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }

  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentRoutingConfig>;
    cachedConfig = { ...DEFAULT_CONFIG, ...parsed };
    return cachedConfig;
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }
}

/**
 * Reset the module-level cache. For tests only — ensures the next
 * getRoutingConfig() call reads fresh from disk.
 */
export function resetRoutingCache(): void {
  cachedConfig = null;
}

export function setRoutingConfig(config: AgentRoutingConfig): void {
  ensureRuntimeDir();
  cachedConfig = config;
  writeFileSync(SETTINGS_PATH, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[agent-routing] config saved: mode=${config.mode}`);
}

// ── Routing resolution ─────────────────────────────────────────────────

/**
 * Resolve which provider + model an agent should use.
 *
 * Returns:
 *   - { providerId, modelId, engine } if routing is configured
 *   - null if no routing config exists (caller falls back to legacy
 *     preferredEngine cascade)
 *
 * The `engine` field maps the providerId to an EngineId for the ModelRouter's
 * pickEngine() — this resolves the namespace mismatch between ProviderRegistry
 * IDs and EngineId values.
 */
export function getRoutingForAgent(agentId: string): {
  providerId: string;
  modelId: string;
  engine: EngineId;
} | null {
  const config = getRoutingConfig();

  switch (config.mode) {
    case 'one-provider': {
      if (!config.oneProvider) return null; // not configured yet
      return {
        providerId: config.oneProvider.providerId,
        modelId: config.oneProvider.modelId,
        engine: providerIdToEngine(config.oneProvider.providerId),
      };
    }

    case 'mixed-provider': {
      const assignment = config.mixedAssignments?.[agentId];
      if (!assignment) {
        // Fall back to oneProvider if set, else null
        if (config.oneProvider) {
          return {
            providerId: config.oneProvider.providerId,
            modelId: config.oneProvider.modelId,
            engine: providerIdToEngine(config.oneProvider.providerId),
          };
        }
        return null;
      }
      return {
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        engine: providerIdToEngine(assignment.providerId),
      };
    }

    case 'auto-free': {
      const assignment = config.autoFreeAssignments?.[agentId];
      if (!assignment) return null;
      return {
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        engine: providerIdToEngine(assignment.providerId),
      };
    }

    default:
      return null;
  }
}

/**
 * Map a ProviderRegistry provider ID to an EngineId.
 * This resolves the namespace mismatch:
 *   - 'openrouter' → 'openrouter'
 *   - 'anthropic' → 'anthropic'
 *   - 'groq' → 'groq'
 *   - Custom LLM providers → 'openrouter' (assume OpenAI-compatible)
 *   - Unknown → null (no engine available)
 */
export function providerIdToEngine(providerId: string): EngineId {
  switch (providerId) {
    case 'openrouter': return 'openrouter';
    case 'anthropic': return 'anthropic';
    case 'groq': return 'groq';
    case 'ollama': return 'ollama';
    default:
      // Custom LLM providers — assume OpenAI-compatible (OpenRouter-style)
      return 'openrouter';
  }
}

// ── Mode validation ─────────────────────────────────────────────────────

/**
 * Count how many LLM providers have been tested + have at least 1 model loaded.
 * Used by the Mixed Provider gate to enforce ≥2 configured providers.
 */
export function countConfiguredLLMProviders(): number {
  return listProviders()
    .filter(p => p.category === 'llm' && p.connectionTested && p.apiKey && p.models.length > 0)
    .length;
}

/**
 * Get all configured LLM providers (tested + have models).
 */
export function getConfiguredLLMProviders(): ProviderRegistryEntry[] {
  return listProviders()
    .filter(p => p.category === 'llm' && p.connectionTested && p.apiKey && p.models.length > 0);
}

/**
 * Check if the Mixed Provider mode can be enabled.
 * Requires ≥2 configured LLM providers.
 */
export function canEnableMixedMode(): { canEnable: boolean; reason: string; configuredCount: number } {
  const count = countConfiguredLLMProviders();
  if (count < 2) {
    return {
      canEnable: false,
      reason: `Mixed Provider mode requires at least 2 configured LLM providers. You have ${count}. Open Settings → API Hub → Model API and click "Test & load" on at least one more provider.`,
      configuredCount: count,
    };
  }
  return { canEnable: true, reason: '', configuredCount: count };
}

// ── Auto Free allocation ────────────────────────────────────────────────

/**
 * Compute Auto Free assignments for all known agents.
 *
 * For each agent:
 *   1. Infer task type (reasoning/coding/documentation/general) from domain
 *   2. Find all free-tier models across configured providers
 *   3. Match: reasoning → largest context free model, coding → coding-focused
 *      free model, documentation → any free model, general → any free model
 *   4. If no free model available, leave the agent unassigned (shortfall)
 *
 * Returns the assignments + any shortfalls.
 */
export function computeAutoFreeAssignments(): {
  assignments: Record<string, AgentRoutingAssignment>;
  shortfalls: Array<{ agentId: string; taskType: TaskType; reason: string }>;
} {
  const providers = getConfiguredLLMProviders();
  const assignments: Record<string, AgentRoutingAssignment> = {};
  const shortfalls: Array<{ agentId: string; taskType: TaskType; reason: string }> = [];

  // Collect all free models across providers
  const allFreeModels: Array<{ provider: ProviderRegistryEntry; model: ProviderModel }> = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.costTier === 'free') {
        allFreeModels.push({ provider, model });
      }
    }
  }

  for (const [agentId, domain] of Object.entries(AGENT_DOMAINS)) {
    const taskType = inferTaskType(agentId);

    // Find the best free model for this task type
    const bestModel = findBestFreeModel(allFreeModels, taskType);

    if (bestModel) {
      assignments[agentId] = {
        providerId: bestModel.provider.id,
        modelId: bestModel.model.id,
      };
    } else {
      shortfalls.push({
        agentId,
        taskType,
        reason: `No free-tier model available for ${taskType} tasks. Available free models: ${allFreeModels.length}. Consider adding credits to a provider or configuring a companion provider.`,
      });
    }
  }

  return { assignments, shortfalls };
}

/**
 * Find the best free model for a given task type.
 *
 * Matching logic:
 *   - reasoning → prefer largest context window (for complex reasoning)
 *   - coding → prefer models with tool-use support (for code execution)
 *   - documentation → any free model (documentation is less demanding)
 *   - general → any free model
 */
function findBestFreeModel(
  freeModels: Array<{ provider: ProviderRegistryEntry; model: ProviderModel }>,
  taskType: TaskType,
): { provider: ProviderRegistryEntry; model: ProviderModel } | null {
  if (freeModels.length === 0) return null;

  switch (taskType) {
    case 'reasoning': {
      // Prefer largest context window
      const sorted = [...freeModels].sort((a, b) =>
        (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0)
      );
      return sorted[0];
    }
    case 'coding': {
      // Prefer models with tool-use support, then largest context
      const withToolUse = freeModels.filter(m => m.model.supportsToolUse);
      if (withToolUse.length > 0) {
        const sorted = [...withToolUse].sort((a, b) =>
          (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0)
        );
        return sorted[0];
      }
      // Fall back to largest context
      const sorted = [...freeModels].sort((a, b) =>
        (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0)
      );
      return sorted[0];
    }
    case 'documentation':
    case 'general':
    default: {
      // Any free model — prefer smallest context (less resource waste)
      const sorted = [...freeModels].sort((a, b) =>
        (a.model.contextWindow ?? 0) - (b.model.contextWindow ?? 0)
      );
      return sorted[0];
    }
  }
}

/**
 * Set the routing mode + apply it.
 * For 'auto-free', this recomputes the assignments.
 * For 'mixed-provider', this validates ≥2 providers are configured.
 */
export function setRoutingMode(mode: RoutingMode): {
  success: boolean;
  config: AgentRoutingConfig;
  shortfalls?: Array<{ agentId: string; taskType: TaskType; reason: string }>;
  error?: string;
} {
  const config = getRoutingConfig();

  if (mode === 'mixed-provider') {
    const check = canEnableMixedMode();
    if (!check.canEnable) {
      return { success: false, config, error: check.reason };
    }
  }

  config.mode = mode;

  if (mode === 'auto-free') {
    const { assignments, shortfalls } = computeAutoFreeAssignments();
    config.autoFreeAssignments = assignments;
    setRoutingConfig(config);
    return { success: true, config, shortfalls };
  }

  setRoutingConfig(config);
  return { success: true, config };
}

/**
 * Set the One Provider assignment (all agents use this provider+model).
 */
export function setOneProvider(providerId: string, modelId: string): void {
  const config = getRoutingConfig();
  config.oneProvider = { providerId, modelId };
  setRoutingConfig(config);
}

/**
 * Set a per-agent assignment in Mixed Provider mode.
 */
export function setAgentAssignment(agentId: string, providerId: string, modelId: string): void {
  const config = getRoutingConfig();
  if (!config.mixedAssignments) config.mixedAssignments = {};
  config.mixedAssignments[agentId] = { providerId, modelId };
  setRoutingConfig(config);
}
