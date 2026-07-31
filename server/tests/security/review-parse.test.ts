// tests/security/review-parse.test.ts
//
// Phase C Agent 2 — Unit tests for the shared extractFencedJson() function.
//
// Per user refinement: extractFencedJson() is a GENERIC utility (no knowledge
// of ReviewResult). These tests verify it works standalone, independent of
// CodeReviewAgent or SecurityAgent.
//
// parseReviewResponse() is still tested via code-review-tier2.test.ts
// (unchanged — those tests call CodeReviewAgent.review() which internally
// calls the now-shared parseReviewResponse()).

import { describe, it, expect } from 'vitest';
import { extractFencedJson } from '../../src/agents/_shared/review-parse.js';

describe('Phase C Agent 2 — shared extractFencedJson()', () => {
  it('extracts valid fenced JSON object', () => {
    const text = 'Here is my review:\n<review>\n{"score": 85, "approved": true}\n</review>\nDone.';
    const result = extractFencedJson(text);
    expect(result).toEqual({ score: 85, approved: true });
  });

  it('extracts multi-line JSON', () => {
    const text = '<review>\n{\n  "findings": [\n    {"file": "a.ts", "issue": "bad"}\n  ]\n}\n</review>';
    const result = extractFencedJson(text);
    expect(result).toEqual({ findings: [{ file: 'a.ts', issue: 'bad' }] });
  });

  it('handles whitespace inside fences', () => {
    const text = '<review>   {"key": "value"}   </review>';
    const result = extractFencedJson(text);
    expect(result).toEqual({ key: 'value' });
  });

  it('is case-insensitive on tag names', () => {
    const text = '<REVIEW>\n{"x": 1}\n</REVIEW>';
    const result = extractFencedJson(text);
    expect(result).toEqual({ x: 1 });
  });

  it('returns null when no fences present', () => {
    const text = 'Just plain text with no fences. {"score": 50} but not wrapped.';
    const result = extractFencedJson(text);
    expect(result).toBeNull();
  });

  it('returns null when closing tag is missing', () => {
    const text = '<review>\n{"score": 50}\n(no closing tag)';
    const result = extractFencedJson(text);
    expect(result).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    const text = '<review>\n{bad json missing quotes}\n</review>';
    const result = extractFencedJson(text);
    expect(result).toBeNull();
  });

  it('returns null when parsed value is not an object (e.g. array)', () => {
    const text = '<review>\n[1, 2, 3]\n</review>';
    const result = extractFencedJson(text);
    expect(result).toBeNull();
  });

  it('returns null when parsed value is a primitive (e.g. number)', () => {
    const text = '<review>\n42\n</review>';
    const result = extractFencedJson(text);
    expect(result).toBeNull();
  });

  it('returns null for empty text', () => {
    const result = extractFencedJson('');
    expect(result).toBeNull();
  });

  it('returns null for text with only whitespace', () => {
    const result = extractFencedJson('   \n\t  ');
    expect(result).toBeNull();
  });

  it('handles JSON with nested objects + arrays', () => {
    const text = '<review>\n{"outer": {"inner": [1, 2, {"deep": true}]}, "count": 3}\n</review>';
    const result = extractFencedJson(text);
    expect(result).toEqual({ outer: { inner: [1, 2, { deep: true }] }, count: 3 });
  });

  it('handles JSON with string values containing <review> as literal text', () => {
    // The regex is non-greedy ([\s\S]*?) so it stops at the first </review>.
    // A string value containing <review> as literal text doesn't confuse it
    // because the closing tag is what matters.
    const text = '<review>\n{"note": "this mentions <review> tag"}\n</review>';
    const result = extractFencedJson(text);
    expect(result).toEqual({ note: 'this mentions <review> tag' });
  });
});
