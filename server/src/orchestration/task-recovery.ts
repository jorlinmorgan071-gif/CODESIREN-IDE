// server/src/orchestration/task-recovery.ts
// UPR Phase 4 Steps 4 & 5 — Shortfall Handling + Mid-Task Failure Recovery.
//
// Step 4: When computeAutoFreeAssignments() returns shortfalls (agents that
// can't be matched to a free-tier model), this module provides two resolution
// paths:
//   (a) Credit-purchase: confirm credit was added → refresh models → fill
//       remaining agents with the lowest-cost paid models available.
//   (b) Companion Provider: preview free models on other configured providers,
//       recommend the best fit. If no companion is configured, prompt to add one.
//
// Step 5: When a task halts mid-execution (context exhausted, provider stopped
// responding, or the stale-task detector fires), this module:
//   1. Detects the halt condition + classifies it (reuses suggestRemediation)
//   2. Surfaces a diagnostic panel with the problem + available alternatives
//   3. Offers: global-switch (all agents) or single-agent-targeted-switch
//   4. On resume: reads the halted task's TaskState via getResumptionPoint()
//      and hands the resumption info to the incoming model
//
// The stale-task detector's task:stale-detected event is wired as a real
// trigger for this recovery flow — not a separate, disconnected mechanism.

import { listProviders, getProvider, suggestRemediation } from '../provider-registry/registry.js';
import type { ProviderRegistryEntry, ProviderModel } from '../provider-registry/types.js';
import { getResumptionPoint, loadTaskState, markInterrupted, type TaskState } from './task-state.js';
import { getRoutingConfig, setRoutingMode, setAgentAssignment, setOneProvider, providerIdToEngine, getConfiguredLLMProviders, computeAutoFreeAssignments, inferTaskType, type AgentRoutingAssignment, type TaskType } from './agent-routing.js';
import { makeEvent, broadcast } from '../ws/events.js';

// ── Step 4: Shortfall Handling ──────────────────────────────────────────

export interface ShortfallResolution {
  agentId: string;
  taskType: TaskType;
  resolved: boolean;
  assignment?: AgentRoutingAssignment;
  resolution?: 'credit-purchase' | 'companion-provider';
  reason: string;
}

export interface CreditPurchaseResult {
  refreshed: boolean;
  newModels: Array<{ providerId: string; modelId: string; modelName: string; costTier: string }>;
  resolutions: ShortfallResolution[];
  remainingShortfalls: Array<{ agentId: string; taskType: TaskType; reason: string }>;
}

export interface CompanionProviderResult {
  hasCompanion: boolean;
  companionModels: Array<{ providerId: string; providerName: string; modelId: string; modelName: string; isFree: boolean; contextWindow: number }>;
  recommendedModel?: { providerId: string; modelId: string; reason: string };
  resolutions: ShortfallResolution[];
  remainingShortfalls: Array<{ agentId: string; taskType: TaskType; reason: string }>;
  promptToAddProvider?: string;
}

/**
 * Path (a): Credit-purchase resolution.
 *
 * After the user confirms they've added credits to a provider, this:
 *   1. Re-reads the provider's model list (assumes models were refreshed via
 *      "Test & load" — this function reads the current registry state)
 *   2. For each shortfall agent, finds the lowest-cost paid model that fits
 *      the agent's task type
 *   3. Returns the assignments + any remaining shortfalls
 */
