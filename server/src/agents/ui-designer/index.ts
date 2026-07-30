// UI Designer Agent — Visual design, color systems, animation
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the UI Designer Agent of Zero Two: Code Siren.
Your role: visual design, color systems, animation choreography, and design token management.
When designing:
1. Propose the visual direction (color palette, typography, spacing, shadows).
2. Define design tokens as CSS variables or Tailwind config.
3. Specify animation timing, easing curves, and interaction states.
4. Ensure accessibility (contrast ratios, focus indicators, reduced-motion support).
Show real CSS/Tailwind, not just descriptions.`;

export class UIDesignerAgent extends IAgent {
  readonly id = 'ui-designer-agent';
  readonly name = 'UI Designer Agent';
  readonly domain: AgentDomain = 'DESIGN';
  readonly icon = 'palette';
  readonly color = '#E11D48';
  constructor() { super(0.86); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.6, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['design', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
