// server/src/security/secret-patterns.ts
// Phase A Section 4: shared secret-detection patterns + entropy detection.
//
// The 5 known-pattern regexes are EXTRACTED from CodeReviewAgent's fast-path
// (server/src/agents/code-review/index.ts) so both CodeReviewAgent (write-time
// gate) and the new secret scanner (periodic + on-demand) use the SAME
// patterns — no drift between the two.
//
// Entropy detection adds coverage for custom API keys (Stripe, Slack, generic
// service tokens) that don't match a known prefix. Per Section 0's testing:
// Shannon entropy ≥ 4.0 + length ≥ 20, excluding UUIDs/hex-hashes/data-URIs.
// Reports as matchType='entropy' (severity medium) — NOT 'known-pattern' —
// because entropy alone is less certain than a format match.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────

export type SecretMatchType = 'known-pattern' | 'entropy';

export interface SecretFinding {
  /** File path (project-relative). */
  file: string;
  /** 1-indexed line number where the secret appears. */
  line: number;
  /** Which detection matched: 'known-pattern' (high confidence) or 'entropy' (medium). */
  matchType: SecretMatchType;
  /** Which specific pattern matched (e.g. 'aws-access-key', 'github-pat', 'entropy'). */
  pattern: string;
  /** Human-readable description of what was found. */
  description: string;
  /** The matched text (truncated for safety — full secret NOT stored in findings). */
  preview: string;
  /** Severity: 'high' for known-pattern, 'medium' for entropy. */
  severity: 'high' | 'medium';
}

// ── Known patterns (extracted from CodeReviewAgent) ─────────────────────
//
// Each entry: { id, test(content) → boolean, description }
// The test() function receives the FULL file content (some patterns need
// context-checks that span the whole file, like AWS keys).

export interface KnownSecretPattern {
  id: string;
  description: string;
  /** Returns the matched string if found, null otherwise. */
  match: (content: string) => string | null;
}

