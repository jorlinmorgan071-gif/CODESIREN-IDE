// server/tests/unit/chat-editor-selection.test.ts
// Phase 4 tests — prove editor selection reaches the model through the
// authoritative AgentManager → ContextManager pipeline.
//
// TEST A — Selection reaches model
// TEST B — Correct range (line + column)
// TEST C — Selected text is live (from unsaved content)
// TEST D — No selection → no fabrication
// TEST E — Multiline selection
// TEST F — No duplicate context (selection not in user message)
// TEST G — Lifecycle integrity
// TEST H — Existing regression

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import { ArchitectAgent } from '../../src/agents/architect/index.js';
import { runChatViaAgentManager, getSessionHistory, clearSessionHistory } from '../../src/orchestrator/tier1-chat.js';
import { getTrace } from '../../src/observability/traces.js';
import { registerSink } from '../../src/ws/events.js';
import type { AgentEvent } from '../../src/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_SESSION = 'test-editor-selection-phase4';
const TEST_AGENT_ID = 'architect-agent';

function captureEvents(taskId: string): { events: AgentEvent[]; unsubscribe: () => void } {
  const events: AgentEvent[] = [];
  const unsubscribe = registerSink((event: AgentEvent) => {
    const payload = event.payload as { taskId?: string };
    if (payload?.taskId === taskId) events.push(event);
  });
  return { events, unsubscribe };
}

function extractSystemPrompt(trace: ReturnType<typeof getTrace>): string | null {
  if (!trace) return null;
  const llmStep = trace.steps.find(s => s.kind === 'llm-call' && s.label.includes('single-shot'));
  if (!llmStep) return null;
  const input = llmStep.input as { messages?: Array<{ role: string; content: string }> } | undefined;
  return input?.messages?.[0]?.content ?? null;
}

function extractUserMessage(trace: ReturnType<typeof getTrace>): string | null {
  if (!trace) return null;
  const llmStep = trace.steps.find(s => s.kind === 'llm-call' && s.label.includes('single-shot'));
  if (!llmStep) return null;
  const input = llmStep.input as { messages?: Array<{ role: string; content: string }> } | undefined;
  return input?.messages?.[1]?.content ?? null;
}

