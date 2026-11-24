// server/src/orchestration/tool-policy.ts
// Step 2c — chat-mode tool enforcement.
//
// The chat mode (ask | debug | build | investigate) is selected in the UI and
// flows to the server. It controls BOTH the execution strategy and which tools
// may run inside the agent loop:
//
//   ask         -> single-shot strategy, ZERO tool calls in the loop. A tool
//                  runs only if the user explicitly invoked it OUTSIDE the loop
//                  (a /skill via POST /api/skills/:name/invoke, or the web
//                  toggle in tier1-chat.ts) — those bypass this gate because
//                  they do not go through the react/codeact tool loop.
//   debug       -> react strategy, READ-ONLY tools only.
//   build       -> react strategy, ALL tools.
//   investigate -> react strategy, web_search + fetch_page only.
//
// The gate is applied in the react/codeact loops right before
// toolRegistry.execute(name, args), so a tool call the LLM emits is blocked
// before it can execute — enforced, not advisory.

import type { ChatMode, ExecutionMode } from '../types.js';

// Read-only tools: no workspace writes, no command execution.
const READ_ONLY_TOOLS = new Set<string>([
  'calculator',
  'think',
  'http_request',
  'ai-prompt',
  'web_search',
  'fetch_page',
]);

// Write / exec tools: mutate the workspace, create artifacts, or execute code.
const WRITE_TOOLS = new Set<string>([
  'code_interpreter',
  'image_gen',
]);

// Web-only tools (the set investigate mode allows).
const WEB_TOOLS = new Set<string>(['web_search', 'fetch_page']);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}
export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}
export function isWebTool(name: string): boolean {
  return WEB_TOOLS.has(name);
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a tool may execute under the given chat mode. Undefined mode
 * (non-chat tasks, e.g. a research agent run) is treated as build (all tools).
 */
export function checkToolPolicy(mode: ChatMode | undefined, toolName: string): ToolPolicyDecision {
  if (!mode || mode === 'build') return { allowed: true };

  if (mode === 'ask') {
    return {
      allowed: false,
      reason:
        `Tool '${toolName}' is not allowed in ask mode. Ask mode runs single-shot with zero tool ` +
        `calls; to run a tool, explicitly invoke it (a /skill or the web toggle).`,
    };
  }
  if (mode === 'debug') {
    if (READ_ONLY_TOOLS.has(toolName)) return { allowed: true };
    return {
      allowed: false,
      reason:
        `Tool '${toolName}' is a write/exec tool and is not allowed in debug mode — debug mode ` +
        `allows read-only tools only.`,
    };
  }
  if (mode === 'investigate') {
    if (WEB_TOOLS.has(toolName)) return { allowed: true };
    return {
      allowed: false,
      reason:
        `Tool '${toolName}' is not allowed in investigate mode — investigate mode allows ` +
        `web_search and fetch_page only.`,
    };
  }
  return { allowed: true };
}

/** Map a chat mode to the execution strategy the dispatcher should run. */
export function executionModeForChatMode(mode: ChatMode): ExecutionMode {
  return mode === 'ask' ? 'single-shot' : 'react';
}
