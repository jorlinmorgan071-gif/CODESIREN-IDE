// server/tests/unit/chat-mode-policy.test.ts
// Step 2c — chat modes that enforce.
//
// Covers:
//   - checkToolPolicy per mode (ask/debug/build/investigate) x tool category.
//   - executionModeForChatMode: ask -> single-shot, others -> react.
//   - runReact gate: a stub engine emits a tool call and it is blocked before
//     toolRegistry.execute when the mode disallows it (ask blocks all;
//     investigate rejects a write/exec tool; debug rejects write, allows
//     read-only; build allows all).
//   - dispatchStrategy: ask mode runs single-shot, so even if the engine text
//     contains an Action, zero tool calls execute.

import { describe, test, expect, vi, afterEach } from 'vitest';
import type { AgentTask, ChatMode, ExecutionMode, EngineId, ProjectContext } from '../../src/types.js';
import type { InferenceEngine } from '../../src/orchestration/model-router.js';
import { modelRouter } from '../../src/orchestration/model-router.js';
import { runReact } from '../../src/orchestration/strategies/react.js';
import { dispatchStrategy } from '../../src/orchestration/strategies/dispatcher.js';
import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';
import { checkToolPolicy, executionModeForChatMode } from '../../src/orchestration/tool-policy.js';

function makeTask(chatMode: ChatMode | undefined, executionMode: ExecutionMode = 'react'): AgentTask {
  return {
    id: `test-task-${Math.random().toString(36).slice(2)}`,
    projectId: 'test-proj',
    sessionId: 'test-session',
    agentId: 'chat-agent',
    type: 'chat',
    description: 'test query',
    context: {} as ProjectContext,
    priority: 'normal',
    executionMode,
    chatMode,
    origin: 'chat',
    createdAt: Date.now(),
  };
}

/** Stub engine: turn 1 emits `Action: <tool>`, turn 2 emits `Final Answer`. */
function makeReactStub(actionTool: string, actionInput = '{}'): InferenceEngine {
  let turn = 0;
  return {
    id: `react-stub-${actionTool}-${Math.random().toString(36).slice(2)}` as EngineId,
    async *stream() {
      turn += 1;
      if (turn === 1) {
        yield {
          delta: `Thought: use ${actionTool}\nAction: ${actionTool}\nAction Input: ${actionInput}\n`,
          done: false,
        };
      } else {
        yield { delta: 'Thought: done.\nFinal Answer: done\n', done: false };
      }
      yield { delta: '', done: true };
    },
  };
}

async function drain(gen: AsyncGenerator): Promise<void> {
  for await (const _chunk of gen) {
    /* consume all chunks */
  }
}

const REACT_OPTS = { systemPrompt: 'sp', agentId: 'chat-agent', domain: 'CHAT' } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkToolPolicy (unit)', () => {
  test.each([
    // ask — no tools in the loop at all
    ['ask', 'calculator', false],
    ['ask', 'web_search', false],
    ['ask', 'code_interpreter', false],
    ['ask', 'image_gen', false],
    // debug — read-only only
    ['debug', 'calculator', true],
    ['debug', 'think', true],
    ['debug', 'http_request', true],
    ['debug', 'web_search', true],
    ['debug', 'fetch_page', true],
    ['debug', 'ai-prompt', true],
    ['debug', 'code_interpreter', false],
    ['debug', 'image_gen', false],
    // build — all tools
    ['build', 'code_interpreter', true],
    ['build', 'image_gen', true],
    ['build', 'web_search', true],
    // investigate — web tools only
    ['investigate', 'web_search', true],
    ['investigate', 'fetch_page', true],
    ['investigate', 'calculator', false],
    ['investigate', 'http_request', false],
    ['investigate', 'code_interpreter', false],
    // undefined (non-chat task) — treated as build
    [undefined, 'code_interpreter', true],
  ])('mode=%s tool=%s -> allowed=%s', (mode, tool, allowed) => {
    expect(checkToolPolicy(mode as ChatMode, tool).allowed).toBe(allowed);
  });

  test('blocked decisions include a human-readable reason', () => {
    const d = checkToolPolicy('investigate', 'code_interpreter');
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/investigate/);
    expect(d.reason).toMatch(/web_search/);
  });
});

