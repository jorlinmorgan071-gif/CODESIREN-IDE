// server/src/agents/extension/index.ts
// ExtensionAgent — the THIRD real IAgent implementation (Step 3).
//
// Per directive Section 1: "Skills Vault (new) — Sibling to existing Knowledge
// Vault, surfaced via existing Extension Agent. Agents gain a `skills: SkillRef[]`
// capability list. No separate skills marketplace UI."
//
// Per PDF Section 05: Extension Agent role = Manager, specialization =
// "Extension health monitoring, conflict resolution, auto-recovery, resource
// tracking." In Step 3 the Extension Agent absorbs the Skills Vault management
// role: install / list / invoke / discover skills. The agent's execute() handles
// task.type === 'custom' with description parsing, or the /api/skills routes
// call its helper methods directly.

import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import {
  loadSkill,
  verifySignature,
  SAMPLE_SKILL_TOML,
  type SkillManifest,
  type SkillRef,
  type SkillResult,
} from '../../skills/manifest.js';
import {
  installSkill,
  uninstallSkill,
  listInstalledSkills,
  getSkill,
  executeSkill,
} from '../../skills/executor.js';
import { discoverSkills, type DiscoveryConfig } from '../../skills/discovery.js';

export type ExtensionAction =
  | { kind: 'install'; toml: string; publicKeyHex?: string }
  | { kind: 'install-sample' }
  | { kind: 'uninstall'; name: string }
  | { kind: 'list' }
  | { kind: 'invoke'; name: string; context: Record<string, unknown> }
  | { kind: 'discover'; config?: Partial<DiscoveryConfig> };

export interface ExtensionActionResult {
  action: ExtensionAction['kind'];
  success: boolean;
  summary: string;
  data?: unknown;
  discoveryTraceId?: string;
}

const SYSTEM_PROMPT = `You are the Extension Agent of Zero Two: Code Siren.

Your role: manage extensions AND the Skills Vault. You install, list, invoke,
and discover skills. Skills are tool sequences that other agents can invoke —
they are not agents themselves.

When asked to install a skill, you parse the TOML manifest, optionally verify
its Ed25519 signature, and register it in the Skills Vault.
When asked to list, you return all installed skills.
When asked to invoke, you execute the skill's steps through the shared toolRegistry.
When asked to discover, you mine runs.jsonl for recurring tool sequences and
auto-install them as skeleton skills. The discovery run itself is logged as a
trace — nothing happens off the books.`;

export class ExtensionAgent extends IAgent {
  readonly id = 'extension-agent';
  readonly name = 'Extension Agent';
  readonly domain: AgentDomain = 'EXTENSION';
  readonly icon = 'puzzle';
  readonly color = '#06B6D4';

  constructor() {
    super(0.78);  // matches demoData.ts row a13
    this.acceptsSkills = true;  // manages the Skills Vault
  }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      // The Extension Agent is invoked via the standard dispatcher path, but
      // its task descriptions are structured commands (JSON-encoded ExtensionAction).
      // This lets the /api/skills routes either call helper methods directly
      // (the common case) or route through AgentManager.send() for end-to-end tracing.
      const action = JSON.parse(task.description) as ExtensionAction;
      const result = await this.handleAction(action);
      yield { type: 'text', content: JSON.stringify(result, null, 2) };
      yield { type: 'done', content: '' };
    } catch (err: any) {
      yield { type: 'error', content: err.message, meta: { code: 'UNEXPECTED', recoverable: true } };
    }
  }

  async handleAction(action: ExtensionAction): Promise<ExtensionActionResult> {
    switch (action.kind) {
      case 'install':
        return this.install(action.toml, action.publicKeyHex);
      case 'install-sample':
        return this.install(SAMPLE_SKILL_TOML);
      case 'uninstall':
        return this.uninstall(action.name);
      case 'list':
        return this.list();
      case 'invoke':
        return this.invoke(action.name, action.context);
      case 'discover':
        return this.discover(action.config);
    }
  }

  // ── Skills Vault management ────────────────────────────────────────────

  async install(toml: string, publicKeyHex?: string): Promise<ExtensionActionResult> {
    let manifest: SkillManifest;
    try {
      manifest = loadSkill(toml);
    } catch (err: any) {
      return { action: 'install', success: false, summary: `Parse failed: ${err.message}` };
    }

    // If a public key is provided, the manifest MUST be signed and verify.
    if (publicKeyHex) {
      const pubKeyBytes = hexToBytes(publicKeyHex);
      if (!verifySignature(manifest, pubKeyBytes)) {
        return { action: 'install', success: false, summary: `Signature verification failed for skill '${manifest.name}'` };
      }
    }
    // No public key → unsigned install allowed (local dev / sample skills).

    installSkill(manifest);
    return {
      action: 'install',
      success: true,
      summary: `Installed skill '${manifest.name}' v${manifest.version} (${manifest.steps.length} steps)`,
      data: { name: manifest.name, version: manifest.version, steps: manifest.steps.length },
    };
  }

  async uninstall(name: string): Promise<ExtensionActionResult> {
    const ok = uninstallSkill(name);
    return {
      action: 'uninstall',
      success: ok,
      summary: ok ? `Uninstalled skill '${name}'` : `Skill '${name}' was not installed`,
    };
  }

  async list(): Promise<ExtensionActionResult> {
    const skills = listInstalledSkills();
    return {
      action: 'list',
      success: true,
      summary: `${skills.length} skill(s) installed`,
      data: skills.map((s) => ({
        name: s.name,
        version: s.version,
        description: s.description,
        steps: s.steps.length,
        author: s.author,
        required_capabilities: s.required_capabilities,
      })),
    };
  }

  async invoke(name: string, context: Record<string, unknown> = {}): Promise<ExtensionActionResult & { skillResult?: SkillResult }> {
    const manifest = getSkill(name);
    if (!manifest) {
      return { action: 'invoke', success: false, summary: `Skill '${name}' not installed` };
    }
    const skillResult = await executeSkill(name, context);
    return {
      action: 'invoke',
      success: skillResult.success,
      summary: `Invoked skill '${name}' — ${skillResult.steps.length} steps, ${skillResult.duration_seconds.toFixed(3)}s, success=${skillResult.success}`,
      data: {
        outputs: skillResult.outputs,
        steps: skillResult.steps.map((s) => ({
          tool_name: s.tool_name,
          args: s.args,
          output_key: s.output_key,
          result: s.result.content,
          success: s.result.success,
        })),
      },
      skillResult,
    };
  }

  async discover(config?: Partial<DiscoveryConfig>): Promise<ExtensionActionResult> {
    const { discovered, traceId } = await discoverSkills(config);
    return {
      action: 'discover',
      success: true,
      summary: `Discovered ${discovered.length} skill(s) from runs.jsonl — see trace ${traceId} for the discovery steps`,
      data: discovered,
      discoveryTraceId: traceId,
    };
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

export { SYSTEM_PROMPT };