export function resolveShortfallsViaCreditPurchase(
  shortfalls: Array<{ agentId: string; taskType: TaskType; reason: string }>,
  creditedProviderId: string,
): CreditPurchaseResult {
  const provider = getProvider(creditedProviderId);
  const newModels: CreditPurchaseResult['newModels'] = [];
  const resolutions: ShortfallResolution[] = [];
  const remainingShortfalls: CreditPurchaseResult['remainingShortfalls'] = [];

  if (!provider || !provider.connectionTested) {
    return {
      refreshed: false,
      newModels: [],
      resolutions: [],
      remainingShortfalls: shortfalls.map(s => ({ ...s, reason: `Provider ${creditedProviderId} is not tested or not found. Run "Test & load" first.` })),
    };
  }

  // Collect low-cost paid models from the credited provider
  const lowCostModels = provider.models
    .filter(m => m.costTier !== 'free') // paid models (the ones credits unlock)
    .sort((a, b) => {
      // Prefer lower pricing (cheapest first)
      // pricingNote is a string like "$3/MTok in, $15/MTok out" — rough sort
      const aPrice = parseFloat(a.pricingNote.match(/\$([\d.]+)/)?.[1] ?? '999');
      const bPrice = parseFloat(b.pricingNote.match(/\$([\d.]+)/)?.[1] ?? '999');
      return aPrice - bPrice;
    });

  for (const model of lowCostModels) {
    newModels.push({
      providerId: creditedProviderId,
      modelId: model.id,
      modelName: model.name,
      costTier: model.costTier,
    });
  }

  // Assign each shortfall agent to the best low-cost model for its task type
  for (const shortfall of shortfalls) {
    const bestModel = findBestLowCostModel(lowCostModels, shortfall.taskType);
    if (bestModel) {
      resolutions.push({
        agentId: shortfall.agentId,
        taskType: shortfall.taskType,
        resolved: true,
        assignment: { providerId: creditedProviderId, modelId: bestModel.id },
        resolution: 'credit-purchase',
        reason: `Assigned to ${bestModel.name} (${bestModel.id}) on ${provider.displayName} — lowest-cost model for ${shortfall.taskType} tasks.`,
      });
    } else {
      remainingShortfalls.push(shortfall);
    }
  }

  return { refreshed: true, newModels, resolutions, remainingShortfalls };
}

/**
 * Path (b): Companion Provider resolution.
 *
 * Looks at OTHER configured providers (not the one with shortfalls) for
 * free-tier models that could fill the gap. Recommends the best fit.
 * If no companion provider is configured, returns a prompt to add one.
 */
export function resolveShortfallsViaCompanion(
  shortfalls: Array<{ agentId: string; taskType: TaskType; reason: string }>,
  primaryProviderId: string, // the provider that had the shortfalls
): CompanionProviderResult {
  const companionProviders = getConfiguredLLMProviders()
    .filter(p => p.id !== primaryProviderId);

  if (companionProviders.length === 0) {
    return {
      hasCompanion: false,
      companionModels: [],
      resolutions: [],
      remainingShortfalls: shortfalls,
      promptToAddProvider: `No companion provider is configured. To resolve shortfalls, add another LLM provider in Settings → API Hub → Model API and click "Test & load". A free-tier provider (like OpenRouter) would give you access to free models across multiple model families.`,
    };
  }

  // Collect all free models from companion providers
  const companionModels: CompanionProviderResult['companionModels'] = [];
  for (const provider of companionProviders) {
    for (const model of provider.models) {
      companionModels.push({
        providerId: provider.id,
        providerName: provider.displayName,
        modelId: model.id,
        modelName: model.name,
        isFree: model.costTier === 'free',
        contextWindow: model.contextWindow,
      });
    }
  }

  // Find the best free companion model (for recommendation)
  const freeCompanionModels = companionModels.filter(m => m.isFree);
  let recommendedModel: CompanionProviderResult['recommendedModel'];
  if (freeCompanionModels.length > 0) {
    // Recommend the one with the largest context (best for general use)
    const best = [...freeCompanionModels].sort((a, b) => b.contextWindow - a.contextWindow)[0];
    recommendedModel = {
      providerId: best.providerId,
      modelId: best.modelId,
      reason: `${best.modelName} on ${best.providerName} — free model with the largest context window (${(best.contextWindow / 1000).toFixed(0)}K tokens). Best fit for agents that couldn't get a free model on the primary provider.`,
    };
  }

  // Assign shortfall agents to companion free models
  const resolutions: ShortfallResolution[] = [];
  const remainingShortfalls: CompanionProviderResult['remainingShortfalls'] = [];

  for (const shortfall of shortfalls) {
    const freeModels = companionProviders.flatMap(p =>
      p.models.filter(m => m.costTier === 'free')
        .map(m => ({ provider: p, model: m }))
    );

    const best = findBestFreeModelAcrossProviders(freeModels, shortfall.taskType);
    if (best) {
      resolutions.push({
        agentId: shortfall.agentId,
        taskType: shortfall.taskType,
        resolved: true,
        assignment: { providerId: best.provider.id, modelId: best.model.id },
        resolution: 'companion-provider',
        reason: `Assigned to ${best.model.name} on ${best.provider.displayName} (companion provider) — free model for ${shortfall.taskType} tasks.`,
      });
    } else {
      remainingShortfalls.push(shortfall);
    }
  }

  return { hasCompanion: true, companionModels, recommendedModel, resolutions, remainingShortfalls };
}