describe('executionModeForChatMode (unit)', () => {
  test('ask -> single-shot; debug/build/investigate -> react', () => {
    expect(executionModeForChatMode('ask')).toBe('single-shot');
    expect(executionModeForChatMode('debug')).toBe('react');
    expect(executionModeForChatMode('build')).toBe('react');
    expect(executionModeForChatMode('investigate')).toBe('react');
  });
});

describe('runReact tool gate (integration)', () => {
  test('ask mode: stub engine emits a tool call but it NEVER executes', async () => {
    const task = makeTask('ask');
    const engine = makeReactStub('calculator', '{"expression":"1+1"}');
    const spy = vi
      .spyOn(toolRegistry, 'execute')
      .mockResolvedValue({ name: 'calculator', content: '2', success: true });

    await drain(runReact(task, engine, REACT_OPTS, new AbortController().signal));

    // The gate blocked the call before toolRegistry.execute could run.
    expect(spy).not.toHaveBeenCalled();
  });

  test('investigate mode: rejects a write/exec tool (code_interpreter)', async () => {
    const task = makeTask('investigate');
    const engine = makeReactStub('code_interpreter', '{"code":"print(1)"}');
    const spy = vi
      .spyOn(toolRegistry, 'execute')
      .mockResolvedValue({ name: 'code_interpreter', content: 'ok', success: true });

    await drain(runReact(task, engine, REACT_OPTS, new AbortController().signal));

    expect(spy).not.toHaveBeenCalled();
  });

  test('investigate mode: allows web_search', async () => {
    const task = makeTask('investigate');
    const engine = makeReactStub('web_search', '{"query":"node lts"}');
    const spy = vi
      .spyOn(toolRegistry, 'execute')
      .mockResolvedValue({ name: 'web_search', content: 'results', success: true, meta: { results: [] } });

    await drain(runReact(task, engine, REACT_OPTS, new AbortController().signal));

    expect(spy).toHaveBeenCalledWith('web_search', expect.objectContaining({ query: 'node lts' }));
  });

  test('debug mode: allows read-only calculator', async () => {
    const task = makeTask('debug');
    const engine = makeReactStub('calculator', '{"expression":"1+1"}');
    const spy = vi
      .spyOn(toolRegistry, 'execute')
      .mockResolvedValue({ name: 'calculator', content: '2', success: true });
    await drain(runReact(task, engine, REACT_OPTS, new AbortController().signal));
    expect(spy).toHaveBeenCalled();
  });

  test('debug mode: blocks write/exec code_interpreter', async () => {
    const task = makeTask('debug');
    const engine = makeReactStub('code_interpreter', '{"code":"x"}');
    const spy = vi
      .spyOn(toolRegistry, 'execute')
      .mockResolvedValue({ name: 'code_interpreter', content: 'ok', success: true });
    await drain(runReact(task, engine, REACT_OPTS, new AbortController().signal));
    expect(spy).not.toHaveBeenCalled();
  });

  test('build mode: allows write/exec tools (all tools)', async () => {
    const task = makeTask('build');
    const engine = makeReactStub('code_interpreter', '{"code":"print(1)"}');
    const spy = vi
      .spyOn(toolRegistry, 'execute')
      .mockResolvedValue({ name: 'code_interpreter', content: 'ok', success: true });

    await drain(runReact(task, engine, REACT_OPTS, new AbortController().signal));

    expect(spy).toHaveBeenCalled();
  });
});

describe('dispatchStrategy — ask runs single-shot (zero tool calls)', () => {
  test('even if the engine emits Action text, no tool executes in ask mode', async () => {
    const task = makeTask('ask', 'single-shot');
    const stubEngine: InferenceEngine = {
      id: 'ss-stub' as EngineId,
      async *stream() {
        yield { delta: 'Action: calculator\nAction Input: {"expression":"1+1"}\n', done: false };
        yield { delta: '', done: true };
      },
    };
    const pickSpy = vi.spyOn(modelRouter, 'pickEngine').mockReturnValue(stubEngine);
    const execSpy = vi
      .spyOn(toolRegistry, 'execute')
      .mockResolvedValue({ name: 'calculator', content: '2', success: true });

    await drain(dispatchStrategy(task, new AbortController().signal, REACT_OPTS));

    // single-shot does not parse tool calls, so the engine's "Action" text is
    // just output — toolRegistry.execute is never called.
    expect(execSpy).not.toHaveBeenCalled();
    pickSpy.mockRestore();
  });
});
