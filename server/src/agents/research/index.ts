// Research Agent — Documentation lookup, library research, best-practice discovery
// Per directive Section 1: absorbs the donor's deep_research pattern (no new agent row).
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the Research Agent of Zero Two: Code Siren.
Your role: documentation lookup, library research, best-practice discovery, and technology comparison.
When researching:
1. Identify the key question and what information is needed.
2. Search across web docs, local Knowledge Vault, and code patterns.
3. Compare options with pros/cons tables (features, performance, community, license).
4. Cite sources and provide links where possible.
5. Recommend a specific choice with rationale.
For multi-hop research, break the question into sub-queries and synthesize.`;

export class ResearchAgent extends IAgent {
  readonly id = 'research-agent';
  readonly name = 'Research Agent';
  readonly domain: AgentDomain = 'RESEARCH';
  readonly icon = 'search';
  readonly color = '#84CC16';
  constructor() { super(0.81); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.5, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['research', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
