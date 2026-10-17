// Helper: generate a deterministic pseudo-random token-shaped string at
// runtime. No token-shaped literal appears in source — the string is built
// character-by-character from a seeded PRNG so:
//   (a) gitleaks / static scanners see only the prefix + a `buildToken()`
//       call site, never the full token.
//   (b) the test is reproducible (same seed → same string every run).
//   (c) the entropy is high enough to exercise the entropy-based detector.
//
// LCG parameters from Numerical Recipes (a=1664525, c=1013904223, m=2^32).
// Not cryptographically secure — that's the point. This is test fixture only.

/**
 * Build a token-shaped string at runtime from a seeded PRNG.
 *
 * @param prefix   The token prefix (e.g. 'ghp_', 'github_pat_')
 * @param suffixLen  Number of characters to append after the prefix
 * @param alphabet   Characters to draw from for the suffix. Must match the
 *                   character class the regex under test expects:
 *                     - ghp_ classic PATs use [A-Za-z0-9] (no underscores)
 *                     - github_pat_ fine-grained PATs use [A-Za-z0-9_]
 * @param seed      Seed for the PRNG (same seed → same string every run)
 */
export function buildToken(
  prefix: string,
  suffixLen: number,
  alphabet: string,
  seed = 0x5eed1234,
): string {
  let state = seed >>> 0;
  let suffix = '';
  for (let i = 0; i < suffixLen; i++) {
    // LCG step (Numerical Recipes constants)
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    suffix += alphabet[state % alphabet.length];
  }
  return prefix + suffix;
}

// Alphabets matching the regex character classes in secret-patterns.ts:
// - ghp_ classic PATs: /ghp_[A-Za-z0-9]{36}/  (no underscores)
// - github_pat_ fine-grained PATs: /github_pat_[A-Za-z0-9_]{40,}/  (underscores ok)
const ALPHABET_BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ALPHABET_BASE62_UNDERSCORE = ALPHABET_BASE62 + '_';

// High-entropy fake github_pat_ for the entropy test + github_pat_ reject test.
// Length matches a real fine-grained PAT: 11-char prefix + 82-char body = 93 chars.
export const fakeGithubPatHighEntropy = buildToken(
  'github_pat_',
  82,
  ALPHABET_BASE62_UNDERSCORE,
);

// High-entropy fake ghp_ for the ghp_ reject test.
// Length matches a real classic PAT: 4-char prefix + 36-char body = 40 chars.
export const fakeGhpTokenHighEntropy = buildToken(
  'ghp_',
  36,
  ALPHABET_BASE62,
  0xfa11beef,
);
