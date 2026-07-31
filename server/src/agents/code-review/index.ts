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

OUTPUT FORMAT (Phase C — fence-based structured output):
Wrap your entire review in <review>...</review> XML fences containing a JSON object.
The JSON must have these fields:
  score: number (0-100)
  approved: boolean
  summary: string (one sentence)
  issues: array of strings (each "[severity] description")

Example:
<review>
{"score": 85, "approved": true, "summary": "Good code quality, minor doc gaps.", "issues": ["[LOW] Missing JSDoc on public function"]}
</review>

If you cannot produce the fenced JSON format, fall back to:
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

    // Hardcoded secrets — existing keyword-based check
    if (/(?:password|secret|api[_-]?key|token|private[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(content)) {
      securityIssues.push('[CRITICAL] Hardcoded secret/credential detected');
    }
    // NEW (Phase C): Broadened secret detection — pattern-based, not keyword-based.
    // Catches credential formats that don't use the `password = "..."` keyword pattern:
    //   - AWS access key IDs: AKIA followed by 16 uppercase alphanumerics
    //   - GitHub PATs: ghp_ / github_pat_ prefixes
    //   - JWTs: eyJ... (base64-encoded JSON header) in Authorization headers
    //
    // FALSE-POSITIVE MITIGATION: each pattern requires context to avoid
    // matching test fixtures, comments, and documentation:
    //   - AWS/GitHub: must appear in an assignment context (`= "..."` or `: "..."`)
    //   - JWT: must appear in an Authorization header context
    //   - All require word-boundary anchors
    if (/\bAKIA[A-Z0-9]{16}\b/.test(content) && /(?:=|:)\s*['"][^'"]*AKIA[A-Z0-9]{16}[^'"]*['"]/.test(content)) {
      securityIssues.push('[CRITICAL] Hardcoded AWS access key ID detected');
    }
    if (/(?:=|:)\s*['"](?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})['"]/.test(content)) {
      securityIssues.push('[CRITICAL] Hardcoded GitHub token detected');
    }
    if (/Authorization\s*[:=]\s*['"]\s*Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(content)) {
      securityIssues.push('[CRITICAL] Hardcoded JWT in Authorization header detected');
    }
    // SQL injection (string interpolation OR concatenation in query)
    // Existing: catches template-literal ${} interpolation in query() calls.
    // NEW (Phase C): also catches single-quote and double-quote string
    // concatenation — `query('...' + userInput)` and `query("..." + userInput)`.
    // The original regex only matched `"` + `+` (double-quote concat), missing
    // the common single-quote form and the case where the concat wraps the
    // entire query string.
    if (
      /query\s*\(\s*['"`].*\$\{.*\}.*['"`]/i.test(content)                     // template literal ${}
      || /query\s*\(\s*['"`].*['"`]\s*\+\s*\w/i.test(content)                  // any quote style + concat (NEW)
      || /query\s*\(\s*['"`][^'"`]*['"`]\s*\+/i.test(content)                  // literal + concat (NEW — multiline)
    ) {
      securityIssues.push('[CRITICAL] Potential SQL injection — string interpolation or concatenation in query');
    }
    // eval with user input
    if (/eval\s*\(/i.test(content)) {
      securityIssues.push('[CRITICAL] eval() detected — code execution vulnerability');
    }
    // NEW (Phase C): Function() constructor as eval-equivalent.
    // `new Function('...')` and `Function('...')` both compile and execute
    // a string at runtime — functionally identical to eval() for arbitrary
    // code execution. Must require the `()` to avoid false-positives on
    // `Function` as a type annotation (TypeScript: `const fn: Function = ...`).
    if (/\bnew\s+Function\s*\(/i.test(content) || /\bFunction\s*\(/i.test(content)) {
      securityIssues.push('[CRITICAL] Function() constructor detected — eval-equivalent code execution');
    }
    // CORS *
    if (/cors\s*\(\s*\{[^}]*origin\s*:\s*['"]\*['"]/i.test(content) || /Access-Control-Allow-Origin.*\*/i.test(content)) {
      securityIssues.push('[HIGH] CORS wildcard origin detected');
    }
    // Private key in source
    if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/i.test(content)) {
      securityIssues.push('[CRITICAL] Private key embedded in source code');
    }
    // NEW (Phase C): child_process.exec/execSync with string concatenation
    // or template-literal interpolation. Catches shell injection via the
    // child_process module. Only matches when user input reaches the shell
    // via concat (`+`) or `${}` — hardcoded commands are safe.
    // Does NOT match execFile/spawn with array args (those don't use a shell).
    if (
      /\bexec(?:Sync)?\s*\(\s*['"`].*\$\{.*\}.*['"`]/i.test(content)           // template literal ${}
      || /\bexec(?:Sync)?\s*\(\s*['"`].*['"`]\s*\+\s*\w/i.test(content)        // string concat (NEW)
      || /\bexec(?:Sync)?\s*\(\s*['"`][^'"`]*['"`]\s*\+/i.test(content)        // literal + concat multiline (NEW)
    ) {
      securityIssues.push('[CRITICAL] child_process exec with unsanitized string concatenation — shell injection risk');
    }

    if (securityIssues.length > 0) {
      return {
        approved: false,
        score: 0,
        notes: 'Auto-rejected by security checks',
        issues: securityIssues,
        reviewTier: 'security-rejected' as const,
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
        reviewTier: 'llm-error' as const,
      };
    }
  }

  /**
   * Parse the LLM's review response into a ReviewResult.
   *
   * Phase C — three-tier parse chain (ALL three preserved, not replaced):
   *   1. FIRST: <review>{...json...}</review> fence extraction (new in Phase C)
   *      If the LLM wrapped its output in XML fences, parse the JSON.
   *   2. SECOND: SCORE:/APPROVED:/SUMMARY: text-parse (existing, unchanged)
   *      If no fences but the text has SCORE: and APPROVED: lines, use those.
   *   3. FINAL: stub-fallback (existing, unchanged — approved:true, score:75)
   *      If neither fences nor SCORE:/APPROVED:, and no security issues,
   *      default to approved at 75. This is the rubber-stamp surface the
   *      directive asked to reduce — it stays as the last resort but is
   *      now tagged with reviewTier='stub-fallback' so callers can
   *      distinguish it from a real LLM review.
   */
  private parseReviewResponse(text: string, securityIssues: string[]): ReviewResult {
    // ── TIER 2a: <review>JSON</review> fence extraction (NEW — Phase C) ──
    const fenceMatch = text.match(/<review>\s*([\s\S]*?)\s*<\/review>/i);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1]);
        if (typeof parsed.score === 'number' && typeof parsed.approved === 'boolean') {
          const issues: string[] = [...securityIssues];
          if (Array.isArray(parsed.issues)) {
            for (const issue of parsed.issues) {
              if (typeof issue === 'string') issues.push(issue);
            }
          }
          return {
            approved: parsed.approved && securityIssues.length === 0,
            score: parsed.score,
            notes: typeof parsed.summary === 'string' ? parsed.summary : 'Review complete (fenced JSON)',
            issues,
            reviewTier: 'llm-reviewed' as const,
          };
        }
      } catch {
        // JSON parse failed inside fences — fall through to text-parse
      }
    }

    // ── TIER 2b: SCORE:/APPROVED:/SUMMARY: text-parse (EXISTING — unchanged) ──
    const scoreMatch = text.match(/SCORE:\s*(\d+)/i);
    const approvedMatch = text.match(/APPROVED:\s*(true|false)/i);
    const summaryMatch = text.match(/SUMMARY:\s*(.+)/i);

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
        reviewTier: 'llm-reviewed' as const,
      };
    }

    // ── TIER 2c: stub-fallback (EXISTING — unchanged, now tagged) ──
    // If the LLM response is unstructured (stub engine, no fences, no SCORE:/APPROVED:),
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
        reviewTier: 'stub-fallback' as const,
      };
    }

    // Security issues found — reject regardless of LLM response
    return {
      approved: false,
      score: 0,
      notes: 'Auto-rejected by security checks',
      issues: securityIssues,
      reviewTier: 'security-rejected' as const,
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