export const KNOWN_PATTERNS: KnownSecretPattern[] = [
  {
    id: 'keyword-secret',
    description: 'Hardcoded secret/credential (password/secret/api_key/token/private_key assignment)',
    match: (content) => {
      const re = /(?:password|secret|api[_-]?key|token|private[_-]?key)\s*[:=]\s*['"]([^'"]{8,})['"]/i;
      const m = content.match(re);
      return m ? m[1] : null;
    },
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key ID (AKIA + 16 uppercase alphanumerics, in assignment context)',
    match: (content) => {
      if (/\bAKIA[A-Z0-9]{16}\b/.test(content) && /(?:=|:)\s*['"][^'"]*AKIA[A-Z0-9]{16}[^'"]*['"]/.test(content)) {
        const m = content.match(/\b(AKIA[A-Z0-9]{16})\b/);
        return m ? m[1] : 'AKIA***';
      }
      return null;
    },
  },
  {
    id: 'github-pat',
    description: 'GitHub personal access token (ghp_ / github_pat_ prefix, in assignment context)',
    match: (content) => {
      const m = content.match(/(?:=|:)\s*['"]((?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}))['"]/);
      return m ? m[1] : null;
    },
  },
  {
    id: 'jwt-bearer',
    description: 'JWT in Authorization header (Bearer eyJ... format)',
    match: (content) => {
      const m = content.match(/Authorization\s*[:=]\s*['"]\s*Bearer\s+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i);
      return m ? m[1] : null;
    },
  },
  {
    id: 'private-key-block',
    description: 'PEM private key block (-----BEGIN ... PRIVATE KEY-----)',
    match: (content) => {
      const m = content.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/i);
      return m ? m[0] : null;
    },
  },
];

// ── Entropy detection ───────────────────────────────────────────────────
//
// Per Section 0 testing:
//   - Shannon entropy ≥ 4.0 (catches GitHub PATs=5.5, JWTs=5.4, Stripe keys ~3.6-5+)
//   - Length ≥ 20 (shorter strings are almost never secrets)
//   - Exclude UUIDs, hex hashes (SHA-1/256/MD5), data URIs, file paths
//
// Extract candidate tokens from string literals + assignments:
//   - Quoted strings: '...' or "..." or `...`
//   - Env assignments: KEY = "value" or KEY: "value"
//
// We DON'T compute entropy on entire file contents — only on individual
// extracted string literals. This dramatically reduces false positives.

const ENTROPY_THRESHOLD = 4.5;
const MIN_LENGTH = 20;

function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function isHexHash(s: string): boolean {
  // SHA-1 (40), SHA-256 (64), MD5 (32) — all hex
  return /^[0-9a-f]{32,64}$/i.test(s);
}

function isDataUri(s: string): boolean {
  return /^data:[a-z]+\/[a-z]+;base64,/i.test(s);
}

function isFalsePositive(s: string): boolean {
  if (isUuid(s)) return true;
  if (isHexHash(s)) return true;
  if (isDataUri(s)) return true;
  // File paths (contain / and end with common extensions)
  if (/^\/(?:usr|home|var|tmp|opt|etc)\//i.test(s)) return true;
  // URLs (http/https/ftp — these are caught by their own patterns elsewhere)
  if (/^https?:\/\/[^\s]+$/i.test(s)) return true;
  return false;
}

/**
 * Extract string-literal candidates from source code content.
 * Matches: single-quoted, double-quoted, and backtick-quoted strings.
 * Returns the string contents (without quotes).
 */
function extractStringLiterals(content: string): string[] {
  const literals: string[] = [];
  // Match '...', "...", `...` — non-greedy, handle escaped quotes
  const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    literals.push(m[2]);
  }
  return literals;
}

/**
 * Detect entropy-based secrets in a file's content.
 * Returns findings for string literals that pass all filters.
 */
function detectEntropySecrets(content: string, filePath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split('\n');
  const literals = extractStringLiterals(content);

  for (const literal of literals) {
    // Filter: length
    if (literal.length < MIN_LENGTH) continue;
    // Filter: false positives
    if (isFalsePositive(literal)) continue;
    // Filter: entropy
    const entropy = shannonEntropy(literal);
    if (entropy < ENTROPY_THRESHOLD) continue;

    // Find which line this literal is on (first occurrence)
    let lineNum = 1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(literal.slice(0, Math.min(literal.length, 40)))) {
        lineNum = i + 1;
        break;
      }
    }

    findings.push({
      file: filePath,
      line: lineNum,
      matchType: 'entropy',
      pattern: 'entropy',
      description: `High-entropy string (entropy=${entropy.toFixed(2)}, len=${literal.length}) — possible secret`,
      preview: literal.slice(0, 30) + (literal.length > 30 ? '...' : ''),
      severity: 'medium',
    });
  }

  return findings;
}

// ── Core: detectSecrets(filePath, content) ──────────────────────────────

/**
 * Detect secrets in a file's content using both known-pattern matching
 * and entropy-based detection.
 *
 * @param filePath Project-relative file path (for the finding's `file` field)
 * @param content The file's text content
 * @returns SecretFinding[] — may be empty
 */
export function detectSecrets(filePath: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split('\n');

  // 1. Known patterns (high severity)
  for (const pattern of KNOWN_PATTERNS) {
    const matched = pattern.match(content);
    if (matched) {
      // Find the line number (first occurrence of the matched string)
      let lineNum = 1;
      const searchStr = matched.slice(0, Math.min(matched.length, 40));
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(searchStr)) {
          lineNum = i + 1;
          break;
        }
      }
      findings.push({
        file: filePath,
        line: lineNum,
        matchType: 'known-pattern',
        pattern: pattern.id,
        description: pattern.description,
        preview: matched.slice(0, 30) + (matched.length > 30 ? '...' : ''),
        severity: 'high',
      });
    }
  }

  // 2. Entropy detection (medium severity)
  // Only run if no known pattern already caught a secret in this file —
  // avoids double-reporting (e.g., a GitHub PAT would be caught by both
  // the known pattern AND entropy). If a known pattern matched, skip entropy.
  if (findings.filter((f) => f.matchType === 'known-pattern').length === 0) {
    findings.push(...detectEntropySecrets(content, filePath));
  }

  return findings;
}

// ── File-tree scanner ───────────────────────────────────────────────────

const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.toml', '.sh', '.bash', '.py', '.go', '.rs', '.java']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tests', 'coverage', '.traces', '.runtime', '.biometric-templates']);

/**
 * Recursively scan a directory for secrets in source files.
 * Excludes node_modules, dist, .git, tests, coverage, .traces, .runtime.
 *
 * Does NOT scan .env files (they're gitignored + contain intentional real
 * secrets — scanning them would flag every legitimate entry).
 */
export function scanCodebaseForSecrets(projectRoot: string, targetDir: 'server' | 'app' | '' = 'server'): SecretFinding[] {
  const scanRoot = targetDir ? join(projectRoot, targetDir) : projectRoot;
  if (!existsSync(scanRoot)) return [];

  const findings: SecretFinding[] = [];

  const scanDir = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        scanDir(fullPath);
      } else if (entry.isFile()) {
        // Skip .env files (per scope guard — they contain intentional secrets)
        if (entry.name.startsWith('.env')) continue;
        const ext = extname(entry.name).toLowerCase();
        if (!SCAN_EXTENSIONS.has(ext)) continue;

        let content: string;
        try {
          content = readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }

        const relPath = relative(projectRoot, fullPath).replace(/\\/g, '/');
        const fileFindings = detectSecrets(relPath, content);
        findings.push(...fileFindings);
      }
    }
  };

  scanDir(scanRoot);
  return findings;
}

// ── Test exports ────────────────────────────────────────────────────────

export const __test__ = {
  detectSecrets,
  scanCodebaseForSecrets,
  shannonEntropy,
  isUuid,
  isHexHash,
  isFalsePositive,
  extractStringLiterals,
  KNOWN_PATTERNS,
  ENTROPY_THRESHOLD,
  MIN_LENGTH,
};
