// server/src/agents/architect/index.ts
// ArchitectAgent — the FIRST real IAgent implementation (Step 0).
//
// Converted from a static demoData.ts row into a live agent routed through
// AgentManager.send(). Step 2 refactor: now delegates execution to the
// strategy dispatcher, so Architect can run in any executionMode.
// Default executionMode for Architect is 'single-shot' (architecture is
// usually one-and-done reasoning, not a tool loop).
//
// Phase 2: now reads task.contextBundle (assembled by ContextManager) and
// formats it into the system prompt so the model receives truthful workspace
// context (open files, project graph, conversation history, memory).

import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import type { ContextBundle } from '../../context/types.js';

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

/**
 * Format the ContextBundle (assembled by ContextManager) into a text block
 * that can be prepended to the system prompt. This is the bridge between
 * the context assembly pipeline and the model's actual input.
 *
 * Phase 2: this is the critical connection that makes workspace context
 * actually reach the model. Without this, ContextManager assembles a bundle
 * but no one reads it.
 */
function formatContextBundle(bundle: ContextBundle | undefined, task: AgentTask): string {
  // Phase 3: If the context bundle timed out (undefined), we still have
  // task.context.liveEditorContent and task.context.activeFilePath. Use them
  // as a fallback so the model always receives the live editor state, even
  // when ContextManager's 2-second timeout fires.
  if (!bundle) {
    // Phase 3 fallback: construct a minimal context block from task.context
    const fallbackParts: string[] = [];
    if (task.context.liveEditorContent && task.context.activeFilePath) {
      const preview = task.context.liveEditorContent.length > 500
        ? task.context.liveEditorContent.slice(0, 500) + '\n...(truncated)'
        : task.context.liveEditorContent;
      fallbackParts.push(`=== OPEN FILES (live editor content — from task context) ===`);
      fallbackParts.push(`File: ${task.context.activeFilePath}\n${preview}`);
    }
    if (task.context.activeFiles && task.context.activeFiles.length > 0) {
      fallbackParts.push(`=== OPEN TABS ===\n${task.context.activeFiles.join(', ')}`);
    }
    if (fallbackParts.length > 0) {
      return '\n\n--- WORKSPACE CONTEXT (fallback — context assembly timed out) ---\n' +
        fallbackParts.join('\n\n') +
        '\n--- END WORKSPACE CONTEXT ---\n';
    }
    return '\n\n[No workspace context available — operating without project context.]';
  }

  const parts: string[] = [];

  // Open files
  if (bundle.openFiles.length > 0) {
    parts.push('=== OPEN FILES (from workspace editor) ===');
    for (const f of bundle.openFiles) {
      const preview = f.content.length > 500
        ? f.content.slice(0, 500) + '\n...(truncated)'
        : f.content;
      parts.push(`File: ${f.path} (${f.language})\n${preview}`);
    }
  } else {
    parts.push('=== OPEN FILES ===\n(No files are currently open in the editor.)');
  }

  // Active selection
  if (bundle.selection) {
    parts.push(`=== ACTIVE SELECTION ===\nFile: ${bundle.selection.path}\nLines ${bundle.selection.startLine}-${bundle.selection.endLine}:\n${bundle.selection.text}`);
  }

  // Project graph (one-hop imports)
  if (bundle.projectGraph.length > 0) {
    parts.push('=== PROJECT GRAPH (one-hop imports of open files) ===');
    for (const node of bundle.projectGraph) {
      parts.push(`${node.file} imports: ${node.imports.join(', ') || '(none)'}`);
    }
  }

  // Conversation history
  if (bundle.conversationHistory.length > 0) {
    parts.push('=== CONVERSATION HISTORY (last 10 turns) ===');
    for (const turn of bundle.conversationHistory) {
      parts.push(`${turn.role}: ${turn.content.slice(0, 200)}`);
    }
  }

  // Relevant memory
  if (bundle.relevantMemory.length > 0) {
    parts.push('=== RELEVANT MEMORY (semantic search results) ===');
    for (const mem of bundle.relevantMemory) {
      parts.push(`[score=${mem.score.toFixed(3)}, source=${mem.source}] ${mem.content.slice(0, 200)}`);
    }
  }

  // Token budget info
  if (bundle.tokenBudget.truncated.length > 0) {
    parts.push(`=== CONTEXT BUDGET ===\nUsed ${bundle.tokenBudget.used}/${bundle.tokenBudget.max} tokens.\nTruncated: ${bundle.tokenBudget.truncated.join(', ')}`);
  }

  return '\n\n--- WORKSPACE CONTEXT ---\n' + parts.join('\n\n') + '\n--- END WORKSPACE CONTEXT ---\n';
}

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

      // Phase 2: read the context bundle assembled by ContextManager.
      // This is the critical connection — without it, the bundle is assembled
      // but never reaches the model. The bundle is attached by
      // AgentManager.assembleContextBundle() before execute() is called.
      const contextBlock = formatContextBundle(task.contextBundle, task);

      const recalled = await this.recall(task.description, 5);
      const memoryBlock = recalled.length > 0
        ? `\n\nRecalled context:\n${recalled.map((r) => `- ${r.content}`).join('\n')}\n`
        : '';

      let fullResponse = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT + contextBlock,
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

