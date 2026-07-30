// server/src/orchestration/strategies/codeact.ts
// Port of the donor's NativeOpenHandsAgent — CodeAct pattern.
//
// Two action formats:
//   1. ```python ... ``` fenced code blocks → executed via code_interpreter tool
//   2. Action: <tool> / Action Input: <json> → dispatched via ToolRegistry
// If neither, the response is treated as the final answer.

import type { AgentChunk, AgentTask, RouterMessage } from '../../types.js';
import type { InferenceEngine } from '../model-router.js';
import { LoopGuard } from '../loop-guard.js';
import { toolRegistry } from '../../agents/_shared/tool-registry.js';
import { addStep, incrementTurn, addToolResult, setOutcome } from '../../observability/traces.js';

export interface CodeActOpts {
  systemPrompt: string;
  recalledMemory?: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
  agentId: string;
  domain: string;
}

const DEFAULT_MAX_TURNS = 6;
const OBSERVATION_LIMIT = 4000;

export async function* runCodeAct(
  task: AgentTask,
  engine: InferenceEngine,
  opts: CodeActOpts,
  signal: AbortSignal,
): AsyncGenerator<AgentChunk> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const guard = new LoopGuard();

  const tools = toolRegistry.list();
  const toolList = tools.map((t) => t.name).join(', ');
  const systemPrompt = `${opts.systemPrompt}

You are running in CodeAct mode. You have access to tools: ${toolList || '(none)'}.

## How to call a tool

Action: <tool_name>
Action Input: <json_arguments>

You will receive the result, then continue.

## How to run code

You CAN write Python code in \`\`\`python blocks and it will be executed.
Use this for computation, data processing, or when no specific tool fits.

## Rules

- If no tool or code is needed, respond directly with your answer.
- Do NOT include <think> tags.${opts.recalledMemory ?? ''}`;

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
      label: `codeact turn ${turn} — generate`,
      input: { currentInput: currentInput.slice(0, 200) },
      meta: { turn },
    });

    let turnResponse = '';
    for await (const chunk of engine.stream({
      agentId: opts.agentId,
      domain: opts.domain as any,
      messages: history,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 2048,
      executionMode: 'codeact',
    })) {
      if (chunk.done) break;
      turnResponse += chunk.delta;
      yield { type: 'text', content: chunk.delta };
    }
    incrementTurn(task.id);
    addStep(task.id, {
      kind: 'llm-call',
      label: `codeact turn ${turn} — response received`,
      output: turnResponse.slice(0, 500),
      durationMs: Date.now() - stepStart,
      meta: { turn, chars: turnResponse.length },
    });

    // 1. Try Python code block first
    const code = extractCode(turnResponse);
    if (code !== null) {
      const toolName = 'code_interpreter';
      const argsStr = JSON.stringify({ code });
      addStep(task.id, {
        kind: 'parse',
        label: `codeact turn ${turn} — \`\`\`python block parsed`,
        output: code.slice(0, 200),
        meta: { turn },
      });

      const loopMsg = guard.check(toolName, argsStr);
      if (loopMsg !== null) {
        addStep(task.id, { kind: 'loop-guard', label: `codeact turn ${turn} — ${loopMsg}`, meta: { turn } });
        setOutcome(task.id, 'loop-blocked', loopMsg);
        yield { type: 'text', content: `\n\n[loop-guard] ${loopMsg}` };
        yield { type: 'done', content: '' };
        return;
      }

      const toolStart = Date.now();
      const params = { code };
      const toolResult = await toolRegistry.execute(toolName, params);
      addToolResult(task.id, { name: toolName, args: params, result: toolResult.content.slice(0, 500), success: toolResult.success });
      addStep(task.id, {
        kind: 'code-exec',
        label: `codeact turn ${turn} — code_interpreter ${toolResult.success ? 'ok' : 'failed'}`,
        input: { code: code.slice(0, 200) },
        output: toolResult.content.slice(0, 500),
        durationMs: Date.now() - toolStart,
        meta: { turn, success: toolResult.success },
      });

      const obs = truncateObservation(toolResult.content, OBSERVATION_LIMIT);
      yield { type: 'code', content: `\n[Output]\n${obs.slice(0, 200)}${obs.length > 200 ? '…' : ''}\n` };

      history.push({ role: 'assistant', content: turnResponse });
      currentInput = `Output:\n${obs}`;
      history.push({ role: 'user', content: currentInput });
      continue;
    }

    // 2. Try structured Action: / Action Input:
    const action = parseAction(turnResponse);
    if (action !== null) {
      const [toolName, argsStr] = action;
      addStep(task.id, {
        kind: 'parse',
        label: `codeact turn ${turn} — Action parsed`,
        output: { toolName, argsStr: argsStr.slice(0, 200) },
        meta: { turn },
      });

      const loopMsg = guard.check(toolName, argsStr);
      if (loopMsg !== null) {
        addStep(task.id, { kind: 'loop-guard', label: `codeact turn ${turn} — ${loopMsg}`, meta: { turn } });
        setOutcome(task.id, 'loop-blocked', loopMsg);
        yield { type: 'text', content: `\n\n[loop-guard] ${loopMsg}` };
        yield { type: 'done', content: '' };
        return;
      }

      const toolStart = Date.now();
      const params = safeParseJson(argsStr);
      const toolResult = await toolRegistry.execute(toolName, params);
      addToolResult(task.id, { name: toolName, args: params, result: toolResult.content.slice(0, 500), success: toolResult.success });
      addStep(task.id, {
        kind: 'tool-call',
        label: `codeact turn ${turn} — tool '${toolName}' ${toolResult.success ? 'ok' : 'failed'}`,
        input: { toolName, args: params },
        output: toolResult.content.slice(0, 500),
        durationMs: Date.now() - toolStart,
        meta: { turn, success: toolResult.success },
      });

      const obs = truncateObservation(toolResult.content, OBSERVATION_LIMIT);
      yield { type: 'code', content: `\n[Result from ${toolName}] ${obs.slice(0, 200)}${obs.length > 200 ? '…' : ''}\n` };

      history.push({ role: 'assistant', content: turnResponse });
      currentInput = `Result: ${obs}`;
      history.push({ role: 'user', content: currentInput });
      continue;
    }

    // 3. No code or tool call — final answer
    const cleaned = stripToolCallText(turnResponse);
    addStep(task.id, {
      kind: 'parse',
      label: `codeact turn ${turn} — no code/action, treating as final answer`,
      meta: { turn },
    });
    yield { type: 'done', content: '' };
    return;
  }

  setOutcome(task.id, 'max-turns', `Reached max turns (${maxTurns})`);
  yield { type: 'text', content: `\n\n[max turns reached: ${maxTurns}]` };
  yield { type: 'done', content: '' };
}

// ── Parsers (ported from donor's native_openhands.rs) ────────────────────

export function parseAction(text: string): [string, string] | null {
  const actionRe = /^Action:\s*(.+)$/gim;
  const inputRe = /^Action Input:\s*(.+?)(?:\n\n|\n*$)/gims;
  const actionMatch = actionRe.exec(text);
  if (!actionMatch) return null;
  const action = actionMatch[1].trim();
  const inputMatch = inputRe.exec(text);
  const input = inputMatch ? inputMatch[1].trim() : '{}';
  return [action, input];
}

export function extractCode(text: string): string | null {
  const re = /```python\n([\s\S]*?)```/;
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

export function stripToolCallText(text: string): string {
  const actionRe = /Action:\s*.+?(?:Action Input:\s*.+?)?(?:\n\n|\n*$)/gis;
  const xmlRe = /<tool_call>[\s\S]*?<\/\w+>/g;
  return text.replace(actionRe, '').replace(xmlRe, '').trim();
}

function truncateObservation(content: string, limit: number): string {
  if (content.length > limit) {
    return content.slice(0, limit) + '\n\n[Output truncated]';
  }
  return content;
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
