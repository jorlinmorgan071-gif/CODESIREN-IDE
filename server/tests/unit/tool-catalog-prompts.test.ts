import { describe, expect, it } from 'vitest';
import {
  formatToolCatalog,
  type Tool,
} from '../../src/agents/_shared/tool-registry.js';
import { buildReactSystemPrompt } from '../../src/orchestration/strategies/react.js';
import { buildCodeActSystemPrompt } from '../../src/orchestration/strategies/codeact.js';

const tools: Tool[] = [
  {
    name: 'calculator',
    description: 'Evaluate arithmetic. Args: { "expression": "2+2" }',
    async execute() {
      return { name: 'calculator', content: '4', success: true };
    },
  },
  {
    name: 'http_request',
    description: 'Call an API. Args: { "url": "https://example.test" }',
    async execute() {
      return { name: 'http_request', content: 'ok', success: true };
    },
  },
];

describe('tool catalog prompt contracts', () => {
  it('renders names, descriptions, and argument guidance', () => {
    expect(formatToolCatalog(tools)).toBe(
      '- calculator: Evaluate arithmetic. Args: { "expression": "2+2" }\n' +
      '- http_request: Call an API. Args: { "url": "https://example.test" }',
    );
  });

  it('uses the complete catalog in ReAct prompts', () => {
    const prompt = buildReactSystemPrompt({ systemPrompt: 'base' }, tools);
    expect(prompt).toContain('Available tools and their contracts:');
    expect(prompt).toContain('- calculator: Evaluate arithmetic. Args:');
    expect(prompt).toContain('"expression": "2+2"');
    expect(prompt).toContain('- http_request: Call an API. Args:');
    expect(prompt).not.toContain('Available tools: calculator, http_request');
  });

  it('uses the complete catalog in CodeAct prompts', () => {
    const prompt = buildCodeActSystemPrompt({ systemPrompt: 'base' }, tools);
    expect(prompt).toContain('Available tools and their contracts:');
    expect(prompt).toContain('- calculator: Evaluate arithmetic. Args:');
    expect(prompt).toContain('"url": "https://example.test"');
    expect(prompt).toContain('- http_request: Call an API. Args:');
    expect(prompt).not.toContain('access to tools: calculator, http_request');
  });

  it('renders an explicit empty catalog instead of inventing tools', () => {
    expect(formatToolCatalog([])).toBe('(none)');
  });
});