function findBestLowCostModel(models: ProviderModel[], taskType: TaskType): ProviderModel | null {
  if (models.length === 0) return null;
  switch (taskType) {
    case 'reasoning':
      return [...models].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0];
    case 'coding':
      return models.find(m => m.supportsToolUse) ?? models[0];
    default:
      return models[0]; // cheapest (already sorted by price)
  }
}

function findBestFreeModelAcrossProviders(
  models: Array<{ provider: ProviderRegistryEntry; model: ProviderModel }>,
  taskType: TaskType,
): { provider: ProviderRegistryEntry; model: ProviderModel } | null {
  if (models.length === 0) return null;
  switch (taskType) {
    case 'reasoning':
      return [...models].sort((a, b) => (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0))[0];
    case 'coding': {
      const withToolUse = models.filter(m => m.model.supportsToolUse);
      if (withToolUse.length > 0) {
        return [...withToolUse].sort((a, b) => (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0))[0];
      }
      return [...models].sort((a, b) => (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0))[0];
    }
    default:
      return models[0];
  }
}

// ── Step 5: Mid-Task Failure Recovery ───────────────────────────────────

export type HaltReason = 'context-exhausted' | 'provider-stopped-responding' | 'rate-limit' | 'auth-failed' | 'network-error' | 'stale-detected' | 'unknown';

export interface DiagnosticPanel {
  taskId: string;
  agentId: string;
  haltReason: HaltReason;
  errorMessage: string;
  remediation: string; // from suggestRemediation()
  currentProvider: string;
  currentModel: string;
  availableAlternatives: Array<{
    providerId: string;
    providerName: string;
    modelId: string;
    modelName: string;
    isFree: boolean;
    contextWindow: number;
  }>;
  resumptionPoint: {
    shouldResume: boolean;
    resumeFromStep: number | null;
    reason: string;
    completedSteps: number;
    totalSteps: number;
  };
  taskState: TaskState | null;
}

export interface RecoverySwitch {
  type: 'global' | 'single-agent';
  taskId: string;
  agentId: string;
  newProviderId: string;
  newModelId: string;
  resumptionPrompt: string; // the text handed to the incoming model
}

/**
 * Detect a halt condition from an error during agent execution.
 * Returns the classified reason + the diagnostic panel data.
 */
