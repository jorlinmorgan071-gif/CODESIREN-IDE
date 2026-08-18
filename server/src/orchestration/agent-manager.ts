// server/src/orchestration/agent-manager.ts
// AgentManager — PDF Section 14.
//
// `send(task)` is the SINGLE entry point for any agent invocation.
// A spoken command, a typed command, and (later) a gesture all resolve to the
// SAME AgentTask shape and travel through the SAME send() call (directive Section 7).
//
// Step 2: now wraps every run in a trace (startTrace / addStep / completeTrace)
// so each strategy invocation is inspectable. The trace format is the seed of
// server/observability/ (Section 6 #10) — captured now while it's cheap.

import { v4 as uuid } from 'uuid';
import type { IAgent } from '../agents/base-agent.js';
import type {
  AgentTask,
  AgentChunk,
  AgentEvent,
} from '../types.js';
import { makeEvent, broadcast } from '../ws/events.js';
import { ghostMode } from './ghost-mode.js';
import {
  startTrace,
  completeTrace,
  setOutcome,
  addStep,
} from '../observability/traces.js';
import { contextManager } from '../context/manager.js';

class AgentManager {
  private agents = new Map<string, IAgent>();
  private activeTasks = new Map<string, { task: AgentTask; abort: AbortController }>();

  // ── Phase B (Context Manager) — assemble contextBundle for a task ────────
  //
  // Per directive Section 4: this is called inside send() / executeAndWait()
  // BEFORE the task reaches the target agent. The result is attached to the
  // task as `task.contextBundle` (an additive optional field — see types.ts).
  //
  // TIMEOUT + FAIL-OPEN BEHAVIOR (deliberate exception to fail-closed):
  //
  //   The whole rest of Code Siren fails closed — if anything goes wrong,
  //   the operation is aborted. This is the ONE deliberate exception:
  //   context assembly failing should NOT block the agent pipeline. The
  //   agent can still do its job without an assembled bundle (it'll just
  //   have less context). Blocking here would turn a context-assembly bug
  //   into a complete outage of the agent system, which is much worse
  //   than a degraded (bundle-less) dispatch.
  //
  //   DO NOT "fix" this to fail-closed without explicit discussion — the
  //   trade-off is intentional and documented per directive Section 4.
  //
  // Implementation:
  //   - 2-second outer timeout via Promise.race
  //   - On timeout OR any thrown error: log the failure and return undefined
  //   - The caller (send/executeAndWait) attaches the result to
  //     task.contextBundle; undefined means "no bundle, dispatch anyway"
  private async assembleContextBundle(task: AgentTask): Promise<import('../context/types.js').ContextBundle | undefined> {
    const ASSEMBLE_TIMEOUT_MS = 2000;
    const userId = task.context.userId ?? 'unknown';
    const agentId = task.agentId;
    // modelId is '' in Phase B — the budget module falls back to 32K + warning.
    // A future phase can populate this when model selection gets richer.
    const modelId = '';

    try {
      const result = await Promise.race([
        contextManager.assemble({ userId, agentId, task, modelId }),
        new Promise<undefined>((resolve) =>
          setTimeout(() => {
            console.warn(`[manager] context assembly timed out after ${ASSEMBLE_TIMEOUT_MS}ms (task=${task.id}) — dispatching without bundle (fail-open)`);
            resolve(undefined);
          }, ASSEMBLE_TIMEOUT_MS),
        ),
      ]);
      return result;
    } catch (err: any) {
      console.warn(`[manager] context assembly failed: ${err.message} (task=${task.id}) — dispatching without bundle (fail-open)`);
      return undefined;
    }
  }

