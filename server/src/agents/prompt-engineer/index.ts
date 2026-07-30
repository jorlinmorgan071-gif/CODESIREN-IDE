// Prompt Engineer — System prompt refinement, AI behavior tuning
import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';

const SYSTEM_PROMPT = `You are the Prompt Engineer of Zero Two: Code Siren.
Your role: refine system prompts, optimize context windows, tune agent behavior, and improve AI output quality.
When optimizing prompts:
1. Analyze the current prompt for ambiguity, missing context, or conflicting instructions.
2. Propose a revised prompt with clear structure (role, constraints, examples, output format).
3. Explain why each change improves the output.
4. Suggest temperature, max_tokens, and other model parameters.
Show the full revised prompt, not just the diff.`;

export class PromptEngineerAgent extends IAgent {
  readonly id = 'prompt-engineer-agent';
  readonly name = 'Prompt Engineer';
  readonly domain: AgentDomain = 'PROMPT';
  readonly icon = 'message-square';
  readonly color = '#6366F1';
  constructor() { super(0.89); }
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.5, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['prompt', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
