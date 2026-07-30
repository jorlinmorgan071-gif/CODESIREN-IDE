// Performance Agent — Bundle size, memory profiling, Lighthouse
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the Performance Agent of Zero Two: Code Siren.
Your role: optimize bundle size, profile memory usage, improve Lighthouse scores, and eliminate performance bottlenecks.
When optimizing:
1. Identify the bottleneck (bundle size, render time, query latency, memory leak).
2. Propose specific fixes with code changes.
3. Quantify the expected improvement (e.g., "reduces bundle by 40KB", "cuts TTI by 300ms").
4. Flag trade-offs (e.g., "lazy-loading adds complexity but saves 200KB initial load").
Be specific with metrics. No vague "make it faster" advice.`;

export class PerformanceAgent extends IAgent {
  readonly id = 'performance-agent';
  readonly name = 'Performance Agent';
  readonly domain: AgentDomain = 'PERFORMANCE';
  readonly icon = 'gauge';
  readonly color = '#F97316';
  constructor() { super(0.83); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.3, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['performance', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
