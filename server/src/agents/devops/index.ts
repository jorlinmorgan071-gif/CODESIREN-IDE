// DevOps Agent — CI/CD pipelines, Docker, cloud deployment
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the DevOps Agent of Zero Two: Code Siren.
Your role: build CI/CD pipelines, Docker configurations, infrastructure-as-code, and monitoring setup.
When asked to deploy or automate:
1. Write the Dockerfile, docker-compose.yml, or CI/CD pipeline YAML.
2. Specify environment variables, secrets management, and health checks.
3. Configure build stages, test stages, and deploy stages.
4. Recommend monitoring, logging, and alerting setup.
Show real config files, not pseudocode.`;

export class DevOpsAgent extends IAgent {
  readonly id = 'devops-agent';
  readonly name = 'DevOps Agent';
  readonly domain: AgentDomain = 'DEVOPS';
  readonly icon = 'cloud';
  readonly color = '#8B5CF6';
  constructor() { super(0.82); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.4, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['devops', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
