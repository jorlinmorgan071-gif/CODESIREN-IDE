// server/src/agents/_shared/migration-validate.ts
// SQL validation for migration files — parallel to (not reusing) the shell-
// command validation in Terminal Agent. This is SQL text, not a shell command.
//
// Per directive Section 2: hard-blocks dangerous patterns UNCONDITIONALLY
// (no approval override possible). These blocks happen BEFORE Ghost Mode is
// even involved — they're independent of the approval gate.
//
// Rules:
//   1. Hard-block DROP DATABASE (always — no IF EXISTS override possible)
//   2. Hard-block DROP TABLE without IF EXISTS (destructive, irreversible)
//   3. Hard-block bare TRUNCATE unless an explicit marker comment is present
//      (marker: -- ALLOW_TRUNCATE on its own line, immediately before the TRUNCATE)
//   4. Require ALTER TABLE ADD COLUMN to use IF NOT EXISTS
//   5. Require ALTER TABLE DROP COLUMN to use IF EXISTS
//
// Every blocked pattern has a REJECTS test + every allowed pattern has a
// false-positive test in tests/security/migration-validate.test.ts.

export interface ValidationResult {
  valid: boolean;
  errors: string[];   // blocking errors — migration refused if non-empty
  warnings: string[]; // non-blocking warnings — migration proceeds but logged
}

/**
 * The marker comment that allows bare TRUNCATE.
 * Must appear on its own line immediately before the TRUNCATE statement.
 * This forces the migration author to explicitly acknowledge the destructive
 * operation rather than burying it in a long SQL script.
 */
export const TRUNCATE_MARKER = '-- ALLOW_TRUNCATE';

/**
 * Validate a SQL migration script before it reaches the Ghost Mode approval gate.
 *
 * This is a HARD block — if any error is returned, the migration is refused
 * regardless of user approval. The approval gate is for "should we apply this
 * schema change?" — validation is for "is this SQL safe to even propose?".
 *
 * @param sql The full SQL content of the migration file
 * @returns ValidationResult with valid=false if any hard-block pattern matches
 */
