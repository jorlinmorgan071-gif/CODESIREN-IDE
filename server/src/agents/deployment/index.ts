// Deployment Agent — Platform config, environment setup, release preparation
//
// Phase 3: wired into the TaskState system for resumption support.
// This is the prototype agent for task-state tracking — single-shot execution
// with incremental state persistence. If the process dies mid-execution, the
// state file on disk reflects exactly how much text was generated.
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import {
  initTaskState,
  startStep,
  completeStep,
  completeTask,
  markInterrupted,
  loadTaskState,
  getResumptionPoint,
} from '../../orchestration/task-state.js';

const SYSTEM_PROMPT = `You are the Deployment Agent of Zero Two: Code Siren.
Your role: platform-specific configuration, environment setup, release preparation, and rollout monitoring.
When deploying:
1. Identify the target platform (Vercel, Netlify, Railway, Docker, AWS, GCP, Azure).
2. Generate the platform config (vercel.json, netlify.toml, Dockerfile, docker-compose).
3. Specify environment variables, build commands, and output directories.
4. Set up health checks, rollback strategy, and deployment monitoring.
Show real config files.`;

export class DeploymentAgent extends IAgent {
  readonly id = 'deployment-agent';
  readonly name = 'Deployment Agent';
  readonly domain: AgentDomain = 'DEPLOYMENT';
  readonly icon = 'rocket';
  readonly color = '#D946EF';
  constructor() { super(0.84); }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    // ── Phase 3: TaskState initialization ──────────────────────────────
    // Check if this task was previously interrupted (resumption)
    const resumption = getResumptionPoint(task.id);
    let state;

    if (resumption.shouldResume && resumption.state) {
      // Resuming an interrupted task — use the existing state
      state = resumption.state;
      console.log(`[deployment-agent] resuming task ${task.id} from step ${resumption.resumeFromStep! + 1}: ${resumption.reason}`);
    } else {
      // New task — initialize state with the plan
      state = initTaskState({
        taskId: task.id,
        agentId: this.id,
        goal: task.description,
        steps: [
          { label: 'Generate deployment configuration' },
          { label: 'Memorize deployment output' },
        ],
      });
    }

    const resumeFromStep = resumption.shouldResume ? (resumption.resumeFromStep ?? 0) : 0;

    try {
      let full = '';

      // ── Step 0: Generate deployment configuration ────────────────────
      if (resumeFromStep <= 0) {
        startStep(task.id, 0);
        for await (const chunk of dispatchStrategy(task, signal, {
          systemPrompt: SYSTEM_PROMPT, temperature: 0.4, maxTokens: 1024, agentId: this.id, domain: this.domain,
        })) {
          if (chunk.type === 'text') full += chunk.content;
          yield chunk;
        }
        completeStep(task.id, 0, {
          output: full,
          // In this prototype, no files are changed on disk (text output only).
          // A real deployment agent might write vercel.json / Dockerfile —
          // those would be listed here as changedFiles.
        });
      } else {
        // Step 0 was already completed — load its output from state
        full = state.steps[0]?.output ?? '';
        yield { type: 'text', content: '(resumed — step 1 already completed)' };
      }

      // ── Step 1: Memorize deployment output ──────────────────────────
      if (resumeFromStep <= 1) {
        startStep(task.id, 1);
        await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['deployment', task.type] });
        completeStep(task.id, 1, {
          output: `Memorized ${full.length} chars of deployment output`,
        });
      }

      // ── Mark task complete ──────────────────────────────────────────
      completeTask(task.id, full);
    } catch (err: any) {
      // Mark the task as interrupted (not failed) if the process was killed
      // vs. a genuine error. For the prototype, we treat all errors as
      // interruptions — the state file preserves what was done.
      markInterrupted(task.id);
      yield { type: 'error', content: err.message, meta: { recoverable: true } };
    }
  }
}
