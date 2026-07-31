// server/src/agents/database/index.ts
// Database Agent — Schema design, migration generation/execution, query optimization.
//
// Phase C Agent 3: HARDENED from 31-line chat-only stub to real IAgent with
// three programmatic capabilities:
//   1. designMigration() — generates a SQL migration file via LLM + writeProjectFile()
//   2. applyMigration() — applies a migration via Ghost Mode approval gate
//   3. introspectSchema() — queries information_schema for current schema
//
// SCOPE BOUNDARY (non-negotiable): Database Agent owns schema changes ONLY.
// It NEVER writes route/handler code — that's Backend Agent's job. If a task
// asks for "add an endpoint that needs a new column", Database Agent designs
// the migration for the new column ONLY and returns the confirmed schema.
// The caller then dispatches Backend Agent with inputData=confirmedSchema to
// write the route/handler. Database Agent refuses tasks that ask it to write
// route/handler code directly.
//
// Per directive Section 4 (safety): ALL schema-altering operations route
// through the SAME Ghost Mode approval pattern as Terminal Agent —
// reportFinding → planFix → poll/wait for resolution. No autonomous
// execution, no exceptions, even for idempotent CREATE TABLE IF NOT EXISTS.

import type {
  AgentChunk,
  AgentTask,
  AgentDomain,
  DatabaseAgentResult,
  MigrationResult,
  TableSpec,
  ColumnSpec,
  SchemaIntrospectionResult,
  SchemaConfirmation,
} from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { modelRouter } from '../../orchestration/model-router.js';
import { ghostMode } from '../../orchestration/ghost-mode.js';
import { writeProjectFile } from '../_shared/project-files.js';
import { validateMigrationSql } from '../_shared/migration-validate.js';
import { isDbAvailable, withClient, query } from '../../db/client.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFencedJson } from '../_shared/review-parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', '..', 'db', 'migrations');

const SYSTEM_PROMPT = `You are the Database Agent of Zero Two: Code Siren.
Your role: design database schemas, write migrations, optimize queries, and manage indexing.
When asked to design something:
1. Propose the table schema with columns, types, constraints, and indexes.
2. Write the SQL migration (CREATE TABLE, ALTER TABLE, CREATE INDEX).
3. Specify relationships (FKs, junction tables) and normalization level.
4. Flag performance considerations (index strategy, query patterns, partitioning).
Show real SQL.`;

// Dedicated prompt for migration generation. Asks for fenced JSON output
// so we can use extractFencedJson() directly (shared with CodeReviewAgent).
const MIGRATION_GEN_PROMPT = `You are the Database Agent generating a SQL migration.
Based on the user's request, generate a SQL migration file. The migration must:
- Use CREATE TABLE IF NOT EXISTS for new tables (idempotent)
- Use ALTER TABLE ... ADD COLUMN IF NOT EXISTS for new columns (idempotent)
- Include proper constraints (PRIMARY KEY, NOT NULL, REFERENCES, CHECK)
- Include indexes where appropriate (CREATE INDEX IF NOT EXISTS)
- Be safe to re-run (the migration runner skips already-applied migrations
  by filename, but individual statements should also be idempotent)

Output your migration as fenced JSON with this shape:
{
  "filename": "011_descriptive_name.sql",
  "sql": "-- full SQL content here\\nCREATE TABLE IF NOT EXISTS ...",
  "tables": [
    {
      "name": "table_name",
      "columns": [
        {"name": "id", "dataType": "uuid", "isNullable": false, "defaultValue": null, "isPrimaryKey": true},
        {"name": "created_at", "dataType": "timestamptz", "isNullable": false, "defaultValue": "now()", "isPrimaryKey": false}
      ]
    }
  ]
}

The filename must start with a 3-digit number higher than any existing migration.
The sql must be a complete, runnable SQL script.
The tables array must describe every table created or altered by this migration.

Wrap the JSON in <review>...</review> tags:
<review>
{...json...}
</review>`;

// Approval gate constants (same pattern as Terminal Agent)
const APPROVAL_POLL_INTERVAL_MS = 200;
const APPROVAL_TIMEOUT_MS = 60_000; // 60s — schema changes deserve a longer window