export function diagnoseHalt(taskId: string, agentId: string, error: Error): DiagnosticPanel {
  const errorMsg = error.message ?? String(error);
  const haltReason = classifyHaltReason(errorMsg);
  const remediation = suggestRemediation(error);

  // Get current routing for this agent
  const routing = getRoutingConfig();
  let currentProvider = 'unknown';
  let currentModel = 'unknown';

  const agentRouting = routing.mode === 'one-provider' ? routing.oneProvider
    : routing.mode === 'mixed-provider' ? routing.mixedAssignments?.[agentId]
    : routing.mode === 'auto-free' ? routing.autoFreeAssignments?.[agentId]
    : undefined;

  if (agentRouting) {
    currentProvider = agentRouting.providerId;
    currentModel = agentRouting.modelId;
  }

  // Get available alternatives (all models from other configured providers)
  const alternatives = getConfiguredLLMProviders()
    .filter(p => p.id !== currentProvider)
    .flatMap(p => p.models.map(m => ({
      providerId: p.id,
      providerName: p.displayName,
      modelId: m.id,
      modelName: m.name,
      isFree: m.costTier === 'free',
      contextWindow: m.contextWindow,
    })));

  // Get the task's resumption point
  const resumption = getResumptionPoint(taskId);
  const taskState = loadTaskState(taskId);

  const completedSteps = taskState?.steps.filter(s => s.status === 'succeeded').length ?? 0;
  const totalSteps = taskState?.steps.length ?? 0;

  // Mark the task as interrupted if it's still in-progress
  if (taskState && taskState.status === 'in-progress') {
    markInterrupted(taskId);
  }

  return {
    taskId,
    agentId,
    haltReason,
    errorMessage: errorMsg.slice(0, 500),
    remediation,
    currentProvider,
    currentModel,
    availableAlternatives: alternatives,
    resumptionPoint: {
      shouldResume: resumption.shouldResume,
      resumeFromStep: resumption.resumeFromStep,
      reason: resumption.reason,
      completedSteps,
      totalSteps,
    },
    taskState,
  };
}

/**
 * Classify the halt reason from an error message.
 * Maps to the same patterns as suggestRemediation.
 */
function classifyHaltReason(errorMsg: string): HaltReason {
  const msg = errorMsg.toLowerCase();
  if (msg.includes('context') && (msg.includes('exhaust') || msg.includes('exceed') || msg.includes('too long') || msg.includes('maximum context'))) {
    return 'context-exhausted';
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
    return 'rate-limit';
  }
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('api key')) {
    return 'auth-failed';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return 'provider-stopped-responding';
  }
  if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('network')) {
    return 'network-error';
  }
  return 'unknown';
}

/**
 * Execute a recovery switch — either global (all agents) or single-agent.
 *
 * Reads the halted task's TaskState + getResumptionPoint() output and
 * constructs the resumption prompt that the incoming model will receive.
 */
export function executeRecoverySwitch(opts: {
  type: 'global' | 'single-agent';
  taskId: string;
  agentId: string;
  newProviderId: string;
  newModelId: string;
}): RecoverySwitch {
  const { type, taskId, agentId, newProviderId, newModelId } = opts;

  // Apply the routing change
  if (type === 'global') {
    setOneProvider(newProviderId, newModelId);
  } else {
    setAgentAssignment(agentId, newProviderId, newModelId);
  }

  // Get the resumption point — this is Phase 3's actual output
  const resumption = getResumptionPoint(taskId);
  const taskState = loadTaskState(taskId);

  // Build the resumption prompt that will be handed to the incoming model
  let resumptionPrompt = '';
  if (resumption.shouldResume && taskState) {
    const completedSteps = taskState.steps.filter(s => s.status === 'succeeded');
    const remainingSteps = taskState.steps.filter(s => s.status !== 'succeeded');
    const resumeStep = resumption.resumeFromStep !== null
      ? taskState.steps[resumption.resumeFromStep]
      : remainingSteps[0];

    resumptionPrompt = `You are resuming a task that was interrupted. Here is the full context:

GOAL: ${taskState.goal}

COMPLETED STEPS (${completedSteps.length} of ${taskState.steps.length}):
${completedSteps.map((s, i) => `${i + 1}. ${s.label} — ${s.status}${s.output ? `\n   Output: ${s.output.slice(0, 500)}` : ''}`).join('\n')}

INTERRUPTION POINT:
The task was interrupted at step ${resumption.resumeFromStep !== null ? resumption.resumeFromStep + 1 : '?'} ("${resumeStep?.label ?? 'unknown'}"). This step was in-progress but did not complete.

REMAINING STEPS (${remainingSteps.length}):
${remainingSteps.map((s, i) => `${completedSteps.length + i + 1}. ${s.label}`).join('\n')}

CHANGED FILES SO FAR:
${taskState.changedArtifacts.length > 0 ? taskState.changedArtifacts.join('\n') : '(none yet)'}

RESUMPTION INSTRUCTION: Continue from step ${resumption.resumeFromStep !== null ? resumption.resumeFromStep + 1 : completedSteps.length + 1}. Do NOT redo completed steps. Pick up where the previous model left off.`;
  } else {
    resumptionPrompt = `Task ${taskId} could not be resumed: ${resumption.reason}`;
  }

  const switchResult: RecoverySwitch = {
    type,
    taskId,
    agentId,
    newProviderId,
    newModelId,
    resumptionPrompt,
  };

  // Broadcast the switch event so the UI can update
  try {
    broadcast(makeEvent('task:recovery-switch' as any, {
      taskId,
      agentId,
      switchType: type,
      newProviderId,
      newModelId,
      shouldResume: resumption.shouldResume,
      resumeFromStep: resumption.resumeFromStep,
      resumptionPrompt,
    }));
  } catch (err) {
    // broadcast may fail if WS server isn't running
    console.warn('[task-recovery] failed to broadcast recovery-switch event:', err);
  }

  console.log(`[task-recovery] ${type} switch applied: ${agentId} → ${newProviderId}/${newModelId}, resume from step ${resumption.resumeFromStep}`);

  return switchResult;
}

