// server/src/agents/frontend/index.ts
// FrontendAgent — the FOURTH real IAgent implementation (Step 3).
//
// Converted from static demoData.ts row a2. The Step 3 proof: install a skill
// via the Extension Agent, then invoke it FROM the Frontend Agent. Skills are
// not agents — they are tool sequences the Frontend Agent can call.
//
// Per directive Section 1: agents gain a `skills: SkillRef[]` capability list.
// The Frontend Agent opts in: acceptsSkills = true.

import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { executeSkill, getSkill } from '../../skills/executor.js';
import type { SkillRef } from '../../skills/manifest.js';

const SYSTEM_PROMPT = `You are the Frontend Agent of Zero Two: Code Siren.

Your role: build UI components. React/Vue/Svelte, CSS animations, responsive
layouts, design tokens. You write the actual frontend code, not just plans.

You can invoke installed skills via the Skills Vault. If the user asks you to
"use the X skill", you invoke it and integrate the result into your response.

When asked to build something:
1. Identify the component structure (which files, which props).
2. Write the actual code — not pseudocode.
3. Note any styling, accessibility, or responsive considerations.
4. Flag what the Backend Agent or Database Agent needs to provide.

Be concrete. Show real TypeScript/TSX, not vague descriptions.`;

// Special task description prefix that tells the Frontend Agent to invoke a skill
// instead of running the normal dispatcher. This is the "callable by the Frontend
// Agent" proof path: the /api/skills/:name/invoke route can either call the
// Extension Agent directly, or route through the Frontend Agent (with this prefix)
// to prove cross-agent skill invocation.
const SKILL_INVOKE_PREFIX = '__skill_invoke__:';

export class FrontendAgent extends IAgent {
  readonly id = 'frontend-agent';
  readonly name = 'Frontend Agent';
  readonly domain: AgentDomain = 'FRONTEND';
  readonly icon = 'layout';
  readonly color = '#3B82F6';

  constructor() {
    super(0.91);  // matches demoData.ts row a2
    this.acceptsSkills = true;
  }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      // Skill-invoke shortcut: if the task description starts with the magic
      // prefix, invoke the named skill and stream its step results as chunks.
      // This is the "callable by the Frontend Agent" proof.
      if (task.description.startsWith(SKILL_INVOKE_PREFIX)) {
        const spec = task.description.slice(SKILL_INVOKE_PREFIX.length);
        const [skillName, contextJson] = spec.split('||', 2);
        const context = contextJson ? JSON.parse(contextJson) : {};
        yield { type: 'text', content: `[frontend-agent] invoking skill '${skillName}' with context ${JSON.stringify(context)}\n\n` };

        const skill = getSkill(skillName);
        if (!skill) {
          yield { type: 'error', content: `Skill '${skillName}' is not installed. Install it via the Extension Agent first.` };
          return;
        }

        // Register this skill on the agent's capability list (idempotent)
        const ref: SkillRef = {
          name: skill.name,
          version: skill.version,
          description: skill.description,
          source: 'local',
          installedAt: Date.now(),
        };
        this.addSkill(ref);

        const result = await executeSkill(skillName, context);
        for (const step of result.steps) {
          yield { type: 'code', content: `[step: ${step.tool_name}(${JSON.stringify(step.args)}) → ${step.output_key}]\n  result: ${step.result.content}\n\n` };
        }
        yield { type: 'text', content: `\n[frontend-agent] skill '${skillName}' completed in ${result.duration_seconds.toFixed(3)}s, success=${result.success}\n` };
        yield { type: 'done', content: '' };
        return;
      }

      // Normal path: delegate to the strategy dispatcher
      const recalled = await this.recall(task.description, 5);
      const memoryBlock = recalled.length > 0
        ? `\n\nRecalled context:\n${recalled.map((r) => `- ${r.content}`).join('\n')}\n`
        : '';

      let fullResponse = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT,
        recalledMemory: memoryBlock,
        temperature: 0.4,
        maxTokens: 1024,
        maxTurns: task.executionMode === 'single-shot' ? undefined : 6,
        agentId: this.id,
        domain: this.domain,
      })) {
        if (signal.aborted) {
          yield { type: 'done', content: '(aborted)' };
          return;
        }
        if (chunk.type === 'text') fullResponse += chunk.content;
        yield chunk;
      }

      await this.memorize(fullResponse, {
        sourceType: 'agent',
        sourceRef: this.id,
        tags: ['frontend', task.type, task.executionMode],
      });
    } catch (err: any) {
      yield { type: 'error', content: err.message, meta: { code: 'UNEXPECTED', recoverable: true } };
    }
  }
}