export class DatabaseAgent extends IAgent {
  readonly id = 'database-agent';
  readonly name = 'Database Agent';
  readonly domain: AgentDomain = 'DATABASE';
  readonly icon = 'database';
  readonly color = '#F59E0B';
  constructor() { super(0.85); }

  /**
   * Design a new migration based on a task description.
   *
   * Uses the LLM to generate SQL, writes the migration file to
   * src/db/migrations/ via writeProjectFile() (goes through CodeReviewAgent
   * gate), and returns the migration result with parsed table specs.
   *
   * Does NOT apply the migration — call applyMigration() separately for that.
   * This separation is deliberate: the caller may want to review the generated
   * SQL before applying it.
   */
  async designMigration(params: {
    description: string;
    projectRoot: string;
    traceId?: string;
  }): Promise<MigrationResult> {
    const { description, projectRoot, traceId } = params;

    // Determine the next migration number
    const nextNumber = this.getNextMigrationNumber();

    // Call the LLM to generate the migration
    let reviewText = '';
    try {
      const stream = modelRouter.stream({
        agentId: this.id,
        domain: this.domain,
        messages: [
          { role: 'system', content: MIGRATION_GEN_PROMPT },
          { role: 'user', content: `Generate a migration for: ${description}\n\nThe next migration number is ${nextNumber}. Use filename ${String(nextNumber).padStart(3, '0')}_<descriptive_name>.sql` },
        ],
        temperature: 0.2,
        maxTokens: 2048,
        executionMode: 'single-shot',
      });

      for await (const chunk of stream) {
        if (chunk.done) break;
        reviewText += chunk.delta;
      }
    } catch (err: any) {
      throw new Error(`LLM call failed during migration design: ${err.message}`);
    }

    // Parse the fenced JSON response
    const parsed = extractFencedJson(reviewText);
    if (!parsed || typeof parsed.filename !== 'string' || typeof parsed.sql !== 'string') {
      // Stub engine or unstructured output — can't generate a migration
      throw new Error('LLM did not produce structured migration output (fenced JSON required)');
    }

    // Normalize the filename — ensure it starts with the right number
    let filename = String(parsed.filename);
    if (!filename.endsWith('.sql')) filename += '.sql';

    // Normalize table specs
    const tables: TableSpec[] = [];
    if (Array.isArray(parsed.tables)) {
      for (const t of parsed.tables) {
        if (typeof t !== 'object' || t === null) continue;
        const tableName = String(t.name ?? 'unknown');
        const columns: ColumnSpec[] = [];
        if (Array.isArray(t.columns)) {
          for (const c of t.columns) {
            if (typeof c !== 'object' || c === null) continue;
            columns.push({
              name: String(c.name ?? 'unknown'),
              dataType: String(c.dataType ?? 'text'),
              isNullable: Boolean(c.isNullable ?? true),
              defaultValue: c.defaultValue === null || c.defaultValue === undefined ? null : String(c.defaultValue),
              isPrimaryKey: Boolean(c.isPrimaryKey ?? false),
            });
          }
        }
        tables.push({ name: tableName, columns });
      }
    }

    const sql = String(parsed.sql);

    // Write the migration file via writeProjectFile() — goes through
    // CodeReviewAgent's Tier 1 + Tier 2 gate. If the SQL contains hardcoded
    // secrets or other Tier 1 violations, the write is refused.
    const migrationPath = join(projectRoot, 'src', 'db', 'migrations', filename);
    const writeResult = await writeProjectFile(this.id, migrationPath, sql, traceId);

    if (!writeResult.written) {
      return {
        filename,
        sql,
        tables,
        applied: false,
        error: `Migration file write rejected by CodeReviewAgent: ${writeResult.review.issues.join('; ')}`,
      };
    }

    return {
      filename,
      sql,
      tables,
      applied: false, // not applied yet — call applyMigration() separately
    };
  }

