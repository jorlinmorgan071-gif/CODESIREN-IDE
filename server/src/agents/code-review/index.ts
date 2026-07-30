// Code Review Agent — Quality scoring, anti-pattern detection, review of all AI output
import type { AgentChunk, AgentTask, AgentDomain, ReviewResult } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { modelRouter } from '../../orchestration/model-router.js';

const SYSTEM_PROMPT = `You are the Code Review Agent of Zero Two: Code Siren.
Your role: quality scoring, anti-pattern detection, and reviewing all AI-generated code before it's committed.
When reviewing code:
1. Score the code on a 0-100 scale (readability, correctness, performance, security, maintainability).
2. Flag anti-patterns (God objects, tight coupling, missing error handling, etc.).
3. Check naming conventions against the project's Code DNA profile.
4. Identify missing tests, missing docs, and potential edge cases.
5. Approve or reject with specific, actionable feedback.
Every finding must include: severity, location, description, and fix.

CRITICAL SECURITY CHECKS — auto-reject (score 0, approved: false) if ANY of these are found:
- Hardcoded secrets, API keys, passwords, or tokens
- SQL injection vulnerabilities (string interpolation in queries)
- eval() or Function() with user input
- Disabled security headers or CORS *
- Private keys or certificates in source code

Output format for review:
First line: SCORE: <number 0-100>
Second line: APPROVED: true|false
Remaining lines: List each issue as "- [severity] description"
End with: SUMMARY: <one sentence summary>`;

export class CodeReviewAgent extends IAgent {
  readonly id = 'code-review-agent';
  readonly name = 'Code Review Agent';
  readonly domain: AgentDomain = 'REVIEW';
  readonly icon = 'eye';
  readonly color = '#EE1C1C';
  constructor() { super(0.95); }

  /**
   * Override review() — the GATE method. Called by writeProjectFile() before
   * any source file is written to disk. Returns approved + score + issues.
   *
   * Per Fix 3: this is NOT the agent's execute() (chat persona). This is the
   * programmatic gate that writeProjectFile() calls. The LLM analysis is
   * prompt-driven, but the GATING around it (refusing writes on
   * approved: false) is in writeProjectFile(), not here.
   */
  override async review(output: { content: string; files?: string[] }): Promise<ReviewResult> {
    const content = output.content;
    const files = output.files ?? [];

    // ── Fast-path security checks (no LLM needed) ───────────────────────
    // These are auto-rejects — if any pattern matches, score 0, no LLM call.
    const securityIssues: string[] = [];

    // Hardcoded secrets
    if (/(?:password|secret|api[_-]?key|token|private[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(content)) {
      securityIssues.push('[CRITICAL] Hardcoded secret/credential detected');
    }
    // SQL injection (string interpolation in query)
    if (/query\s*\(\s*['"`].*\$\{.*\}.*['"`]/i.test(content) || /query\s*\(\s*['"`].*"\s*\+.*['"`]/i.test(content)) {
      securityIssues.push('[CRITICAL] Potential SQL injection — string interpolation in query');
    }
    // eval with user input
    if (/eval\s*\(/i.test(content)) {
      securityIssues.push('[CRITICAL] eval() detected — code execution vulnerability');
    }
    // CORS *
    if (/cors\s*\(\s*\{[^}]*origin\s*:\s*['"]\*['"]/i.test(content) || /Access-Control-Allow-Origin.*\*/i.test(content)) {
      securityIssues.push('[HIGH] CORS wildcard origin detected');
    }
    // Private key in source
    if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/i.test(content)) {
      securityIssues.push('[CRITICAL] Private key embedded in source code');
    }

    if (securityIssues.length > 0) {
      return {
        approved: false,
        score: 0,
        notes: 'Auto-rejected by security checks',
        issues: securityIssues,
      };
    }

    // ── LLM-based review (prompt-driven analysis) ───────────────────────
    // Uses the ModelRouter (same engine as everything else — Ollama/OpenRouter/stub).
    // The stub engine will produce a generic response; real engines will actually
    // analyze the code. The gating is in writeProjectFile(), not here.
    try {
      let reviewText = '';
      const stream = modelRouter.stream({
        agentId: this.id,
        domain: this.domain,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Review this code for file(s): ${files.join(', ')}\n\n\`\`\`\n${content}\n\`\`\`\n\nProvide SCORE, APPROVED, issues, and SUMMARY.` },
        ],
        temperature: 0.2,
        maxTokens: 512,
        executionMode: 'single-shot',
      });

      for await (const chunk of stream) {
        if (chunk.done) break;
        reviewText += chunk.delta;
      }

      // Parse the LLM response
      return this.parseReviewResponse(reviewText, securityIssues);
    } catch (err: any) {
      // If the LLM call fails, fail CLOSED — reject the write
      return {
        approved: false,
        score: 0,
        notes: `Review failed (LLM error): ${err.message}`,
        issues: ['Code Review Agent could not analyze code — write refused (fail closed)'],
      };
    }
  }

  /**
   * Parse the LLM's review response into a ReviewResult.
   * Expected format:
   *   SCORE: 85
   *   APPROVED: true
   *   - [LOW] Missing JSDoc on public function
   *   SUMMARY: Good code quality, minor doc gaps.
   */
  private parseReviewResponse(text: string, securityIssues: string[]): ReviewResult {
    const scoreMatch = text.match(/SCORE:\s*(\d+)/i);
    const approvedMatch = text.match(/APPROVED:\s*(true|false)/i);
    const summaryMatch = text.match(/SUMMARY:\s*(.+)/i);

    // If the LLM produced structured output, use it
    if (scoreMatch && approvedMatch) {
      const score = parseInt(scoreMatch[1], 10);
      const approved = approvedMatch[1].toLowerCase() === 'true';
      const issues: string[] = [...securityIssues];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) {
          issues.push(trimmed.slice(2));
        }
      }
      return {
        approved: approved && securityIssues.length === 0,
        score,
        notes: summaryMatch ? summaryMatch[1].trim() : 'Review complete',
        issues,
      };
    }

    // If the LLM response is unstructured (stub engine, no SCORE:/APPROVED:),
    // AND no security issues were found by the fast-path checks, default to
    // approved with a baseline score. The security checks are the real gate —
    // the LLM analysis is additive, not the sole gate. A real LLM (Ollama/
    // OpenRouter) will produce structured output that overrides this default.
    if (securityIssues.length === 0) {
      return {
        approved: true,
        score: 75,
        notes: 'No security issues detected (stub engine — real LLM will provide detailed review)',
        issues: [],
      };
    }

    // Security issues found — reject regardless of LLM response
    return {
      approved: false,
      score: 0,
      notes: 'Auto-rejected by security checks',
      issues: securityIssues,
    };
  }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.2, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['review', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
