// server/src/agents/base-agent.ts
// IAgent abstract class — PDF Section 05.
//
// Every absorbed agent (Fabrication, Operative, Sentinel) AND every Engineering-
// Pillar agent implements this. No agent is exempt from Ghost Mode's authority
// (directive Section 3).
//
// Step 3 addendum (directive Section 1): agents gain a `skills: SkillRef[]`
// capability list. Skills are NOT agents — they are tool sequences invoked BY
// agents through the existing toolRegistry. The Extension Agent manages the
// Skills Vault; other agents can declare which installed skills they can invoke.

import type {
  AgentDomain,
  AgentStatus,
  AgentTask,
  AgentChunk,
  ReviewResult,
  MemoryChunk,
  MemoryMeta,
  ProjectContext,
} from '../types.js';
import type { SkillRef } from '../skills/manifest.js';
import { memoryEngine } from '../memory/engine.js';

export abstract class IAgent {
  abstract readonly id: string;            // e.g. 'architect-agent'
  abstract readonly name: string;          // e.g. 'Architect Agent'
  abstract readonly domain: AgentDomain;   // e.g. 'ARCHITECT'
  abstract readonly icon: string;          // lucide icon name (matches UI)
  abstract readonly color: string;         // hex color (matches UI domain color)

  trustScore: number;                      // 0.0 – 1.0, persisted in agent_states
  status: AgentStatus;                     // IDLE | RUNNING | REVIEWING | ERROR | PAUSED
  protected context: ProjectContext | null = null;

  // Skills capability list (Step 3). Defaults to empty — agents opt in by
  // overriding `acceptsSkills = true` and populating `skills` at construction
  // or via installSkill(). The Extension Agent manages the Skills Vault;
  // other agents just hold SkillRefs to invoke.
  acceptsSkills = false;
  skills: SkillRef[] = [];

  constructor(initialTrust = 0.8) {
    this.trustScore = initialTrust;
    this.status = 'IDLE';
  }

  // ── Core lifecycle ────────────────────────────────────────────────────
  async init(context: ProjectContext): Promise<void> {
    this.context = context;
  }

  // The single execution entry point. Streams chunks back to AgentManager.
  // PDF Section 05 contract. MUST wrap in try/catch internally and yield an
  // 'error' chunk on failure (PDF Section 20 error-handling pattern).
  abstract execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk>;

  async review(_output: { content: string; files?: string[] }): Promise<ReviewResult> {
    // Default: no review. Specialized agents (Code Review, Security) override.
    return { approved: true, score: 100, notes: 'No review implemented', issues: [] };
  }

  pause(): void { this.status = 'PAUSED'; }
  resume(): void { this.status = 'IDLE'; }

  // ── Memory ────────────────────────────────────────────────────────────
  // Per Fix 1: these now delegate to the shared MemoryEngine singleton,
  // which uses ModelRouter.embed() for real embeddings (Ollama/OpenAI/stub)
  // and the agent_memory table (pgvector) or in-memory store for search.
  // ALL 20 agents get real memory through this base class — not just Memory Agent.
  async recall(query: string, limit = 5): Promise<MemoryChunk[]> {
    return memoryEngine.search(query, limit);
  }
  async memorize(content: string, meta: MemoryMeta): Promise<void> {
    await memoryEngine.memorize(content, meta, this.id);
  }

  // ── Skills (Step 3) ───────────────────────────────────────────────────
  addSkill(ref: SkillRef): void {
    if (!this.skills.find((s) => s.name === ref.name)) {
      this.skills.push(ref);
    }
  }

  listSkills(): SkillRef[] {
    return [...this.skills];
  }

  // ── Trust score ───────────────────────────────────────────────────────
  // PDF Section 20: updateTrustScore on success/failure
  updateTrustScore(outcome: 'success' | 'failure', weight: number): void {
    // Simple EMA — replace with the real trust algorithm in a later step
    if (outcome === 'success') {
      this.trustScore = Math.min(1, this.trustScore * 0.95 + 0.95 * 0.05 * weight);
    } else {
      this.trustScore = Math.max(0, this.trustScore * 0.9 - 0.1 * weight);
    }
  }
}