/**
 * Handle a task:stale-detected event from the stale-task detector.
 *
 * This is the integration point between Phase 3's stale detector and
 * Phase 4's recovery flow. When a stale task is detected, this:
 *   1. Loads the TaskState
 *   2. Diagnoses the halt (stale-detected reason)
 *   3. Broadcasts a task:recovery-needed event with the diagnostic panel
 *
 * This is NOT a separate detection mechanism — it's the same recovery
 * flow, triggered by a different input (stale detector vs. caught error).
 */
export function handleStaleTaskDetection(detection: {
  taskId: string;
  agentId: string;
  goal: string;
  previouslyStatus: string;
  staleForMs: number;
  resumeFromStep: number | null;
  resumeReason: string;
}): DiagnosticPanel {
  // Build a diagnostic panel using the stale-detected reason
  const taskState = loadTaskState(detection.taskId);
  const errorMsg = `Task went stale — status was "${detection.previouslyStatus}" for ${Math.round(detection.staleForMs / 1000)}s. The task was likely interrupted by a process crash or network failure.`;

  const diagnostic: DiagnosticPanel = {
    taskId: detection.taskId,
    agentId: detection.agentId,
    haltReason: 'stale-detected',
    errorMessage: errorMsg,
    remediation: 'The task was interrupted unexpectedly. You can resume it with the same provider or switch to a different one. The task state (completed steps, changed files, remaining work) has been preserved.',
    currentProvider: 'unknown',
    currentModel: 'unknown',
    availableAlternatives: getConfiguredLLMProviders()
      .flatMap(p => p.models.map(m => ({
        providerId: p.id,
        providerName: p.displayName,
        modelId: m.id,
        modelName: m.name,
        isFree: m.costTier === 'free',
        contextWindow: m.contextWindow,
      }))),
    resumptionPoint: {
      shouldResume: true,
      resumeFromStep: detection.resumeFromStep,
      reason: detection.resumeReason,
      completedSteps: taskState?.steps.filter(s => s.status === 'succeeded').length ?? 0,
      totalSteps: taskState?.steps.length ?? 0,
    },
    taskState,
  };

  // Broadcast a recovery-needed event so the UI can show the diagnostic panel
  try {
    broadcast(makeEvent('task:recovery-needed' as any, diagnostic));
  } catch (err) {
    console.warn('[task-recovery] failed to broadcast recovery-needed event:', err);
  }

  console.log(`[task-recovery] stale task detected → recovery needed: ${detection.taskId} (agent=${detection.agentId}, resume from step ${detection.resumeFromStep})`);

  return diagnostic;
}
