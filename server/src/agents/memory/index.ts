// Memory Agent — RAG index, Knowledge Vault, semantic search
// Per Fix 1: additionally exposes recall() as a user-facing capability.
// task.type === 'recall' → semantic search, return results directly.
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { memoryEngine } from '../../memory/engine.js';
import { addStep } from '../../observability/traces.js';

const SYSTEM_PROMPT = `You are the Memory Agent of Zero Two: Code Siren.
Your role: maintain the RAG index, update the Knowledge Vault, perform semantic search, and manage cross-session recall.
When asked to recall or index:
1. Identify what should be stored (code patterns, decisions, user preferences, error solutions).
2. Propose the embedding strategy and metadata tags.
3. Suggest which Knowledge Vault bucket to store the information in.
4. Flag when context is missing and needs to be recalled from previous sessions.
The Memory Engine uses pgvector + ChromaDB for dual-index semantic search.

When asked "what do you remember about X", perform a semantic search and return
the actual recalled content — not a guess. Every agent stores memories through
the same MemoryEngine, so you can recall what ANY agent stored.`;

export class MemoryAgent extends IAgent {
  readonly id = 'memory-agent';
  readonly name = 'Memory Agent';
  readonly domain: AgentDomain = 'MEMORY';
  readonly icon = 'brain';
  readonly color = '#A855F7';
  constructor() { super(0.93); }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      // Per Fix 1: Memory Agent exposes recall() as a user-facing capability.
      // task.type === 'recall' → semantic search, return results directly.
      if (task.type === 'recall' || task.description.toLowerCase().startsWith('recall') || task.description.toLowerCase().startsWith('what do you remember')) {
        yield { type: 'text', content: `[memory-agent] Searching memory for: "${task.description}"\n\n` };

        const results = await this.recall(task.description, 5);

        // Trace the recall step so it's visible in the trace
        addStep(task.id, {
          kind: 'tool-call',
          label: `memoryEngine.search("${task.description.slice(0, 50)}") → ${results.length} result(s)`,
          output: results.map(r => ({ score: r.score.toFixed(3), content: r.content.slice(0, 100), fromAgent: r.metadata?.sourceRef })),
          meta: { viaMemoryEngine: true, resultCount: results.length },
        });

        if (results.length === 0) {
          yield { type: 'text', content: 'No memories found.\n' };
        } else {
          yield { type: 'text', content: `Found ${results.length} memory entries:\n\n` };
          for (const result of results) {
            const fromAgent = result.metadata?.sourceRef ?? 'unknown';
            yield { type: 'text', content: `--- Score: ${result.score.toFixed(3)} | From: ${fromAgent} ---\n` };
            yield { type: 'text', content: `${result.content.slice(0, 300)}${result.content.length > 300 ? '...' : ''}\n\n` };
          }
        }

        // Also delegate to the LLM for synthesis of the recalled content
        if (results.length > 0) {
          yield { type: 'text', content: '\nSynthesizing recalled context...\n' };
          const contextBlock = `\n\nRecalled context:\n${results.map(r => `- [score: ${r.score.toFixed(2)}] ${r.content.slice(0, 200)}`).join('\n')}\n`;
          let full = '';
          for await (const chunk of dispatchStrategy(task, signal, {
            systemPrompt: SYSTEM_PROMPT + contextBlock, temperature: 0.4, maxTokens: 512, agentId: this.id, domain: this.domain,
          })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
        }

        yield { type: 'done', content: '' };
        return;
      }

      // Default: chat persona (same as other agents, but with memory-focused prompt)
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.3, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['memory', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
