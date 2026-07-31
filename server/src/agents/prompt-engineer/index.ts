// server/src/agents/prompt-engineer/index.ts
// Prompt Engineer Agent — Static analysis of agent SYSTEM_PROMPT strings,
// empirical parse-success testing, and prompt improvement proposals.
//
// Phase C Agent 10 (FINAL): HARDENED from 31-line chat-only stub to real
// IAgent with 3 programmatic capabilities:
//   1. analyzePrompts() — static analysis of all 19 SYSTEM_PROMPTs + 3
//      secondary prompts across all agents
//   2. empiricalTest() — invokes CodeReviewAgent.review() with benign input,
//      observes reviewTier, correctly flags stub-engine results as inconclusive
//   3. proposeImprovedPrompt() — generates improvement proposals based on
//      objective findings. NEVER calls writeProjectFile().
//
// CRITICAL CONSTRAINT (the single most important rule in this directive):
//   This agent MUST NEVER call writeProjectFile() under ANY circumstances.
//   It only RETURNS proposals. Any actual application goes through the normal
//   writeProjectFile() → CodeReviewAgent path, initiated by the CALLER.
//   This is proven by a spy test that asserts writeProjectFile was NOT called
//   after every method invocation.

import type {
  AgentChunk,
  AgentTask,
  AgentDomain,
  PromptFinding,
  PromptAnalysisResult,
  EmpiricalTestResult,
  PromptProposal,
} from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SYSTEM_PROMPT = `You are the Prompt Engineer of Zero Two: Code Siren.
Your role: statically analyze other agents' SYSTEM_PROMPT strings for objective structural issues, empirically test structured-output agents, and propose improved prompts for human review.
NEVER apply changes yourself — only return proposals. The caller decides whether to apply them.`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(__dirname, '..');

// Agents that expect structured LLM output (per Section 0 Finding 3)
const STRUCTURED_OUTPUT_AGENTS = new Set([
  'code-review',
  'database',
  'security',
  'research',
]);

// High-precision conflict patterns only — false positives here undermine
// the whole tool. Each pattern was chosen because it appears in real
// conflicting-instruction scenarios with near-zero false-positive rate.
const CONFLICT_PATTERNS: { pattern: RegExp; description: string }[] = [
  // "always" + "never" on the same topic
  { pattern: /always\s+use\s+\w+[\s\S]{0,200}never\s+use\s+\w+/i, description: '"always use X" and "never use X" may conflict' },
  // "must" + "optional" on the same noun
  { pattern: /must\s+(include|have|use)\s+\w+[\s\S]{0,200}optional[\s\S]{0,50}\w+/i, description: '"must include X" and "X is optional" may conflict' },
];

export class PromptEngineerAgent extends IAgent {
  readonly id = 'prompt-engineer-agent';
  readonly name = 'Prompt Engineer';
  readonly domain: AgentDomain = 'PROMPT';
  readonly icon = 'message-square';
  readonly color = '#6366F1';
  constructor() { super(0.89); }

  // ── 1. Static analysis of all agent prompts ───────────────────────
  /**
   * Analyze all 19 SYSTEM_PROMPTs + 3 secondary prompts for structural issues.
   *
   * Checks per prompt:
   *   - tokenEstimate (chars/4, flag >2000 or <50)
   *   - hasRoleDefinition (contains "You are" or "Your role")
   *   - hasOutputFormat (for structured-output agents: contains "JSON", "format", "fence", "SCORE:", etc.)
   *   - hasConstraints (contains "must", "never", "always", "do not")
   *   - hasExamples (contains "Example" or "example")
   *   - conflictingInstructions (high-precision patterns only)
   */
  async analyzePrompts(agentId?: string): Promise<PromptAnalysisResult[]> {
    const results: PromptAnalysisResult[] = [];
    const agentDirs = readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '_shared' && d.name !== 'prompt-engineer')
      .map(d => d.name);

