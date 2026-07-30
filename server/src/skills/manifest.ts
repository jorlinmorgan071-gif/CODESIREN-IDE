// server/src/skills/manifest.ts
// Port of the donor's SkillManifest + SkillStep + SkillResult types, TOML parser,
// and Ed25519 signature verifier. Follows the agentskills.io spec the donor used.
//
// Skills are NOT agents. They are tool sequences invoked BY agents. Per directive
// Section 1: "Agents gain a `skills: SkillRef[]` capability list. No separate
// skills marketplace UI." Skills Vault is surfaced via the Extension Agent.

import { parse as tomlParse } from '@iarna/toml';
import nacl from 'tweetnacl';
import type { ToolResult } from '../agents/_shared/tool-registry.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface SkillStep {
  tool_name: string;
  arguments_template: string;    // JSON-with-mustache templates, e.g. '{"path": "{{input_dir}}"}'
  output_key: string;            // key under which the result is stashed for later steps
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  steps: SkillStep[];
  required_capabilities: string[];
  signature?: string;            // hex-encoded Ed25519 signature
  metadata?: Record<string, unknown>;
}

export interface SkillResult {
  name: string;
  success: boolean;
  outputs: string[];
  duration_seconds: number;
  steps: Array<{ tool_name: string; args: Record<string, unknown>; result: ToolResult; output_key: string }>;
}

// Compact reference stored on agents and in the skills_vault table
export interface SkillRef {
  name: string;
  version: string;
  description: string;
  source: string;                // registry origin (e.g. 'local', 'hermes', 'openclaw')
  installedAt: number;           // epoch ms
}

// ── Parser ───────────────────────────────────────────────────────────────

/**
 * Parse a TOML string into a SkillManifest.
 * Throws on malformed TOML or missing required fields.
 */
export function loadSkill(tomlStr: string): SkillManifest {
  let parsed: any;
  try {
    parsed = tomlParse(tomlStr);
  } catch (err: any) {
    throw new Error(`Failed to parse skill TOML: ${err.message}`);
  }

  // Validate required top-level fields
  const required = ['name', 'version', 'description', 'author'];
  for (const key of required) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) {
      throw new Error(`Skill manifest missing required field: ${key}`);
    }
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`Skill '${parsed.name}' must have at least one step`);
  }

  const steps: SkillStep[] = parsed.steps.map((s: any, i: number) => {
    if (typeof s.tool_name !== 'string' || !s.tool_name) {
      throw new Error(`Skill '${parsed.name}' step ${i} missing 'tool_name'`);
    }
    return {
      tool_name: s.tool_name,
      arguments_template: typeof s.arguments_template === 'string' ? s.arguments_template : '{}',
      output_key: typeof s.output_key === 'string' ? s.output_key : `step_${i}_output`,
    };
  });

  return {
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    author: parsed.author,
    steps,
    required_capabilities: Array.isArray(parsed.required_capabilities) ? parsed.required_capabilities : [],
    signature: typeof parsed.signature === 'string' && parsed.signature ? parsed.signature : undefined,
    metadata: parsed.metadata ?? {},
  };
}

// ── Signature verification (Ed25519) ─────────────────────────────────────

/**
 * Canonical bytes for signature verification — everything except `signature`.
 * Matches the donor's manifest_bytes() shape: name|version|description|author|
 * <step.tool_name:step.arguments_template:step.output_key>|...|<cap>|...|metadata_json
 */
export function manifestBytes(m: SkillManifest): Uint8Array {
  const parts: string[] = [];
  parts.push(m.name);
  parts.push(m.version);
  parts.push(m.description);
  parts.push(m.author);
  for (const step of m.steps) {
    parts.push(`${step.tool_name}:${step.arguments_template}:${step.output_key}`);
  }
  for (const cap of m.required_capabilities) {
    parts.push(cap);
  }
  if (m.metadata && Object.keys(m.metadata).length > 0) {
    parts.push(JSON.stringify(m.metadata));
  }
  return new TextEncoder().encode(parts.join('|'));
}

/**
 * Verify the Ed25519 signature on a manifest against the given public key bytes (32 bytes).
 * Returns true if signature is valid OR if the manifest has no signature (unsigned skills allowed
 * for local development; signed skills required for registry install — enforced at install time).
 */
export function verifySignature(manifest: SkillManifest, publicKeyBytes: Uint8Array): boolean {
  if (!manifest.signature) return true;  // unsigned — caller decides whether to allow
  try {
    const sigBytes = hexToBytes(manifest.signature);
    if (sigBytes.length !== nacl.sign.signatureLength) return false;
    return nacl.sign.detached.verify(manifestBytes(manifest), sigBytes, publicKeyBytes);
  } catch {
    return false;
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

// ── Template substitution ────────────────────────────────────────────────

/**
 * Render a mustache-style arguments_template with the given context.
 * Example: '{"path": "{{input_dir}}"}' + { input_dir: '/tmp' } → '{"path": "/tmp"}'
 *
 * Context keys are looked up case-sensitively. Unknown keys are replaced with empty string.
 * The result is parsed as JSON; on parse failure, an empty object is returned.
 */
export function renderTemplate(template: string, context: Record<string, unknown>): Record<string, unknown> {
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = context[key];
    if (val === undefined || val === null) return '';
    return String(val);
  });
  try {
    return JSON.parse(rendered);
  } catch {
    return {};
  }
}

// ── Sample skill (for Step 3 e2e proof) ───────────────────────────────────

export const SAMPLE_SKILL_TOML = `# A trivial sample skill that calls the calculator twice with different expressions
# and then calls 'think' to record a thought about the result.
# Used in the Step 3 e2e proof: install this skill, invoke it from the Frontend
# Agent, observe the steps executing through toolRegistry, and verify the run is traced.

name = "double-calc-demo"
version = "0.1.0"
description = "Demo skill for Step 3: calls calculator twice then think. Proves skills flow through toolRegistry."
author = "code-siren-step-3"
required_capabilities = ["calculator", "think"]

[[steps]]
tool_name = "calculator"
arguments_template = '{"expression": "{{first_expr}}"}'
output_key = "first_result"

[[steps]]
tool_name = "calculator"
arguments_template = '{"expression": "{{second_expr}}"}'
output_key = "second_result"

[[steps]]
tool_name = "think"
arguments_template = '{"thought": "First result was {{first_result}}, second was {{second_result}}"}'
output_key = "thought"
`;