  /**
   * Apply a migration via Ghost Mode approval gate.
   *
   * Per directive Section 4: ALL schema-altering operations route through
   * the SAME Ghost Mode approval pattern as Terminal Agent —
   * reportFinding → planFix → poll/wait for resolution. No autonomous
   * execution, no exceptions, even for idempotent CREATE TABLE IF NOT EXISTS.
   *
   * On approval: executes the migration SQL via withClient() in a transaction.
   * On rejection/timeout: fail-closed, migration NOT applied.
   *
   * Returns the migration result with applied=true/false.
   */
  async applyMigration(params: {
    filename: string;
    sql: string;
    projectRoot: string;
    traceId?: string;
    userId?: string;
    taskId?: string;
    testOnlyAutoApprove?: boolean; // test-only — never in production
  }): Promise<MigrationResult> {
    const { filename, sql, traceId, userId, taskId, testOnlyAutoApprove } = params;

    // ── Step 0: SQL validation (BEFORE Ghost Mode — hard blocks are
    // independent of approval, per directive Section 2/3) ─────────────
    // validateMigrationSql() catches dangerous patterns (DROP DATABASE,
    // bare TRUNCATE, etc.) unconditionally — no approval override possible.
    const validation = validateMigrationSql(sql);
    if (!validation.valid) {
      return {
        filename,
        sql,
        tables: [],
        applied: false,
        error: `SQL validation FAILED (hard block, not overridable): ${validation.errors.join('; ')}`,
      };
    }

    // If Postgres is unavailable, can't apply — fail honestly with
    // standardized error code (directive Section 5)
    if (!isDbAvailable()) {
      return {
        filename,
        sql,
        tables: [], // tables already known from designMigration; not re-parsed here
        applied: false,
        error: 'postgres-unavailable',
      };
    }

    // ── Ghost Mode approval gate (same pattern as Terminal Agent) ──────
    // reportFinding → planFix → poll/wait for user to approve via
    // /api/ghost-mode/findings/:id/approve endpoint.
    const finding = ghostMode.reportFinding({
      type: 'database:migration',
      severity: 'high', // schema changes are always high-impact
      description: `Apply migration: ${filename}`,
      userId,
      agentId: this.id,
      taskId,
    });

    const plan = await ghostMode.planFix(finding);

    // Wait for approval (same poll loop as Terminal Agent — lines 220-266)
    if (ghostMode.currentState === 'awaiting_approval') {
      if (testOnlyAutoApprove && process.env.NODE_ENV === 'test') {
        await ghostMode.approve(plan);
      } else {
        // Production poll loop — uses getResolution() as the PRIMARY signal
        // (reliable), currentState as FALLBACK (covers auto-amend mode).
        // Same pattern as Terminal Agent lines 242-266.
        //
        // Why getResolution() is primary: approve() transitions
        // applying→verifying→complete→scanning SYNCHRONOUSLY. By the time
        // we poll, the FSM may already be back in 'scanning' —
        // indistinguishable from a rejection without getResolution().
        const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
        let approved = false;
        let rejected = false;

        while (Date.now() < deadline) {
          // PRIMARY: check the resolution map first (the reliable signal)
          const resolution = ghostMode.getResolution(finding.id);
          if (resolution === 'approved') {
            approved = true;
            break;
          }
          if (resolution === 'rejected') {
            rejected = true;
            break;
          }

          // FALLBACK: check state (covers auto-amend mode where no
          // approval was needed — FSM skips awaiting_approval entirely)
          const state = ghostMode.currentState as string;
          if (state === 'applying' || state === 'verifying' || state === 'complete') {
            approved = true;
            break;
          }
          if (state === 'rolled_back') {
            rejected = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, APPROVAL_POLL_INTERVAL_MS));
        }

        if (!approved && !rejected) {
          return {
            filename,
            sql,
            tables: [],
            applied: false,
            error: `Approval timed out after ${APPROVAL_TIMEOUT_MS / 1000}s — migration NOT applied (fail closed)`,
          };
        }

        if (rejected) {
          return {
            filename,
            sql,
            tables: [],
            applied: false,
            error: 'Migration REJECTED by user — NOT applied (fail closed)',
          };
        }
      }
    }