export function validateMigrationSql(sql: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Strip SQL comments (-- to end of line) for pattern matching, so that
  // comments mentioning "DROP DATABASE" don't false-positive. Keep the
  // original SQL for the TRUNCATE marker check (which IS comment-based).
  const sqlNoComments = sql.replace(/--[^\n]*/g, '');

  // ── Rule 1: Hard-block DROP DATABASE (always, no exceptions) ────────
  // DROP DATABASE is catastrophic and irreversible. Even with IF EXISTS,
  // it destroys an entire database. Migrations should NEVER drop databases.
  if (/\bDROP\s+DATABASE\b/i.test(sqlNoComments)) {
    errors.push('[BLOCKED] DROP DATABASE is unconditionally forbidden in migrations — it destroys entire databases');
  }

  // ── Rule 2: Hard-block DROP TABLE without IF EXISTS ─────────────────
  // DROP TABLE is destructive. With IF EXISTS it's safe (no-op if table
  // doesn't exist). Without IF EXISTS, it errors if the table is missing
  // AND is more likely to be an accidental/typo drop.
  // Match: DROP TABLE <name> ; (no IF EXISTS between TABLE and the name/semicolon)
  const dropTableMatches = sqlNoComments.match(/\bDROP\s+TABLE\b[^;]*;/gi) ?? [];
  for (const match of dropTableMatches) {
    if (!/\bIF\s+EXISTS\b/i.test(match)) {
      errors.push(`[BLOCKED] DROP TABLE without IF EXISTS is forbidden — use "DROP TABLE IF EXISTS <name>" instead. Found: ${match.trim().slice(0, 80)}`);
    }
  }

  // ── Rule 3: Hard-block bare TRUNCATE unless marker comment present ──
  // TRUNCATE wipes all rows from a table. It's sometimes legitimate (test
  // fixtures, reset scripts) but should never appear without explicit
  // acknowledgment. The marker -- ALLOW_TRUNCATE must be on its own line
  // immediately before the TRUNCATE statement.
  //
  // Use the ORIGINAL sql (with comments) for this check, since the marker
  // IS a comment.
  const truncateMatches = sql.match(/\bTRUNCATE\b[^;]*;/gi) ?? [];
  for (const match of truncateMatches) {
    // Find the position of this TRUNCATE in the original SQL
    const truncateIdx = sql.indexOf(match);
    // Look at the line immediately before this TRUNCATE.
    // beforeTruncate is everything before the TRUNCATE statement.
    // The preceding line is the text between the last newline in
    // beforeTruncate and the end of beforeTruncate.
    const beforeTruncate = sql.slice(0, truncateIdx);
    const lastNewline = beforeTruncate.lastIndexOf('\n');
    // precedingLine = text AFTER the last newline (the line the TRUNCATE
    // starts on, minus the TRUNCATE itself) — but we want the line BEFORE
    // that. So: if there are multiple newlines, the preceding line is
    // between the second-to-last newline and the last newline. If there's
    // only one newline, the preceding line is from start to that newline.
    let precedingLine: string;
    if (lastNewline === -1) {
      // No newline before TRUNCATE — it's on the first line, no preceding line
      precedingLine = '';
    } else {
      // Find the second-to-last newline (start of the preceding line)
      const secondLastNewline = beforeTruncate.lastIndexOf('\n', lastNewline - 1);
      if (secondLastNewline === -1) {
        // Only one newline — preceding line is from start to that newline
        precedingLine = beforeTruncate.slice(0, lastNewline).trim();
      } else {
        // Preceding line is between secondLastNewline and lastNewline
        precedingLine = beforeTruncate.slice(secondLastNewline + 1, lastNewline).trim();
      }
    }

    if (precedingLine !== TRUNCATE_MARKER) {
      errors.push(
        `[BLOCKED] TRUNCATE without explicit marker — bare TRUNCATE is forbidden. ` +
        `Add "${TRUNCATE_MARKER}" on its own line immediately before the TRUNCATE statement. ` +
        `Found: ${match.trim().slice(0, 80)}`
      );
    }
  }

  // ── Rule 4: Require ALTER TABLE ADD COLUMN to use IF NOT EXISTS ─────
  // Without IF NOT EXISTS, re-running the migration errors on the duplicate
  // column. Since migrations should be idempotent (re-runnable), ADD COLUMN
  // must use IF NOT EXISTS.
  //
  // Match: ALTER TABLE <name> ADD [COLUMN] <colname> <type> ...
  // The regex needs to handle both "ADD COLUMN col" and "ADD col" forms.
  // Key: after ADD (and optional COLUMN), if IF NOT EXISTS doesn't appear
  // before the column name, it's a violation.
  //
  // Strategy: find all "ALTER TABLE ... ADD ..." statements, then for each,
  // check if IF NOT EXISTS appears between ADD and the column name.
  const alterAddMatches = sqlNoComments.match(/\bALTER\s+TABLE\b[^;]*\bADD\b[^;]*;/gi) ?? [];
  for (const match of alterAddMatches) {
    // Extract the part after ADD
    const addIdx = match.toUpperCase().indexOf('ADD');
    if (addIdx === -1) continue;
    const afterAdd = match.slice(addIdx);

    // If IF NOT EXISTS appears anywhere in the ADD clause, it's safe
    if (!/\bIF\s+NOT\s+EXISTS\b/i.test(afterAdd)) {
      // But only flag if this is actually adding a column (not a constraint)
      // Check if the next token after ADD (or ADD COLUMN) looks like a column def
      // Skip "ADD COLUMN" or just "ADD", then check what follows
      const afterAddNormalized = afterAdd.replace(/^\s*ADD\s+/i, '').replace(/^COLUMN\s+/i, '');
      // If it starts with a constraint keyword, it's not a column add
      if (!/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX)\b/i.test(afterAddNormalized)) {
        errors.push(
          `[BLOCKED] ALTER TABLE ADD COLUMN without IF NOT EXISTS is forbidden — migrations must be idempotent. ` +
          `Use "ALTER TABLE <name> ADD COLUMN IF NOT EXISTS <col> ..." instead. Found: ${match.trim().slice(0, 80)}`
        );
      }
    }
  }

  // ── Rule 5: Require ALTER TABLE DROP COLUMN to use IF EXISTS ────────
  // Without IF EXISTS, re-running the migration errors if the column was
  // already dropped. Same idempotency reasoning as Rule 4.
  const dropColumnMatches = sqlNoComments.match(/\bALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b[^;]*;/gi) ?? [];
  for (const match of dropColumnMatches) {
    if (!/\bIF\s+EXISTS\b/i.test(match)) {
      errors.push(
        `[BLOCKED] ALTER TABLE DROP COLUMN without IF EXISTS is forbidden — migrations must be idempotent. ` +
        `Use "ALTER TABLE <name> DROP COLUMN IF EXISTS <col>" instead. Found: ${match.trim().slice(0, 80)}`
      );
    }
  }

  // ── Non-blocking warnings ───────────────────────────────────────────
  // These don't block the migration but are surfaced for reviewer attention.
  // Check for DELETE FROM without WHERE (simple heuristic — look at each statement)
  const deleteMatches = sqlNoComments.match(/\bDELETE\s+FROM\b[^;]*;/gi) ?? [];
  for (const match of deleteMatches) {
    if (!/\bWHERE\b/i.test(match)) {
      warnings.push(`[WARNING] DELETE FROM without WHERE clause — this deletes all rows. Found: ${match.trim().slice(0, 80)}`);
    }
  }
  const updateMatches = sqlNoComments.match(/\bUPDATE\b[^;]*\bSET\b[^;]*;/gi) ?? [];
  for (const match of updateMatches) {
    if (!/\bWHERE\b/i.test(match)) {
      warnings.push(`[WARNING] UPDATE without WHERE clause — this updates all rows. Found: ${match.trim().slice(0, 80)}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
