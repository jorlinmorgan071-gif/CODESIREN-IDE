// server/src/orchestration/strategies/dispatcher.ts
// Single entry point for executing an AgentTask in any of the three modes.
//
// Per directive Section 1: ReAct and CodeAct are VALUES of executionMode,
// not agents. Any agent can run in any mode — the dispatcher picks the right
// strategy based on task.executionMode, hands it the engine + agent opts,
// and yields AgentChunks back to AgentManager.send().

import type { AgentChunk, AgentTask } from '../../types.js';
import { modelRouter } from '../model-router.js';
import { runSingleShot } from './single-shot.js';
import { runReact } from './react.js';
import { runCodeAct } from './codeact.js';

export interface StrategyOpts {
  systemPrompt: string;
  recalledMemory?: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
  agentId: string;
  domain: string;
}

export async function* dispatchStrategy(
  task: AgentTask,
  signal: AbortSignal,
  opts: StrategyOpts,
): AsyncGenerator<AgentChunk> {
  const engine = modelRouter.pickEngine({
    agentId: opts.agentId,
    domain: opts.domain as any,
    messages: [],
    executionMode: task.executionMode,
  });

  console.log(`[dispatcher] task=${task.id} mode=${task.executionMode} engine=${engine.id} agent=${opts.agentId}`);

  const mode = task.executionMode;
  if (mode === 'single-shot') {
    yield* runSingleShot(task, engine, opts, signal);
  } else if (mode === 'react') {
    yield* runReact(task, engine, opts, signal);
  } else if (mode === 'codeact') {
    yield* runCodeAct(task, engine, opts, signal);
  } else {
    throw new Error(`Unknown executionMode: ${mode as string}`);
  }
}