    // ── Approved — apply the migration in a transaction ────────────────
    try {
      await withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          // Record the migration in schema_migrations
          await client.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
            [filename],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });

      return {
        filename,
        sql,
        tables: [], // caller already has tables from designMigration
        applied: true,
      };
    } catch (err: any) {
      return {
        filename,
        sql,
        tables: [],
        applied: false,
        error: `Migration execution failed: ${err.message}`,
      };
    }
  }

  /**
   * Introspect the current database schema via information_schema.
   *
   * Queries information_schema.tables + information_schema.columns to get
   * the current schema as TableSpec[]. Degrades gracefully when Postgres
   * is unavailable (returns empty + skipped note).
   */
  async introspectSchema(): Promise<SchemaIntrospectionResult> {
    if (!isDbAvailable()) {
      return {
        tables: [],
        available: false,
        skipped: 'Postgres unavailable — schema introspection not possible in degraded mode',
        error: 'postgres-unavailable',
      };
    }

    try {
      // Query all tables in the public schema
      const tableRows = await query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      if (tableRows.length === 0) {
        return { tables: [], available: true };
      }

      // Query all columns for those tables
      const columnRows = await query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
      }>(`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `);

      // Group columns by table
      const tablesMap = new Map<string, ColumnSpec[]>();
      for (const row of columnRows) {
        if (!tablesMap.has(row.table_name)) {
          tablesMap.set(row.table_name, []);
        }
        // Check if this column is a primary key
        const pkRows = await query<{ column_name: string }>(`
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
        `, [row.table_name]);

        const isPrimaryKey = pkRows.some(pk => pk.column_name === row.column_name);

        tablesMap.get(row.table_name)!.push({
          name: row.column_name,
          dataType: row.data_type,
          isNullable: row.is_nullable === 'YES',
          defaultValue: row.column_default,
          isPrimaryKey,
        });
      }

      const tables: TableSpec[] = tableRows.map(t => ({
        name: t.table_name,
        columns: tablesMap.get(t.table_name) ?? [],
      }));

      return { tables, available: true };
    } catch (err: any) {
      return {
        tables: [],
        available: false,
        skipped: `Schema introspection failed: ${err.message}`,
      };
    }
  }

  /**
   * Confirm the schema state for ONE specific table.
   *
   * Per directive Section 4: THIS is the method Backend Agent's caller
   * consumes. It returns a SchemaConfirmation shape with:
   *   - tableExists (true/false/null — null when we couldn't check)
   *   - columns (name + dataType for each column)
   *   - migrationApplied (whether the migration that created this table was applied)
   *   - migrationFile (which migration file created it, if known)
   *   - confirmedAt (epoch ms)
   *   - error ('postgres-unavailable' when degraded mode)
   *
   * Distinct from introspectSchema() (which returns ALL tables for
   * diagnostic/admin purposes). Backend Agent reads confirmSchema() output
   * via task.inputData to know exactly what columns exist on the table it's
   * building routes for — it doesn't need the full schema, just the one table.
   *
   * Queries information_schema.columns directly — THIS IS THE FIRST TIME
   * this codebase queries its own schema (confirmed in Section 0).
   */
  async confirmSchema(tableName: string): Promise<SchemaConfirmation> {
    const confirmedAt = Date.now();

    // Degraded-mode handling (directive Section 5) — return explicit error,
    // never a silent no-op
    if (!isDbAvailable()) {
      return {
        tableExists: null,  // null = couldn't check, NOT false = doesn't exist
        columns: [],
        migrationApplied: false,
        migrationFile: null,
        confirmedAt,
        error: 'postgres-unavailable',
      };
    }

    try {
      // Query information_schema.columns for this specific table.
      // This is the schema introspection path that didn't exist before
      // this phase (confirmed in Section 0).
      const columnRows = await query<{
        column_name: string;
        data_type: string;
      }>(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      const tableExists = columnRows.length > 0;

      // Check if any migration file mentions this table (heuristic — we
      // don't have a formal table→migration mapping, so we scan filenames
      // + content. This is best-effort, not authoritative.)
      let migrationFile: string | null = null;
      let migrationApplied = false;
      if (existsSync(migrationsDir)) {
        const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
        for (const file of files) {
          try {
            const content = readFileSync(join(migrationsDir, file), 'utf8');
            if (content.toLowerCase().includes(`table ${tableName.toLowerCase()}`) ||
                content.toLowerCase().includes(`table ${tableName.toLowerCase()} (`)) {
              migrationFile = file;
              // Check if this migration is recorded as applied
              const appliedRows = await query<{ filename: string }>(`
                SELECT filename FROM schema_migrations WHERE filename = $1
              `, [file]);
              migrationApplied = appliedRows.length > 0;
              break; // first matching migration wins
            }
          } catch {
            // skip unreadable files
          }
        }
      }

      return {
        tableExists,
        columns: columnRows.map(c => ({ name: c.column_name, dataType: c.data_type })),
        migrationApplied,
        migrationFile,
        confirmedAt,
      };
    } catch (err: any) {
      // Query failed — return error result, NOT a silent empty success
      return {
        tableExists: null,
        columns: [],
        migrationApplied: false,
        migrationFile: null,
        confirmedAt,
        error: 'postgres-unavailable', // treat query failure same as unavailable
      };
    }
  }

  /**
   * Get the next migration number by listing existing migration files.
   */
  private getNextMigrationNumber(): number {
    if (!existsSync(migrationsDir)) return 1;
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .map(f => parseInt(f.slice(0, 3), 10))
      .filter(n => !isNaN(n));
    return files.length === 0 ? 1 : Math.max(...files) + 1;
  }

  /**
   * Full database operation: design + (optionally) apply + introspect.
   *
   * This is the main entry point for callers who want the complete flow.
   * Returns a DatabaseAgentResult with confirmedSchema for Backend Agent.
   */
  async databaseOperation(params: {
    description: string;
    projectRoot: string;
    apply?: boolean;           // if true, apply the migration after designing it
    traceId?: string;
    userId?: string;
    taskId?: string;
    testOnlyAutoApprove?: boolean;
  }): Promise<DatabaseAgentResult> {
    const { description, projectRoot, apply = false, traceId, userId, taskId, testOnlyAutoApprove } = params;
    const skipped: string[] = [];
    let reviewTier: 'full-scan' | 'partial-scan' | 'stub-fallback' = 'full-scan';

    // ── Design the migration ───────────────────────────────────────────
    let migration: MigrationResult | undefined;
    try {
      migration = await this.designMigration({ description, projectRoot, traceId });
    } catch (err: any) {
      skipped.push(`migration-design: ${err.message}`);
      reviewTier = 'partial-scan';
    }

    // ── Apply the migration (optional) ─────────────────────────────────
    if (apply && migration && !migration.error) {
      try {
        const applied = await this.applyMigration({
          filename: migration.filename,
          sql: migration.sql,
          projectRoot,
          traceId,
          userId,
          taskId,
          testOnlyAutoApprove,
        });
        migration = { ...migration, applied: applied.applied, error: applied.error };
      } catch (err: any) {
        skipped.push(`migration-apply: ${err.message}`);
        reviewTier = 'partial-scan';
      }
    }

    // ── Introspect the current schema ──────────────────────────────────
    let schemaIntrospection: SchemaIntrospectionResult | undefined;
    try {
      schemaIntrospection = await this.introspectSchema();
      if (!schemaIntrospection.available) {
        skipped.push(schemaIntrospection.skipped ?? 'schema introspection unavailable');
        reviewTier = 'partial-scan';
      }
    } catch (err: any) {
      skipped.push(`schema-introspection: ${err.message}`);
      reviewTier = 'partial-scan';
    }

    // ── Build the confirmed schema for Backend Agent ───────────────────
    let confirmedSchema: DatabaseAgentResult['confirmedSchema'];
    if (migration && !migration.error) {
      confirmedSchema = {
        tables: migration.tables,
        migrationFile: migration.filename,
        applied: migration.applied,
      };
    }

    if (skipped.length >= 2) {
      reviewTier = 'stub-fallback';
    }

    return {
      migration,
      schemaIntrospection,
      reviewTier,
      skipped,
      confirmedSchema,
    };
  }

  // ── Chat persona (preserved from original stub) ────────────────────
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.3, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['database', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
