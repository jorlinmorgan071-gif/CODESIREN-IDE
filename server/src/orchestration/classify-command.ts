// server/src/orchestration/classify-command.ts
// Phase A Section 2: deterministic command classification for instant previews.
//
// A ~25-entry lookup table of common command patterns → human-readable
// explanations. Checked against validateShellCommand() FIRST (blocked commands
// get the blocklist reason as their explanation). Unrecognized commands get
// the honest fallback: "Custom command — review before executing."
//
// This is NOT a replacement for the LLM-generated explanation — it's an
// instant deterministic preview shown in the approval dialog alongside
// (not instead of) the LLM's richer explanation. The two complement each
// other: instant preview + richer LLM explanation.

import { validateShellCommand } from '../security/sandbox.js';

export interface CommandClassification {
  /** The command that was classified. */
  command: string;
  /** Human-readable explanation of what the command will do. */
  explanation: string;
  /** Whether the command was blocked by the sandbox blocklist. */
  blocked: boolean;
  /** Blocklist reason (set when blocked=true). */
  blockReason?: string;
  /** Whether the command matched a known pattern in the lookup table. */
  matched: boolean;
  /** Risk level for UI styling. */
  risk: 'safe' | 'moderate' | 'dangerous' | 'blocked';
}

// ── Lookup table ────────────────────────────────────────────────────────
//
// Each entry is a regex + explanation. The regex is matched against the
// trimmed command. Explanations are concise (one sentence) — the LLM
// provides the longer "why" in the agent chat.
//
// Order matters: more specific patterns first (e.g. `npm install <pkg>`
// before `npm install`).

interface CommandPattern {
  pattern: RegExp;
  explanation: string;
  risk: CommandClassification['risk'];
}

