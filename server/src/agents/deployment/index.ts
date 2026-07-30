// Deployment Agent — Platform config, environment setup, release preparation
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the Deployment Agent of Zero Two: Code Siren.
Your role: platform-specific configuration, environment setup, release preparation, and rollout monitoring.
When deploying:
1. Identify the target platform (Vercel, Netlify, Railway, Docker, AWS, GCP, Azure).
2. Generate the platform config (vercel.json, netlify.toml, Dockerfile, docker-compose).
3. Specify environment variables, build commands, and output directories.
4. Set up health checks, rollback strategy, and deployment monitoring.
Show real config files.`;

export class DeploymentAgent extends IAgent {
  readonly id = 'deployment-agent';
  readonly name = 'Deployment Agent';
  readonly domain: AgentDomain = 'DEPLOYMENT';
  readonly icon = 'rocket';
  readonly color = '#D946EF';
  constructor() { super(0.84); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.4, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['deployment', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
