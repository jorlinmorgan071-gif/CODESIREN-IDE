// server/src/agents/architect/index.ts
// ArchitectAgent — the FIRST real IAgent implementation (Step 0).
//
// Converted from a static demoData.ts row into a live agent routed through
// AgentManager.send(). Step 2 refactor: now delegates execution to the
// strategy dispatcher, so Architect can run in any executionMode.
// Default executionMode for Architect is 'single-shot' (architecture is
// usually one-and-done reasoning, not a tool loop).

import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the Architect Agent of Zero Two: Code Siren.

Your role: Chief architect of the agent workforce. You design systems, plan file
structures, map dependencies, select technologies, and log Architecture Decision
Records. You are the senior engineer every other agent defers to on questions of
structure and strategy.

When asked to design or plan:
1. Restate the problem briefly to confirm understanding.
2. Propose the high-level architecture (components, data flow, boundaries).
3. List the files/modules you would create, with one-line responsibilities.
4. Flag the top 3 risks or trade-offs.
5. Recommend the next agent to engage (Frontend, Backend, Database, etc.).

Be concise. Be opinionated. No filler.`;

export class ArchitectAgent extends IAgent {
  readonly id = 'architect-agent';
  readonly name = 'Architect Agent';
  readonly domain: AgentDomain = 'ARCHITECT';
  readonly icon = 'building-2';
  readonly color = '#EE1C1C';

  constructor() {
    super(0.94);  // matches demoData.ts row a1
  }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      // Delegate to the strategy dispatcher — picks single-shot/react/codeact
      // based on task.executionMode. Architect defaults to single-shot.
      const recalled = await this.recall(task.description, 5);
      const memoryBlock = recalled.length > 0
        ? `\n\nRecalled context:\n${recalled.map((r) => `- ${r.content}`).join('\n')}\n`
        : '';

      let fullResponse = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT,
        recalledMemory: memoryBlock,
        temperature: 0.5,
        maxTokens: 1024,
        agentId: this.id,
        domain: this.domain,
      })) {
        if (signal.aborted) {
          yield { type: 'done', content: '(aborted)' };
          return;
        }
        if (chunk.type === 'text') fullResponse += chunk.content;
        yield chunk;
      }

      // Persist to memory (no-op until Memory Engine lands in Step 8)
      await this.memorize(fullResponse, {
        sourceType: 'agent',
        sourceRef: this.id,
        tags: ['architect', task.type],
      });
    } catch (err: any) {
      yield { type: 'error', content: err.message, meta: { code: 'UNEXPECTED', recoverable: true } };
    }
  }
}

