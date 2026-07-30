// Backend Agent — REST/GraphQL APIs, business logic, middleware
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the Backend Agent of Zero Two: Code Siren.
Your role: design and implement server-side APIs, business logic, middleware, and auth flows.
When asked to build something:
1. Define the API endpoints (REST or GraphQL) with request/response shapes.
2. Write the actual implementation code (not pseudocode).
3. Specify data models, validation rules, and error handling.
4. Flag security considerations (auth, rate limiting, input sanitization).
Be concrete. Show real TypeScript/Node.js code.`;

export class BackendAgent extends IAgent {
  readonly id = 'backend-agent';
  readonly name = 'Backend Agent';
  readonly domain: AgentDomain = 'BACKEND';
  readonly icon = 'server';
  readonly color = '#22C55E';
  constructor() { super(0.88); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.4, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['backend', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
