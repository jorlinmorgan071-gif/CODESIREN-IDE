// server/src/orchestration/strategies/single-shot.ts
// Port of the donor's SimpleAgent — single-turn generation, no tools.
//
// One LLM call, return the response. No loop, no LoopGuard needed.

import type { AgentChunk, AgentTask, RouterMessage } from '../../types.js';
import type { InferenceEngine } from '../model-router.js';
import { modelRouter } from '../model-router.js';
import { addStep, incrementTurn } from '../../observability/traces.js';

export interface SingleShotOpts {
  systemPrompt: string;
  recalledMemory?: string;
  temperature?: number;
  maxTokens?: number;
  agentId: string;
  domain: string;
}

export async function* runSingleShot(
  task: AgentTask,
  engine: InferenceEngine,
  opts: SingleShotOpts,
  signal: AbortSignal,
): AsyncGenerator<AgentChunk> {
  const messages: RouterMessage[] = [
    { role: 'system', content: opts.systemPrompt + (opts.recalledMemory ?? '') },
    { role: 'user', content: task.description },
  ];

  const stepStart = Date.now();
  addStep(task.id, {
    kind: 'llm-call',
    label: `single-shot LLM call (engine=${engine.id})`,
    input: { messages, temperature: opts.temperature ?? 0.7 },
  });

  let fullResponse = '';
  try {
    for await (const chunk of engine.stream({
      agentId: opts.agentId,
      domain: opts.domain as any,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      executionMode: 'single-shot',
    })) {
      if (signal.aborted) {
        addStep(task.id, {
          kind: 'done',
          label: 'aborted by signal',
          durationMs: Date.now() - stepStart,
        });
        yield { type: 'done', content: '(aborted)' };
        return;
      }
      if (chunk.done) break;
      fullResponse += chunk.delta;
      yield { type: 'text', content: chunk.delta };
    }
    incrementTurn(task.id);
    addStep(task.id, {
      kind: 'llm-call',
      label: 'single-shot LLM response complete',
      output: fullResponse.slice(0, 500) + (fullResponse.length > 500 ? '…' : ''),
      durationMs: Date.now() - stepStart,
      meta: { chars: fullResponse.length },
    });
    yield { type: 'done', content: '' };
  } catch (err: any) {
    addStep(task.id, {
      kind: 'error',
      label: 'single-shot LLM call failed',
      output: err.message,
      durationMs: Date.now() - stepStart,
    });
    throw err;
  }
}
