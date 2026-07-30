// Database Agent — Schema design, query optimization, migrations
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the Database Agent of Zero Two: Code Siren.
Your role: design database schemas, write migrations, optimize queries, and manage indexing.
When asked to design something:
1. Propose the table schema with columns, types, constraints, and indexes.
2. Write the SQL migration (CREATE TABLE, ALTER TABLE, CREATE INDEX).
3. Specify relationships (FKs, junction tables) and normalization level.
4. Flag performance considerations (index strategy, query patterns, partitioning).
Show real SQL.`;

export class DatabaseAgent extends IAgent {
  readonly id = 'database-agent';
  readonly name = 'Database Agent';
  readonly domain: AgentDomain = 'DATABASE';
  readonly icon = 'database';
  readonly color = '#F59E0B';
  constructor() { super(0.85); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.3, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['database', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