    for (const dir of agentDirs) {
      if (agentId && dir !== agentId) continue;

      const indexPath = join(agentsDir, dir, 'index.ts');
      if (!existsSync(indexPath)) continue;

      let content: string;
      try {
        content = readFileSync(indexPath, 'utf8');
      } catch {
        continue;
      }

      // Extract ALL prompt constants (SYSTEM_PROMPT + any secondary prompts)
      const promptRegex = /const\s+(\w+PROMPT\w*)\s*=\s*`([\s\S]*?)`/g;
      let match: RegExpExecArray | null;
      const prompts: PromptAnalysisResult['prompts'] = [];

      while ((match = promptRegex.exec(content)) !== null) {
        const promptName = match[1];
        const promptContent = match[2];
        const lineInFile = content.slice(0, match.index).split('\n').length;
        const findings = this.analyzeSinglePrompt(promptContent, dir, promptName, lineInFile);
        prompts.push({
          promptName,
          content: promptContent,
          tokenEstimate: Math.ceil(promptContent.length / 4),
          findings,
        });
      }

      // Also check fabrication/cad.ts for CAD prompt
      const cadPath = join(agentsDir, dir, 'cad.ts');
      if (existsSync(cadPath)) {
        try {
          const cadContent = readFileSync(cadPath, 'utf8');
          const cadPromptRegex = /const\s+(\w+PROMPT\w*)\s*=\s*`([\s\S]*?)`/g;
          while ((match = cadPromptRegex.exec(cadContent)) !== null) {
            const promptName = match[1];
            const promptContent = match[2];
            const lineInFile = cadContent.slice(0, match.index).split('\n').length;
            const findings = this.analyzeSinglePrompt(promptContent, dir, promptName, lineInFile);
            prompts.push({
              promptName,
              content: promptContent,
              tokenEstimate: Math.ceil(promptContent.length / 4),
              findings,
            });
          }
        } catch { /* skip */ }
      }

      if (prompts.length > 0) {
        const totalFindings = prompts.reduce((sum, p) => sum + p.findings.length, 0);
        results.push({ agentId: dir, prompts, totalFindings });
      }
    }

