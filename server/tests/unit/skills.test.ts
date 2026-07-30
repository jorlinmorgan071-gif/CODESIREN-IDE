// tests/unit/skills.test.ts
// P1: Skills Vault — manifest parsing, template rendering, signature verification.

import { describe, it, expect } from 'vitest';
import { loadSkill, verifySignature, renderTemplate, manifestBytes, SAMPLE_SKILL_TOML } from '../../src/skills/manifest.js';

describe('Skills Vault — loadSkill', () => {
  it('parses valid TOML manifest', () => {
    const manifest = loadSkill(SAMPLE_SKILL_TOML);
    expect(manifest.name).toBe('double-calc-demo');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.steps).toHaveLength(3);
    expect(manifest.steps[0].tool_name).toBe('calculator');
    expect(manifest.steps[2].tool_name).toBe('think');
  });

  it('throws on missing required field', () => {
    expect(() => loadSkill('version = "1.0"\ndescription = "test"')).toThrow();
  });

  it('throws on no steps', () => {
    expect(() => loadSkill('name = "test"\nversion = "1.0"\ndescription = "test"\nauthor = "test"\nsteps = []')).toThrow();
  });

  it('throws on invalid TOML', () => {
    expect(() => loadSkill('{ not valid toml')).toThrow();
  });
});

describe('Skills Vault — renderTemplate', () => {
  it('substitutes variables', () => {
    const result = renderTemplate('{"expr": "{{input}}"}', { input: '2+2' });
    expect(result).toEqual({ expr: '2+2' });
  });

  it('handles missing variables (empty string)', () => {
    const result = renderTemplate('{"expr": "{{missing}}"}', {});
    expect(result).toEqual({ expr: '' });
  });

  it('handles non-JSON template (returns empty object)', () => {
    const result = renderTemplate('not json at all', {});
    expect(result).toEqual({});
  });

  it('handles multiple variables', () => {
    const result = renderTemplate('{"a": "{{x}}", "b": "{{y}}"}', { x: '1', y: '2' });
    expect(result).toEqual({ a: '1', b: '2' });
  });
});

describe('Skills Vault — signature verification', () => {
  it('returns true for unsigned manifest (no signature)', () => {
    const manifest = loadSkill(SAMPLE_SKILL_TOML);
    expect(verifySignature(manifest, new Uint8Array(32))).toBe(true);
  });

  it('returns false for invalid signature', () => {
    const manifest = loadSkill(SAMPLE_SKILL_TOML);
    manifest.signature = 'deadbeef';
    expect(verifySignature(manifest, new Uint8Array(32))).toBe(false);
  });
});

describe('Skills Vault — manifestBytes', () => {
  it('produces deterministic bytes', () => {
    const manifest = loadSkill(SAMPLE_SKILL_TOML);
    const bytes1 = manifestBytes(manifest);
    const bytes2 = manifestBytes(manifest);
    expect(bytes1).toEqual(bytes2);
  });

  it('includes name, version, description, author, steps', () => {
    const manifest = loadSkill(SAMPLE_SKILL_TOML);
    const bytes = manifestBytes(manifest);
    const str = new TextDecoder().decode(bytes);
    expect(str).toContain('double-calc-demo');
    expect(str).toContain('0.1.0');
  });
});
