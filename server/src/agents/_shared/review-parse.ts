// server/src/agents/_shared/review-parse.ts
// Shared LLM response parsing utilities — used by CodeReviewAgent (per-write
// gate) and SecurityAgent (holistic auth/session review).
//
// Phase C Agent 2: extracted from CodeReviewAgent's private parseReviewResponse()
// method. Per directive Section 0 Finding 5: the original Phase C Agent 1 did
// NOT extract this — the parser was still private. This refactor creates the
// shared module that should have existed from the start.
//
// Split into TWO functions per user refinement:
//   1. extractFencedJson(text) — GENERIC fence detection + JSON parse.
//      Has no knowledge of ReviewResult or any specific result shape.
//      Returns the parsed object or null if no valid fenced JSON found.
//   2. parseReviewResponse(text, securityIssues) — CodeReviewAgent-SPECIFIC.
//      Knows about ReviewResult, SCORE:/APPROVED: text format, stub-fallback.
//      Internally calls extractFencedJson() as the first parse attempt.
//
// SecurityAgent's auth review calls extractFencedJson() directly and maps
// the result to its own AuthFinding[] shape — it does NOT force itself
// through ReviewResult (different shape, different semantics).

import type { ReviewResult } from '../../types.js';

/**
 * Extract fenced JSON from an LLM response.
 *
 * Looks for <review>...</review> XML-style fences containing a JSON object.
 * Returns the parsed object if the fences are present and the JSON is valid;
 * returns null otherwise.
 *
 * This is a GENERIC utility — it has no knowledge of ReviewResult or any
 * specific result shape. Callers are responsible for validating the parsed
 * object's fields and mapping them to their own result type.
 *
 * Fence format: <review>{...json...}</review>
 * - Case-insensitive on the tag names
 * - Allows whitespace/newlines inside the fences
 * - Does NOT require the JSON to be on a single line (multi-line JSON works)
 * - Returns null if: no fences, no closing tag, malformed JSON, or empty
 *
 * @param text The LLM response text to parse
 * @returns The parsed JSON object, or null if no valid fenced JSON found
 */
export function extractFencedJson(text: string): Record<string, unknown> | null {
  const fenceMatch = text.match(/<review>\s*([\s\S]*?)\s*<\/review>/i);
  if (!fenceMatch) return null;

  try {
    const parsed = JSON.parse(fenceMatch[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    // JSON parse failed inside fences — return null (caller can fall through
    // to its own text-parse fallback if it has one)
    return null;
  }
}

/**
 * Parse an LLM review response into a ReviewResult.
 *
 * This is CodeReviewAgent-SPECIFIC — it knows about:
 *   - <review>JSON</review> fence extraction (via extractFencedJson)
 *   - SCORE:/APPROVED:/SUMMARY: text-parse fallback
 *   - stub-fallback (approved:true, score:75) as the last resort
 *
 * Phase C — three-tier parse chain (ALL three preserved, not replaced):
 *   1. FIRST: <review>{...json...}</review> fence extraction (via extractFencedJson)
 *      If the LLM wrapped its output in XML fences, parse the JSON.
 *   2. SECOND: SCORE:/APPROVED:/SUMMARY: text-parse (existing, unchanged)
 *      If no fences but the text has SCORE: and APPROVED: lines, use those.
 *   3. FINAL: stub-fallback (existing, unchanged — approved:true, score:75)
 *      If neither fences nor SCORE:/APPROVED:, and no security issues,
 *      default to approved at 75. Tagged with reviewTier='stub-fallback'.
 *
 * @param text The LLM response text to parse
 * @param securityIssues Tier 1 security issues (already-detected). If non-empty,
 *                       the result is always rejected regardless of LLM output.
 * @returns A ReviewResult with reviewTier set to indicate which tier produced it
 */
export function parseReviewResponse(text: string, securityIssues: string[]): ReviewResult {
  // ── TIER 2a: <review>JSON</review> fence extraction (via shared extractFencedJson) ──
  const parsed = extractFencedJson(text);
  if (parsed) {
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
    // Fence JSON parsed but missing required score/approved fields —
    // fall through to text-parse
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
