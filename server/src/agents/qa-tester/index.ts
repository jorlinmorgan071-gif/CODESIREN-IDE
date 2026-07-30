// server/src/agents/qa-tester/index.ts
// QaTesterAgent — the SECOND real IAgent implementation (Step 2).
//
// Converted from static demoData.ts row a7. Designed to demonstrate that any
// agent can run in any executionMode: same agent, same system prompt, same
// Model Router — the strategy dispatcher picks single-shot / react / codeact
// based purely on task.executionMode.

import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the QA Tester Agent of Zero Two: Code Siren.

Your role: write and run tests. Unit tests, integration tests, E2E tests. You
analyze coverage, identify regression risks, and interpret test failures.

When asked to test something:
1. Identify what needs testing (function, endpoint, behavior).
2. Pick the test level (unit / integration / E2E).
3. List the test cases you would write, with input → expected output.
4. Recommend the test framework appropriate to the project's stack.
5. Flag any test coverage gaps in critical paths (auth, payments, etc.).

You have access to tools in react/codeact mode:
- calculator: for any arithmetic in test cases
- think: for reasoning scratchpad
- code_interpreter: to (eventually) execute test snippets

Be specific. Always show concrete test cases, not vague advice.`;

export class QaTesterAgent extends IAgent {
  readonly id = 'qa-tester-agent';
  readonly name = 'QA Tester Agent';
  readonly domain: AgentDomain = 'QA';
  readonly icon = 'test-tube';
  readonly color = '#EC4899';

  constructor() {
    super(0.79);  // matches demoData.ts row a7
  }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      // Same dispatcher as Architect. The strategy is picked by task.executionMode,
      // not by the agent. This is the directive's "ReAct and CodeAct are values
      // of executionMode, not agents" rule made concrete.
      const recalled = await this.recall(task.description, 5);
      const memoryBlock = recalled.length > 0
        ? `\n\nRecalled context:\n${recalled.map((r) => `- ${r.content}`).join('\n')}\n`
        : '';

      let fullResponse = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT,
        recalledMemory: memoryBlock,
        temperature: 0.4,
        maxTokens: 1024,
        maxTurns: task.executionMode === 'single-shot' ? undefined : 6,
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

      await this.memorize(fullResponse, {
        sourceType: 'agent',
        sourceRef: this.id,
        tags: ['qa', task.type, task.executionMode],
      });
    } catch (err: any) {
      yield { type: 'error', content: err.message, meta: { code: 'UNEXPECTED', recoverable: true } };
    }
  }
}
