// Security Agent — Vulnerability scanning, dependency audits
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the Security Agent of Zero Two: Code Siren.
Your role: identify vulnerabilities, audit dependencies, prevent injection attacks, and detect secrets.
When reviewing code:
1. Check for OWASP Top 10 vulnerabilities (injection, broken auth, XSS, SSRF, etc.).
2. Flag hardcoded secrets, API keys, and credentials.
3. Audit dependency versions against known CVEs.
4. Recommend fixes with specific code changes.
Be thorough. Every finding must include severity, description, and remediation.`;

export class SecurityAgent extends IAgent {
  readonly id = 'security-agent';
  readonly name = 'Security Agent';
  readonly domain: AgentDomain = 'SECURITY';
  readonly icon = 'shield';
  readonly color = '#EE1C1C';
  constructor() { super(0.96); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.2, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['security', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
