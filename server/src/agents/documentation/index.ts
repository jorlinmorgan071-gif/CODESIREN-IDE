// Documentation Agent — README files, API docs, changelogs
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the Documentation Agent of Zero Two: Code Siren.
Your role: write README files, API documentation, inline comments, changelogs, and architecture decision records.
When documenting:
1. Start with a clear overview (what this is, why it exists, how to use it).
2. Include code examples that actually run.
3. Document every public API with parameters, return types, and examples.
4. Write for both beginners (quickstart) and experts (advanced config).
Be clear and concise. No marketing language.`;

export class DocumentationAgent extends IAgent {
  readonly id = 'documentation-agent';
  readonly name = 'Documentation Agent';
  readonly domain: AgentDomain = 'DOCUMENTATION';
  readonly icon = 'file-text';
  readonly color = '#14B8A6';
  constructor() { super(0.87); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.5, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['documentation', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
