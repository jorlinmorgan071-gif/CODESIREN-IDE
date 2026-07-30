// server/src/orchestration/strategies/react.ts
// Port of the donor's NativeReActAgent — Thought-Action-Observation loop.
//
// The LLM is prompted to output structured text:
//   Thought: <reasoning>
//   Action: <tool_name>
//   Action Input: <json args>
// or:
//   Thought: I now know the answer.
//   Final Answer: <answer>
//
// We parse, dispatch tool calls through the ToolRegistry, feed observations
// back, and loop until Final Answer or max_turns.

import type { AgentChunk, AgentTask, RouterMessage } from '../../types.js';
import type { InferenceEngine } from '../model-router.js';
import { LoopGuard } from '../loop-guard.js';
import { toolRegistry } from '../../agents/_shared/tool-registry.js';
import { addStep, incrementTurn, addToolResult, setOutcome } from '../../observability/traces.js';

export interface ReactOpts {
  systemPrompt: string;
  recalledMemory?: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
  agentId: string;
  domain: string;
}

const DEFAULT_MAX_TURNS = 10;

export async function* runReact(
  task: AgentTask,
  engine: InferenceEngine,
  opts: ReactOpts,
  signal: AbortSignal,
): AsyncGenerator<AgentChunk> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const guard = new LoopGuard();

  const tools = toolRegistry.list();
  const toolList = tools.map((t) => t.name).join(', ');
  const systemPrompt = `${opts.systemPrompt}

You are running in ReAct mode. Available tools: ${toolList || '(none)'}.

For each step, output:
Thought: <your reasoning>
Action: <tool_name>
Action Input: <JSON arguments>

After receiving an observation, continue reasoning.
When you have the final answer, output:
Thought: I now know the answer.
Final Answer: <your answer>${opts.recalledMemory ?? ''}`;

  const history: RouterMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task.description },
  ];

  let currentInput = task.description;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal.aborted) {
      setOutcome(task.id, 'aborted');
      yield { type: 'done', content: '(aborted)' };
      return;
    }

    const stepStart = Date.now();
    addStep(task.id, {
      kind: 'llm-call',
      label: `react turn ${turn} — generate`,
      input: { currentInput: currentInput.slice(0, 200) },
      meta: { turn },
    });

    // Generate this turn's response
    let turnResponse = '';
    for await (const chunk of engine.stream({
      agentId: opts.agentId,
      domain: opts.domain as any,
      messages: history,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 1024,
      executionMode: 'react',
    })) {
      if (chunk.done) break;
      turnResponse += chunk.delta;
      // Stream the model's text to the client as it arrives
      yield { type: 'text', content: chunk.delta };
    }
    incrementTurn(task.id);
    addStep(task.id, {
      kind: 'llm-call',
      label: `react turn ${turn} — response received`,
      output: turnResponse.slice(0, 500),
      durationMs: Date.now() - stepStart,
      meta: { turn, chars: turnResponse.length },
    });

    // 1. Check for Final Answer
    const finalAnswer = parseFinalAnswer(turnResponse);
    if (finalAnswer !== null) {
      addStep(task.id, {
        kind: 'parse',
        label: `react turn ${turn} — Final Answer parsed`,
        output: finalAnswer.slice(0, 200),
        meta: { turn },
      });
      yield { type: 'done', content: '' };
      return;
    }

    // 2. Check for Action
    const action = parseAction(turnResponse);
    if (action === null) {
      // No action and no final answer — treat as final answer
      addStep(task.id, {
        kind: 'parse',
        label: `react turn ${turn} — no action/final-answer, treating response as final`,
        meta: { turn },
      });
      yield { type: 'done', content: '' };
      return;
    }

    const [toolName, argsStr] = action;
    addStep(task.id, {
      kind: 'parse',
      label: `react turn ${turn} — Action parsed`,
      output: { toolName, argsStr: argsStr.slice(0, 200) },
      meta: { turn },
    });

    // 3. LoopGuard check
    const loopMsg = guard.check(toolName, argsStr);
    if (loopMsg !== null) {
      addStep(task.id, {
        kind: 'loop-guard',
        label: `react turn ${turn} — ${loopMsg}`,
        meta: { turn },
      });
      setOutcome(task.id, 'loop-blocked', loopMsg);
      yield { type: 'text', content: `\n\n[loop-guard] ${loopMsg}` };
      yield { type: 'done', content: '' };
      return;
    }

    // 4. Dispatch tool call
    const toolStart = Date.now();
    const params = safeParseJson(argsStr);
    const toolResult = await toolRegistry.execute(toolName, params);
    addToolResult(task.id, {
      name: toolName,
      args: params,
      result: toolResult.content.slice(0, 500),
      success: toolResult.success,
    });
    addStep(task.id, {
      kind: 'tool-call',
      label: `react turn ${turn} — tool '${toolName}' ${toolResult.success ? 'ok' : 'failed'}`,
      input: { toolName, args: params },
      output: toolResult.content.slice(0, 500),
      durationMs: Date.now() - toolStart,
      meta: { turn, success: toolResult.success },
    });

    // Stream the observation to the client as a code chunk
    yield { type: 'code', content: `\n[Observation from ${toolName}] ${toolResult.content.slice(0, 200)}\n` };

    // 5. Feed observation back for the next turn
    history.push({ role: 'assistant', content: turnResponse });
    currentInput = `Observation: ${toolResult.content}`;
    history.push({ role: 'user', content: currentInput });
  }

  // Max turns exceeded
  setOutcome(task.id, 'max-turns', `Reached max turns (${maxTurns})`);
  yield { type: 'text', content: `\n\n[max turns reached: ${maxTurns}]` };
  yield { type: 'done', content: '' };
}

// ── Parsers (ported from donor's native_react.rs) ────────────────────────

export function parseAction(text: string): [string, string] | null {
  const actionRe = /^Action:\s*(.+)$/m;
  const inputRe = /^Action Input:\s*(.+)$/m;
  const actionMatch = actionRe.exec(text);
  if (!actionMatch) return null;
  const action = actionMatch[1].trim();
  const inputMatch = inputRe.exec(text);
  const input = inputMatch ? inputMatch[1].trim() : '{}';
  return [action, input];
}

export function parseFinalAnswer(text: string): string | null {
  const re = /^Final Answer:\s*(.+)/m;
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