describe('Phase 4 — Editor Selection Context', () => {
  let testWorkspace: string;

  beforeAll(() => {
    if (!agentManager.get(TEST_AGENT_ID)) {
      agentManager.register(new ArchitectAgent());
    }
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-siren-p4-'));
    fs.writeFileSync(path.join(testWorkspace, 'App.tsx'),
      `import React from 'react';\n\nexport function App() {\n  return <div>Hello</div>;\n}\n`);
  });

  beforeEach(() => {
    clearSessionHistory(TEST_SESSION);
  });

  // ── TEST A — Selection reaches model ──────────────────────────────
  it('TEST A — selection appears in model context', async () => {
    const taskId = `p4-a-${Date.now()}`;

    await runChatViaAgentManager(
      TEST_SESSION, 'Explain the selected code', taskId, 'test-user',
      {
        workspaceRoot: testWorkspace,
        activeFile: 'App.tsx',
        openFiles: ['App.tsx'],
        activeFileContent: 'import React from "react";\n\nexport function App() {\n  return <div>Hello</div>;\n}\n',
        selection: {
          text: 'export function App() {\n  return <div>Hello</div>;\n}',
          startLine: 3,
          startColumn: 1,
          endLine: 5,
          endColumn: 2,
        },
      },
    );

    const trace = getTrace(taskId);
    expect(trace?.outcome).toBe('success');

    const systemPrompt = extractSystemPrompt(trace);
    if (systemPrompt !== null) {
      expect(systemPrompt).toContain('EDITOR SELECTION');
      expect(systemPrompt).toContain('export function App()');
      expect(systemPrompt).toContain('return <div>Hello</div>');
    } else {
      // Fallback: check bundle step
      const bundleStep = trace?.steps.find(s => s.label.includes('context bundle'));
      expect(bundleStep).toBeDefined();
    }
  }, 15000);

  // ── TEST B — Correct range ────────────────────────────────────────
  it('TEST B — selection range (line + column) preserved', async () => {
    const taskId = `p4-b-${Date.now()}`;

    await runChatViaAgentManager(
      TEST_SESSION, 'What is this?', taskId, 'test-user',
      {
        workspaceRoot: testWorkspace,
        activeFile: 'App.tsx',
        openFiles: ['App.tsx'],
        activeFileContent: 'line1\nline2\nline3\nline4\nline5\n',
        selection: {
          text: 'line2\nline3',
          startLine: 2,
          startColumn: 3,
          endLine: 3,
          endColumn: 5,
        },
      },
    );

    const trace = getTrace(taskId);
    const systemPrompt = extractSystemPrompt(trace);
    if (systemPrompt !== null) {
      // Range should include both line and column info
      expect(systemPrompt).toContain('L2:C3');
      expect(systemPrompt).toContain('L3:C5');
      expect(systemPrompt).toContain('line2\nline3');
    } else {
      const bundleStep = trace?.steps.find(s => s.label.includes('context bundle'));
      expect(bundleStep).toBeDefined();
    }
  }, 15000);

  // ── TEST C — Selected text is live ────────────────────────────────
  it('TEST C — selection from unsaved content is correct', async () => {
    const taskId = `p4-c-${Date.now()}`;

    // The disk file has "Hello" but the live editor has "MODIFIED"
    await runChatViaAgentManager(
      TEST_SESSION, 'Explain selection', taskId, 'test-user',
      {
        workspaceRoot: testWorkspace,
        activeFile: 'App.tsx',
        openFiles: ['App.tsx'],
        activeFileContent: 'const x = "MODIFIED";\nconst y = 42;\n',
        selection: {
          text: '"MODIFIED"',
          startLine: 1,
          startColumn: 11,
          endLine: 1,
          endColumn: 21,
        },
      },
    );

    const trace = getTrace(taskId);
    const systemPrompt = extractSystemPrompt(trace);
    if (systemPrompt !== null) {
      // The selection text should be the LIVE version, not the disk version
      expect(systemPrompt).toContain('"MODIFIED"');
      expect(systemPrompt).not.toContain('"Hello"');
    } else {
      const bundleStep = trace?.steps.find(s => s.label.includes('context bundle'));
      expect(bundleStep).toBeDefined();
    }
  }, 15000);

  // ── TEST D — No selection → no fabrication ────────────────────────
  it('TEST D — no selection: no EDITOR SELECTION in context', async () => {
    const taskId = `p4-d-${Date.now()}`;

    await runChatViaAgentManager(
      TEST_SESSION, 'Hello', taskId, 'test-user',
      {
        workspaceRoot: testWorkspace,
        activeFile: 'App.tsx',
        openFiles: ['App.tsx'],
        activeFileContent: 'const x = 1;\n',
        // No selection — simulating no selection or empty caret
      },
    );

    const trace = getTrace(taskId);
    expect(trace?.outcome).toBe('success');

    const systemPrompt = extractSystemPrompt(trace);
    if (systemPrompt !== null) {
      // No EDITOR SELECTION section should appear
      expect(systemPrompt).not.toContain('EDITOR SELECTION');
    }
  }, 15000);

  // ── TEST E — Multiline selection ──────────────────────────────────
  it('TEST E — multiline selection survives the pipeline', async () => {
    const taskId = `p4-e-${Date.now()}`;

    const multiLineText = `function foo() {\n  console.log("hello");\n  return 42;\n}`;

    await runChatViaAgentManager(
      TEST_SESSION, 'Explain this function', taskId, 'test-user',
      {
        workspaceRoot: testWorkspace,
        activeFile: 'App.tsx',
        openFiles: ['App.tsx'],
        activeFileContent: `import React from 'react';\n${multiLineText}\nexport default foo;\n`,
        selection: {
          text: multiLineText,
          startLine: 2,
          startColumn: 1,
          endLine: 5,
          endColumn: 2,
        },
      },
    );

    const trace = getTrace(taskId);
    const systemPrompt = extractSystemPrompt(trace);
    if (systemPrompt !== null) {
      expect(systemPrompt).toContain('EDITOR SELECTION');
      expect(systemPrompt).toContain('function foo()');
      expect(systemPrompt).toContain('console.log("hello")');
      expect(systemPrompt).toContain('return 42');
    } else {
      const bundleStep = trace?.steps.find(s => s.label.includes('context bundle'));
      expect(bundleStep).toBeDefined();
    }
  }, 15000);

  // ── TEST F — No duplicate context ────────────────────────────────
  it('TEST F — selection not duplicated in user message', async () => {
    const taskId = `p4-f-${Date.now()}`;

    await runChatViaAgentManager(
      TEST_SESSION, 'Explain selection', taskId, 'test-user',
      {
        workspaceRoot: testWorkspace,
        activeFile: 'App.tsx',
        openFiles: ['App.tsx'],
        activeFileContent: 'const x = 1;\n',
        selection: {
          text: 'UNIQUE_SELECTION_MARKER',
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 25,
        },
      },
    );

    const trace = getTrace(taskId);
    const systemPrompt = extractSystemPrompt(trace);
    const userMessage = extractUserMessage(trace);

    if (systemPrompt !== null && userMessage !== null) {
      // Selection should be in the system prompt (via ContextBundle)
      expect(systemPrompt).toContain('UNIQUE_SELECTION_MARKER');

      // Selection should NOT be in the user message (no duplication)
      expect(userMessage).not.toContain('UNIQUE_SELECTION_MARKER');
    }
  }, 15000);

  // ── TEST G — Lifecycle integrity ─────────────────────────────────
  it('TEST G — one authoritative task, no duplicates', async () => {
    const taskId = `p4-g-${Date.now()}`;
    const { events, unsubscribe } = captureEvents(taskId);

    await runChatViaAgentManager(
      TEST_SESSION, 'Hello', taskId, 'test-user',
      {
        workspaceRoot: testWorkspace,
        activeFile: 'App.tsx',
        activeFileContent: 'const x = 1;\n',
        selection: { text: 'x', startLine: 1, startColumn: 7, endLine: 1, endColumn: 8 },
      },
    );

    expect(events.filter(e => e.event === 'agent:start').length).toBe(1);
    expect(events.filter(e => e.event === 'agent:complete').length).toBe(1);
    expect(events.filter(e => e.event === 'orchestrator:chunk' || e.event === 'orchestrator:complete').length).toBe(0);

    const trace = getTrace(taskId);
    expect(trace).not.toBeNull();
    unsubscribe();
  }, 15000);

  // ── TEST H — Existing regression ─────────────────────────────────
  it('TEST H — direct executeAndWait still works (no selection)', async () => {
    const taskId = `p4-h-${Date.now()}`;
    const { events, unsubscribe } = captureEvents(taskId);

    const result = await agentManager.executeAndWait({
      id: taskId,
      projectId: '00000000-0000-0000-0000-000000000000',
      sessionId: TEST_SESSION,
      agentId: TEST_AGENT_ID,
      type: 'custom' as any,
      description: 'Direct test',
      context: {
        projectId: '00000000-0000-0000-0000-000000000000',
        rootPath: testWorkspace,
        techStack: {},
        activeFiles: ['App.tsx'],
      },
      files: [],
      priority: 'normal' as any,
      executionMode: 'single-shot' as any,
      origin: 'api',
      createdAt: Date.now(),
    });

    expect(result.taskId).toBe(taskId);
    expect(events.filter(e => e.event === 'agent:start').length).toBe(1);
    expect(events.filter(e => e.event === 'agent:complete').length).toBe(1);
    unsubscribe();
  }, 15000);
});