  register(agent: IAgent): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent already registered: ${agent.id}`);
    }
    this.agents.set(agent.id, agent);
    console.log(`[manager] registered agent ${agent.id} (${agent.domain})`);
  }

  get(agentId: string): IAgent | undefined {
    return this.agents.get(agentId);
  }

  list(): IAgent[] {
    return [...this.agents.values()];
  }

  // The single entry point. Typed chat → send(). Spoken command → send().
  // Gesture → send(). Same shape, same bus, same governance, same tracing.
  async send(task: AgentTask): Promise<void> {
    const agent = this.agents.get(task.agentId);
    if (!agent) {
      const errEvent = makeEvent('agent:error', {
        agentId: task.agentId,
        taskId: task.id,
        error: `Unknown agent: ${task.agentId}`,
        recoverable: false,
      });
      broadcast(errEvent);
      return;
    }

    // Start the trace — one per task, 1:1 with taskId
    startTrace({
      taskId: task.id,
      agentId: agent.id,
      domain: agent.domain,
      executionMode: task.executionMode,
      input: task.description,
    });
    addStep(task.id, {
      kind: 'llm-call',
      label: `task received — agent=${agent.id} mode=${task.executionMode} origin=${task.origin}`,
      meta: { taskType: task.type, priority: task.priority },
    });

    // ── Phase B (Context Manager) — assemble the contextBundle ────────
    // Per directive Section 4: this happens BEFORE the task reaches the
    // agent. The result is attached to the task as an additive optional
    // field. Fail-open: if assembly fails or times out (2s), the task
    // is dispatched with contextBundle === undefined.
    const bundle = await this.assembleContextBundle(task);
    if (bundle) {
      task.contextBundle = bundle;
      addStep(task.id, {
        kind: 'llm-call',
        label: `context bundle assembled — used=${bundle.tokenBudget.used}/${bundle.tokenBudget.max} tokens, ${bundle.tokenBudget.truncated.length} source(s) truncated`,
        meta: {
          openFiles: bundle.openFiles.length,
          hasSelection: bundle.selection !== null,
          projectGraphNodes: bundle.projectGraph.length,
          historyTurns: bundle.conversationHistory.length,
          memoryEntries: bundle.relevantMemory.length,
          truncated: bundle.tokenBudget.truncated,
        },
      });
    } else {
      addStep(task.id, {
        kind: 'llm-call',
        label: `context bundle NOT assembled (fail-open — see assembleContextBundle comment)`,
      });
    }

    const abort = new AbortController();
    this.activeTasks.set(task.id, { task, abort });

    // agent:start — PDF Section 13
    broadcast(makeEvent('agent:start', {
      agentId: agent.id,
      taskId: task.id,
      taskType: task.type,
      description: task.description,
    }));

    // agent:status — agent is now RUNNING
    broadcast(makeEvent('agent:status', {
      agentId: agent.id,
      status: 'RUNNING',
      trustScore: agent.trustScore,
    }));

    try {
      let lastProgressEmit = 0;
      for await (const chunk of agent.execute(task, abort.signal)) {
        // agent:chunk — PDF Section 13
        broadcast(makeEvent('agent:chunk', {
          agentId: agent.id,
          taskId: task.id,
          type: chunk.type,
          content: chunk.content,
          meta: chunk.meta,
        }));

        // Throttle progress events to once per 200ms
        const now = Date.now();
        if (now - lastProgressEmit > 200) {
          lastProgressEmit = now;
          broadcast(makeEvent('agent:progress', {
            agentId: agent.id,
            taskId: task.id,
            progress: chunk.type === 'progress' ? Number(chunk.meta?.progress ?? 0) : undefined,
            eta: chunk.meta?.eta as number | undefined,
          }));
        }

        // Don't break on 'done' — let the generator exhaust naturally so
        // any cleanup code AFTER the yield loop (e.g. this.memorize()) runs.
        // The 'done' chunk is just a signal that content streaming is finished.
        if (chunk.type === 'error') {
          // Agent reported an error — update trust score (PDF Section 20 pattern)
          agent.updateTrustScore('failure', 0);
          setOutcome(task.id, 'error', chunk.content);
          break;
        }
      }

      // agent:complete
      broadcast(makeEvent('agent:complete', {
        agentId: agent.id,
        taskId: task.id,
        result: 'ok',
        duration: Date.now() - task.createdAt,
      }));

      // Complete the trace (persists to .traces/runs.jsonl)
      completeTrace(task.id, '(trace captured)');

      // Trust score up on success
      agent.updateTrustScore('success', 0.9);
    } catch (err: any) {
      broadcast(makeEvent('agent:error', {
        agentId: agent.id,
        taskId: task.id,
        error: err.message,
        recoverable: true,
      }));
      agent.updateTrustScore('failure', 0);
      setOutcome(task.id, 'error', err.message);
      completeTrace(task.id, `(error: ${err.message})`);
    } finally {
      this.activeTasks.delete(task.id);
      broadcast(makeEvent('agent:status', {
        agentId: agent.id,
        status: 'IDLE',
        trustScore: agent.trustScore,
      }));
    }
  }

  // PDF Section 14 — agent-to-agent communication goes through this too.
  async routeMessage(msg: {
    from: string;
    to: string[];
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const event: AgentEvent = makeEvent('meeting:proposal' as any, {
      from: msg.from,
      to: msg.to,
      type: msg.type,
      payload: msg.payload,
    });
    broadcast(event);
  }

  // ── Agent Relay (directive Section 1.5) ────────────────────────────────
  // Synchronous variant of send(): waits for the agent to finish streaming
  // and returns the concatenated text output + list of files touched.
  //
  // This is purely additive — send() still exists for the existing
  // fire-and-forget chat flow. The relay loop needs the agent's full
  // output before it can ask the orchestrator to review it, so we can't
  // use fire-and-forget here.
  //
  // Per directive Section 6: this method does NOT bypass Ghost Mode.
  // Side-effect-capable agents (Terminal, Operative, Fabrication) still
  // hit the same Ghost Mode approval gate as always — executeAndWait()
  // just collects the chunks that the agent yields.
  async executeAndWait(task: AgentTask): Promise<{
    taskId: string;
    text: string;
    filesTouched: string[];
    error: string | null;
  }> {
    const agent = this.agents.get(task.agentId);
    if (!agent) {
      return { taskId: task.id, text: '', filesTouched: [], error: `Unknown agent: ${task.agentId}` };
    }

    // Start the trace
    startTrace({
      taskId: task.id,
      agentId: agent.id,
      domain: agent.domain,
      executionMode: task.executionMode,
      input: task.description,
    });
    addStep(task.id, {
      kind: 'llm-call',
      label: `relay task — agent=${agent.id} mode=${task.executionMode} origin=${task.origin}`,
      meta: { taskType: task.type, priority: task.priority, via: 'executeAndWait' },
    });

    // ── Phase B (Context Manager) — assemble the contextBundle ────────
    // Same fail-open behavior as send(). Both call paths get context
    // assembly; the bundle is attached to the same `task.contextBundle`
    // field, so agents reading it don't need to care which dispatch path
    // they came through.
    const bundle = await this.assembleContextBundle(task);
    if (bundle) {
      task.contextBundle = bundle;
      addStep(task.id, {
        kind: 'llm-call',
        label: `context bundle assembled — used=${bundle.tokenBudget.used}/${bundle.tokenBudget.max} tokens, ${bundle.tokenBudget.truncated.length} source(s) truncated`,
        meta: {
          openFiles: bundle.openFiles.length,
          hasSelection: bundle.selection !== null,
          projectGraphNodes: bundle.projectGraph.length,
          historyTurns: bundle.conversationHistory.length,
          memoryEntries: bundle.relevantMemory.length,
          truncated: bundle.tokenBudget.truncated,
          via: 'executeAndWait',
        },
      });
    } else {
      addStep(task.id, {
        kind: 'llm-call',
        label: `context bundle NOT assembled (fail-open — see assembleContextBundle comment)`,
        meta: { via: 'executeAndWait' },
      });
    }

    const abort = new AbortController();
    this.activeTasks.set(task.id, { task, abort });

    broadcast(makeEvent('agent:start', {
      agentId: agent.id,
      taskId: task.id,
      voiceOrigin: task.origin === 'voice',
      taskType: task.type,
      description: task.description,
    }));
    broadcast(makeEvent('agent:status', {
      agentId: agent.id,
      status: 'RUNNING',
      trustScore: agent.trustScore,
    }));

    // Voice task descriptions are private transcripts. Their scoped voice:*
    // stream already exposes lifecycle state to the owner, so do not place the
    // transcript-bearing relay milestone event on the generic global channel.
    if (task.origin !== 'voice') {
      broadcast(makeEvent('relay:milestone-start' as any, {
        agentId: agent.id,
        taskId: task.id,
        taskType: task.type,
        description: task.description,
      }));
    }

    const chunks: string[] = [];
    const filesTouched = new Set<string>();
    let error: string | null = null;

    try {
      for await (const chunk of agent.execute(task, abort.signal)) {
        broadcast(makeEvent('agent:chunk', {
          agentId: agent.id,
          taskId: task.id,
          voiceOrigin: task.origin === 'voice',
          type: chunk.type,
          content: chunk.content,
          meta: chunk.meta,
        }));

        if (chunk.type === 'text' || chunk.type === 'code' || chunk.type === 'done') {
          if (chunk.content) chunks.push(chunk.content);
        }
        if (chunk.type === 'file' && chunk.meta?.path) {
          filesTouched.add(String(chunk.meta.path));
        }
        if (chunk.type === 'error') {
          error = chunk.content;
          agent.updateTrustScore('failure', 0);
          setOutcome(task.id, 'error', chunk.content);
          break;
        }
      }

      broadcast(makeEvent('agent:complete', {
        agentId: agent.id,
        taskId: task.id,
        voiceOrigin: task.origin === 'voice',
        result: error ? 'error' : 'ok',
        duration: Date.now() - task.createdAt,
      }));
      completeTrace(task.id, error ? `(error: ${error})` : '(relay trace captured)');
      if (!error) agent.updateTrustScore('success', 0.9);
    } catch (err: any) {
      error = err.message;
      broadcast(makeEvent('agent:error', {
        agentId: agent.id,
        taskId: task.id,
        voiceOrigin: task.origin === 'voice',
        error: err.message,
        recoverable: true,
      }));
      agent.updateTrustScore('failure', 0);
      setOutcome(task.id, 'error', err.message);
      completeTrace(task.id, `(error: ${err.message})`);
    } finally {
      this.activeTasks.delete(task.id);
      broadcast(makeEvent('agent:status', {
        agentId: agent.id,
        status: 'IDLE',
        trustScore: agent.trustScore,
      }));
    }

    return {
      taskId: task.id,
      text: chunks.join(''),
      filesTouched: [...filesTouched],
      error,
    };
  }

  // Ghost Mode integration — agents report findings through the manager
  reportFinding(finding: Parameters<typeof ghostMode.reportFinding>[0]) {
    return ghostMode.reportFinding(finding);
  }
}

export const agentManager = new AgentManager();