    return results;
  }

  /**
   * Analyze a single prompt string for structural issues.
   */
  private analyzeSinglePrompt(
    content: string,
    agentId: string,
    promptName: string,
    lineOffset: number,
  ): PromptFinding[] {
    const findings: PromptFinding[] = [];
    const tokenEstimate = Math.ceil(content.length / 4);

    // Length check
    if (tokenEstimate > 2000) {
      findings.push({
        agentId, promptName,
        findingType: 'length',
        severity: 'warning',
        detail: `Prompt is ~${tokenEstimate} tokens (>${2000}). Consider splitting or condensing.`,
        line: lineOffset,
      });
    }
    if (tokenEstimate < 50 && content.trim().length > 0) {
      findings.push({
        agentId, promptName,
        findingType: 'length',
        severity: 'warning',
        detail: `Prompt is ~${tokenEstimate} tokens (<50). Too short for effective guidance.`,
        line: lineOffset,
      });
    }

    // Role definition check
    const hasRole = /you\s+are\s+/i.test(content) || /your\s+role/i.test(content);
    if (!hasRole) {
      findings.push({
        agentId, promptName,
        findingType: 'missing-role',
        severity: 'info',
        detail: 'No role definition found (expected "You are" or "Your role").',
        line: lineOffset,
      });
    }

    // Output format check (only for structured-output agents)
    if (STRUCTURED_OUTPUT_AGENTS.has(agentId)) {
      const hasOutputFormat = /format|JSON|fence|SCORE:|APPROVED:|<review>|output/i.test(content);
      if (!hasOutputFormat) {
        findings.push({
          agentId, promptName,
          findingType: 'missing-output-format',
          severity: 'warning',
          detail: 'Structured-output agent prompt lacks output format specification.',
          line: lineOffset,
        });
      }
    }

    // Constraints check
    const hasConstraints = /\bmust\b|\bnever\b|\balways\b|\bdo not\b/i.test(content);
    if (!hasConstraints) {
      findings.push({
        agentId, promptName,
        findingType: 'missing-constraints',
        severity: 'info',
        detail: 'No explicit constraints found (expected "must", "never", "always", or "do not").',
        line: lineOffset,
      });
    }

    // Examples check
    const hasExamples = /\bexample\b/i.test(content);
    if (!hasExamples) {
      findings.push({
        agentId, promptName,
        findingType: 'missing-examples',
        severity: 'info',
        detail: 'No examples found in prompt. Examples improve output quality.',
        line: lineOffset,
      });
    }

    // Conflicting instructions check (HIGH PRECISION only)
    for (const { pattern, description } of CONFLICT_PATTERNS) {
      if (pattern.test(content)) {
        findings.push({
          agentId, promptName,
          findingType: 'conflicting-instructions',
          severity: 'warning',
          detail: description,
          line: lineOffset,
        });
      }
    }

    return findings;
  }

  // ── 2. Empirical parse-success test ────────────────────────────────
  /**
   * Invoke CodeReviewAgent.review() with benign test input and observe
   * the reviewTier. Correctly flags stub-engine results as inconclusive.
   *
   * Per directive Section 2: "Be EXPLICIT when the stub engine is active:
   * this test CANNOT meaningfully evaluate prompt quality in that state
   * (every result will be stub-fallback regardless of prompt quality) —
   * mark as inconclusive: true."
   *
   * Only CodeReviewAgent is safe to invoke directly (no side effects).
   * For DatabaseAgent/SecurityAgent/ResearchAgent: returns 'not-applicable'
   * with a note explaining why.
   */
  async empiricalTest(agentId: string): Promise<EmpiricalTestResult> {
    // Only CodeReviewAgent is safe to invoke directly
    if (agentId !== 'code-review') {
      return {
        agentId,
        reviewTier: 'not-applicable',
        inconclusive: true,
        reason: `Empirical test not available for ${agentId}: its structured-output method has side effects (Ghost Mode, writeProjectFile, or SDK calls). Static analysis only — see analyzePrompts().`,
      };
    }

    // Import CodeReviewAgent dynamically (avoid circular deps at module load)
    try {
      const { CodeReviewAgent } = await import('../code-review/index.js');
      const { agentManager } = await import('../../orchestration/agent-manager.js');

      let agent = agentManager.get('code-review-agent');
      if (!agent) {
        agent = new CodeReviewAgent();
      }

      // Call review() with benign test content
      const result = await agent.review({
        content: 'export function add(a: number, b: number): number { return a + b; }',
        files: ['test.ts'],
      });

      // Determine if stub engine is active (reviewTier === 'stub-fallback')
      const isStub = result.reviewTier === 'stub-fallback';
      return {
        agentId,
        reviewTier: result.reviewTier ?? 'not-applicable',
        inconclusive: isStub,
        reason: isStub
          ? 'Stub engine is active — result is stub-fallback regardless of prompt quality. Cannot meaningfully evaluate prompt. Run with Ollama or OpenRouter for a real test.'
          : 'Real LLM engine produced a structured result — prompt is functioning.',
      };
    } catch (err: any) {
      return {
        agentId,
        reviewTier: 'llm-error',
        inconclusive: true,
        reason: `Empirical test failed: ${err.message}`,
      };
    }
  }

  // ── 3. Prompt improvement proposals — NEVER auto-applied ──────────
  /**
   * Generate a proposed improved prompt based on objective findings.
   *
   * CRITICAL: This method MUST NEVER call writeProjectFile().
   * It only RETURNS a PromptProposal. The caller decides whether to apply.
   * Proven by spy test.
   */
  async proposeImprovedPrompt(agentId: string): Promise<PromptProposal | null> {
    // Fabrication guard: agent must exist
    const analyses = await this.analyzePrompts(agentId);
    if (analyses.length === 0) {
      return null;
    }

    const analysis = analyses[0];
    const allFindings = analysis.prompts.flatMap(p => p.findings);

    // If no findings, no improvements needed
    if (allFindings.length === 0) {
      return {
        agentId,
        promptName: 'SYSTEM_PROMPT',
        proposedPrompt: analysis.prompts[0]?.content ?? '',
        changes: [],
      };
    }

    // Build the improved prompt based on findings
    const originalPrompt = analysis.prompts[0]?.content ?? '';
    const changes: PromptProposal['changes'] = [];
    let improved = originalPrompt;

    // Address missing output format
    const missingOutputFormat = allFindings.find(f => f.findingType === 'missing-output-format');
    if (missingOutputFormat) {
      improved += '\n\nOutput format: Wrap your response in <review>{...json...}</review> tags.';
      changes.push({
        what: 'Added output format specification (<review>JSON</review> fence)',
        why: 'Agent expects structured output but prompt did not specify format',
        findingType: 'missing-output-format',
      });
    }

    // Address missing constraints
    const missingConstraints = allFindings.find(f => f.findingType === 'missing-constraints');
    if (missingConstraints) {
      improved += '\n\nConstraints: Never fabricate information. Always cite sources. Do not guess.';
      changes.push({
        what: 'Added explicit constraints (never fabricate, cite sources, do not guess)',
        why: 'Prompt lacked explicit behavioral constraints',
        findingType: 'missing-constraints',
      });
    }

    // Address missing examples
    const missingExamples = allFindings.find(f => f.findingType === 'missing-examples');
    if (missingExamples) {
      improved += '\n\nExample output:\n<review>\n{"score": 85, "approved": true}\n</review>';
      changes.push({
        what: 'Added example output',
        why: 'Examples improve LLM output quality and format adherence',
        findingType: 'missing-examples',
      });
    }

    // Address length issues
    const lengthIssue = allFindings.find(f => f.findingType === 'length');
    if (lengthIssue) {
      changes.push({
        what: 'Note: prompt length issue detected',
        why: lengthIssue.detail,
        findingType: 'length',
      });
    }

    return {
      agentId,
      promptName: analysis.prompts[0]?.promptName ?? 'SYSTEM_PROMPT',
      proposedPrompt: improved,
      changes,
    };
  }

  // ── Chat persona (preserved from original stub) ────────────────────
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