const COMMAND_PATTERNS: CommandPattern[] = [
  // ── npm ──────────────────────────────────────────────────────────────
  // IMPORTANT: --save-dev pattern must come BEFORE the bare `npm install <pkg>`
  // pattern, because `npm install jest --save-dev` would otherwise match the
  // bare pattern first (capturing "jest" + ignoring the --save-dev flag).
  {
    pattern: /^npm\s+install\s+(\S+)\s+--save-dev/,
    explanation: 'Adds the package to devDependencies in package.json + installs it into node_modules/',
    risk: 'moderate',
  },
  {
    pattern: /^npm\s+install\s+--save-dev\s+(\S+)/,
    explanation: 'Adds the package to devDependencies in package.json + installs it into node_modules/',
    risk: 'moderate',
  },
  {
    pattern: /^npm\s+install\s+(\S+)/,
    explanation: 'Adds the package to dependencies in package.json + installs it into node_modules/',
    risk: 'moderate',
  },
  {
    pattern: /^npm\s+install$/,
    explanation: 'Installs all dependencies from package.json into node_modules/',
    risk: 'safe',
  },
  {
    pattern: /^npm\s+ci$/,
    explanation: 'Clean-installs dependencies from package-lock.json (faster + stricter than npm install)',
    risk: 'safe',
  },
  {
    pattern: /^npm\s+audit\s+fix$/,
    explanation: 'Applies in-range security fixes to package-lock.json + node_modules/ (non-breaking)',
    risk: 'moderate',
  },
  {
    pattern: /^npm\s+audit$/,
    explanation: 'Checks for known vulnerabilities in installed dependencies',
    risk: 'safe',
  },
  {
    pattern: /^npm\s+test$/,
    explanation: 'Runs the test script defined in package.json',
    risk: 'safe',
  },
  {
    pattern: /^npm\s+run\s+(\S+)/,
    explanation: 'Runs the named script defined in package.json',
    risk: 'safe',
  },
  {
    pattern: /^npm\s+ls(?:\s+(\S+))?/,
    explanation: 'Lists installed packages (optionally filtered to the named package)',
    risk: 'safe',
  },
  {
    pattern: /^npm\s+outdated$/,
    explanation: 'Checks for outdated dependencies (does not modify anything)',
    risk: 'safe',
  },
  // ── git ──────────────────────────────────────────────────────────────
  {
    pattern: /^git\s+status$/,
    explanation: 'Shows working tree status — untracked/modified/staged files',
    risk: 'safe',
  },
  {
    pattern: /^git\s+add\s+(.+)/,
    explanation: 'Stages the named file(s) for commit',
    risk: 'safe',
  },
  {
    pattern: /^git\s+commit\s+-m\s+"(.+)"/,
    explanation: 'Creates a commit with the given message',
    risk: 'moderate',
  },
  {
    pattern: /^git\s+push$/,
    explanation: 'Pushes local commits to the remote repository',
    risk: 'moderate',
  },
  {
    pattern: /^git\s+pull$/,
    explanation: 'Fetches + merges remote changes into the current branch',
    risk: 'moderate',
  },
  {
    pattern: /^git\s+diff(?:\s+(.+))?/,
    explanation: 'Shows unstaged changes (optionally for the named file)',
    risk: 'safe',
  },
  {
    pattern: /^git\s+log(?:\s+.*)?$/,
    explanation: 'Shows commit history',
    risk: 'safe',
  },
  // ── file system ──────────────────────────────────────────────────────
  {
    pattern: /^ls(?:\s+-[la]+)?(?:\s+(.+))?$/,
    explanation: 'Lists directory contents (optionally with details)',
    risk: 'safe',
  },
  {
    pattern: /^cat\s+(.+)/,
    explanation: 'Prints the named file contents to stdout',
    risk: 'safe',
  },
  {
    pattern: /^mkdir\s+(?:-p\s+)?(.+)/,
    explanation: 'Creates the named directory (optionally with parent dirs)',
    risk: 'safe',
  },
  {
    pattern: /^rm\s+(?:-[rf]+\s+)?(.+)/,
    explanation: 'Deletes the named file(s)/directory(s) — permanent, not trash',
    risk: 'dangerous',
  },
  {
    pattern: /^cp\s+(\S+)\s+(\S+)/,
    explanation: 'Copies the source file to the destination',
    risk: 'moderate',
  },
  {
    pattern: /^mv\s+(\S+)\s+(\S+)/,
    explanation: 'Moves/renames the source file to the destination',
    risk: 'moderate',
  },
  {
    pattern: /^touch\s+(.+)/,
    explanation: 'Creates an empty file (or updates its timestamp)',
    risk: 'safe',
  },
  {
    pattern: /^echo\s+(.+)/,
    explanation: 'Prints the given text to stdout',
    risk: 'safe',
  },
  {
    pattern: /^pwd$/,
    explanation: 'Prints the current working directory',
    risk: 'safe',
  },
  {
    pattern: /^cd\s+(.+)/,
    explanation: 'Changes working directory (no-op in execSync — each command runs independently)',
    risk: 'safe',
  },
  {
    pattern: /^chmod\s+(\S+)\s+(.+)/,
    explanation: 'Changes file permissions on the named file(s)',
    risk: 'moderate',
  },
  // ── network ──────────────────────────────────────────────────────────
  {
    pattern: /^curl\s+(.+)/,
    explanation: 'Fetches a URL — downloads content to stdout or a file',
    risk: 'moderate',
  },
  {
    pattern: /^wget\s+(.+)/,
    explanation: 'Downloads a file from a URL',
    risk: 'moderate',
  },
];

/**
 * Classify a shell command for instant preview.
 *
 * 1. Checks validateShellCommand() first — blocked commands get the blocklist
 *    reason as their explanation + risk='blocked'.
 * 2. Matches against the lookup table — matched commands get the pattern's
 *    explanation + risk.
 * 3. Unrecognized commands get the honest fallback: "Custom command — review
 *    before executing" + risk='moderate'. No fabricated explanations.
 */
export function classifyCommand(command: string): CommandClassification {
  // 1. Blocklist check first
  const validation = validateShellCommand(command);
  if (!validation.allowed) {
    return {
      command,
      explanation: `BLOCKED: ${validation.reason}`,
      blocked: true,
      blockReason: validation.reason,
      matched: false,
      risk: 'blocked',
    };
  }

  // 2. Lookup table
  const trimmed = command.trim();
  for (const { pattern, explanation, risk } of COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        command,
        explanation,
        blocked: false,
        matched: true,
        risk,
      };
    }
  }

  // 3. Honest fallback
  return {
    command,
    explanation: 'Custom command — review before executing',
    blocked: false,
    matched: false,
    risk: 'moderate',
  };
}

// ── Test exports ────────────────────────────────────────────────────────

export const __test__ = {
  classifyCommand,
  COMMAND_PATTERNS,
};
