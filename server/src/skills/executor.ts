// server/src/skills/executor.ts
// Skill executor — calls tools per step via the existing toolRegistry.
//
// Per directive Section 1: "Skills Vault (new) — Sibling to existing Knowledge
// Vault, surfaced via existing Extension Agent. Agents gain a `skills: SkillRef[]`
// capability list. No separate skills marketplace UI."
//
// The executor is invoked by the Extension Agent (or any agent that has the
// skill in its SkillRef[] list). Each step's tool is dispatched through the
// same toolRegistry the react/codeact strategies use — no parallel tool system.

import { v4 as uuid } from 'uuid';
import type { SkillManifest, SkillResult, SkillStep } from './manifest.js';
import { renderTemplate } from './manifest.js';
import { toolRegistry, type ToolResult } from '../agents/_shared/tool-registry.js';

// In-memory skill store (Step 3). Real persistence is the skills_vault table
// (migration 003), but the executor can work against either — install() writes
// through to both, list() reads from in-memory for speed.
const installedSkills = new Map<string, SkillManifest>();

export function installSkill(manifest: SkillManifest): void {
  installedSkills.set(manifest.name, manifest);
}

export function uninstallSkill(name: string): boolean {
  return installedSkills.delete(name);
}

export function getSkill(name: string): SkillManifest | undefined {
  return installedSkills.get(name);
}

export function listInstalledSkills(): SkillManifest[] {
  return [...installedSkills.values()];
}

/**
 * Execute a skill by name with the given input context.
 *
 * Each step:
 *   1. Render the arguments_template with the current context
 *   2. Look up the tool in toolRegistry
 *   3. Execute it
 *   4. Stash the result under the step's output_key in the context
 *   5. Record the step in the SkillResult
 *
 * Steps execute sequentially. A failed tool call does NOT abort the skill —
 * the error is recorded in the step's result and the next step runs anyway.
 * This matches the donor's behavior (skill steps are independent by default).
 *
 * Returns a SkillResult with the full step trace, suitable for recording into
 * an AgentRunTrace.
 */
export async function executeSkill(
  skillName: string,
  inputContext: Record<string, unknown> = {},
): Promise<SkillResult> {
  const manifest = installedSkills.get(skillName);
  if (!manifest) {
    return {
      name: skillName,
      success: false,
      outputs: [],
      duration_seconds: 0,
      steps: [],
    };
  }

  const start = Date.now();
  const context: Record<string, unknown> = { ...inputContext };
  const stepResults: SkillResult['steps'] = [];
  const outputs: string[] = [];

  for (const step of manifest.steps) {
    const args = renderTemplate(step.arguments_template, context);
    const result = await toolRegistry.execute(step.tool_name, args);
    context[step.output_key] = result.content;
    stepResults.push({
      tool_name: step.tool_name,
      args,
      result,
      output_key: step.output_key,
    });
    outputs.push(result.content);
  }

  return {
    name: skillName,
    success: stepResults.every((s) => s.result.success),
    outputs,
    duration_seconds: (Date.now() - start) / 1000,
    steps: stepResults,
  };
}
