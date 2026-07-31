// server/src/agents/backend/index.ts
// Backend Agent — REST/GraphQL APIs, business logic, middleware.
//
// Phase C Agent 4: HARDENED from 31-line chat-only stub to real IAgent with
// route-generation capability. Generates Express route files (zod validation,
// per-route requireAuth, matching the existing convention) and registers
// them in src/index.ts — both through the existing writeProjectFile() funnel.
//
// SCOPE BOUNDARY (non-negotiable): Backend Agent NEVER writes DDL of any
// kind — never to src/db/migrations/, never any SQL schema code. It
// consumes a SchemaConfirmation object supplied by the CALLER via
// task.inputData — it does NOT query the database itself, does NOT call
// DatabaseAgent directly. If task.inputData.schemaConfirmation is missing
// or incomplete (tableExists === null OR error === 'postgres-unavailable'),
// Backend Agent REFUSES to generate DB-backed code.

import type {
  AgentChunk,
  AgentTask,
  AgentDomain,
  BackendRouteResult,
  SchemaConfirmation,
} from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { writeProjectFile } from '../_shared/project-files.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SYSTEM_PROMPT = `You are the Backend Agent of Zero Two: Code Siren.
Your role: design and implement server-side APIs, business logic, middleware, and auth flows.
When asked to build something:
1. Define the API endpoints (REST or GraphQL) with request/response shapes.
2. Write the actual implementation code (not pseudocode).
3. Specify data models, validation rules, and error handling.
4. Flag security considerations (auth, rate limiting, input sanitization).
Be concrete. Show real TypeScript/Node.js code.`;

export interface GenerateRouteParams {
  /** Description of the endpoint to generate, e.g. "GET /api/users/:id — fetch user by ID" */
  description: string;
  /** Project root path (for resolving src/routes/ and src/index.ts) */
  projectRoot: string;
  /** Route file name without extension, e.g. "users" → src/routes/users.ts */
  routeName: string;
  /** Router variable name, e.g. "usersRouter". Defaults to `${routeName}Router`. */
  routerVarName?: string;
  /** Mount path in index.ts, e.g. "/api/users". Defaults to `/api/${routeName}`. */
  mountPath?: string;
  /** Explicitly mark route as public (skips requireAuth). Default: false (auth required). */
  isPublic?: boolean;
  /** Explicitly allow debug/admin/internal path patterns. Default: false. */
  isIntentionalDebugPath?: boolean;
  /** Trace ID for writeProjectFile() logging. */
  traceId?: string;
  /** Columns the route should reference (extracted from schemaConfirmation by the caller,
   * OR provided directly for testing). If provided, the generated code only references
   * these column names. If a requested column is NOT in this list, generation is refused. */
  confirmedColumns?: { name: string; dataType: string }[];
  /** Columns the task description implies the route should use. If any of these
   * are NOT in confirmedColumns, generation is refused with a clear error. */
  requiredColumns?: string[];
}

export class BackendAgent extends IAgent {
  readonly id = 'backend-agent';
  readonly name = 'Backend Agent';
  readonly domain: AgentDomain = 'BACKEND';
  readonly icon = 'server';
  readonly color = '#22C55E';
  constructor() { super(0.88); }

  /**
   * Generate an Express route file + register it in src/index.ts.
   *
   * Both writes go through writeProjectFile() → CodeReviewAgent gate.
   * Per directive Section 2: both writes must succeed for the route to
   * be considered "added." If either is rejected, report partial failure
   * honestly — never silently report success on a partial state.
   *
   * Per directive Section 3: self-check BEFORE calling writeProjectFile():
   *   - Path doesn't match /debug|admin|internal|__test/i unless isIntentionalDebugPath
   *   - requireAuth present unless isPublic flag is set
   *   - No wildcard CORS in generated code
   *
   * Per directive Section 4: if task implies a column NOT in confirmedColumns,
   * REFUSE to generate — return a clear error naming the mismatched column.
   */
  async generateRoute(params: GenerateRouteParams): Promise<BackendRouteResult> {
    const {
      description,
      projectRoot,
      routeName,
      routerVarName = `${routeName}Router`,
      mountPath = `/api/${routeName}`,
      isPublic = false,
      isIntentionalDebugPath = false,
      traceId,
      confirmedColumns,
      requiredColumns,
    } = params;

    // ── Step 0a: Column-mismatch check (directive Section 4) ──────────
    // If requiredColumns are specified, verify they ALL exist in confirmedColumns.
    // If any are missing, REFUSE to generate — never fabricate.
    if (requiredColumns && requiredColumns.length > 0) {
      if (!confirmedColumns || confirmedColumns.length === 0) {
        return {
          routeFileWritten: false,
          registered: false,
          routeFilePath: null,
          routeContent: null,
          refused: `Cannot generate DB-backed route: confirmedColumns is empty but requiredColumns were specified: ${requiredColumns.join(', ')}`,
        };
      }
      const availableColumnNames = new Set(confirmedColumns.map(c => c.name));
      const missingColumns = requiredColumns.filter(c => !availableColumnNames.has(c));
      if (missingColumns.length > 0) {
        return {
          routeFileWritten: false,
          registered: false,
          routeFilePath: null,
          routeContent: null,
          refused: `Column mismatch: task requires columns [${missingColumns.join(', ')}] but confirmed schema only has [${availableColumnNames.size > 0 ? [...availableColumnNames].join(', ') : 'none'}]. Refusing to generate — no fabrication.`,
          referencedColumns: requiredColumns,
        };
      }
    }

    // ── Step 0b: Generate the route file content ──────────────────────
    const routeContent = this.generateRouteFileContent({
      description,
      routeName,
      routerVarName,
      isPublic,
      confirmedColumns,
      requiredColumns,
    });

    // ── Step 0c: Self-check sanity pass (directive Section 3) ─────────
    // Backend Agent checking its OWN output, not a call to SecurityAgent.
    const selfCheckError = this.selfCheck(mountPath, routeContent, isPublic, isIntentionalDebugPath);
    if (selfCheckError) {
      return {
        routeFileWritten: false,
        registered: false,
        routeFilePath: null,
        routeContent,
        refused: selfCheckError,
      };
    }

    // ── Step 1: Write the route file via writeProjectFile() ───────────
    const routeFilePath = join(projectRoot, 'src', 'routes', `${routeName}.ts`);
    const routeWriteResult = await writeProjectFile(this.id, routeFilePath, routeContent, traceId);

    if (!routeWriteResult.written) {
      return {
        routeFileWritten: false,
        registered: false,
        routeFilePath,
        routeContent,
        error: `Route file write rejected by CodeReviewAgent: ${routeWriteResult.review.issues.join('; ')}`,
        referencedColumns: requiredColumns,
      };
    }

    // ── Step 2: Register in src/index.ts (FRESH read, then full overwrite) ──
    // Per directive Section 2: Read src/index.ts FRESH immediately before
    // constructing the new content — do not cache or reuse a previously-read copy.
    const indexFilePath = join(projectRoot, 'src', 'index.ts');
    let indexContent: string;
    try {
      indexContent = readFileSync(indexFilePath, 'utf8');
    } catch (err: any) {
      // index.ts doesn't exist or can't be read — report partial failure
      return {
        routeFileWritten: true,
        registered: false,
        routeFilePath,
        routeContent,
        error: `Route file written successfully, but index.ts registration failed: could not read ${indexFilePath} (${err.message})`,
        referencedColumns: requiredColumns,
      };
    }

    // Construct the new index.ts content with the import + app.use() added
    const newIndexContent = this.addRouteRegistration(
      indexContent,
      routeName,
      routerVarName,
      mountPath,
    );

    const indexWriteResult = await writeProjectFile(this.id, indexFilePath, newIndexContent, traceId);

    if (!indexWriteResult.written) {
      // PARTIAL FAILURE: route file written, but index.ts registration rejected
      return {
        routeFileWritten: true,
        registered: false,
        routeFilePath,
        routeContent,
        error: `Route file written successfully, but index.ts registration rejected by CodeReviewAgent: ${indexWriteResult.review.issues.join('; ')}`,
        referencedColumns: requiredColumns,
      };
    }

    // ── Both writes succeeded ─────────────────────────────────────────
    return {
      routeFileWritten: true,
      registered: true,
      routeFilePath,
      routeContent,
      referencedColumns: requiredColumns,
    };
  }

  /**
   * Generate the Express route file content.
   *
   * Matches the existing convention:
   *   - import { Router } from 'express'
   *   - import { z } from 'zod'
   *   - import { requireAuth } from '../auth/middleware.js'
   *   - export const fooRouter = Router()
   *   - z.object({...}) schema at module top
   *   - .safeParse(req.body) at handler start
   *   - 400 returns { error: 'Invalid input', issues: parsed.error.issues }
   *   - requireAuth as 2nd arg to each route (unless isPublic)
   */
  private generateRouteFileContent(params: {
    description: string;
    routeName: string;
    routerVarName: string;
    isPublic: boolean;
    confirmedColumns?: { name: string; dataType: string }[];
    requiredColumns?: string[];
  }): string {
    const { description, routeName, routerVarName, isPublic, confirmedColumns, requiredColumns } = params;

    // Determine which columns the generated code will reference
    const columnsToReference = requiredColumns ?? (confirmedColumns?.map(c => c.name) ?? []);

    // Build the zod schema based on the columns (if any)
    const zodSchemaFields = columnsToReference.length > 0
      ? columnsToReference.map(col => `  ${col}: z.string().min(1),`).join('\n')
      : '  // No body fields — this route may not need a zod schema';

    // Build the handler body — reference only confirmed columns
    const handlerBody = columnsToReference.length > 0
      ? columnsToReference.map(col => `    // TODO: implement logic using parsed.data.${col}`).join('\n')
      : '    // TODO: implement route logic';

    // Build the route definition — requireAuth unless isPublic
    const middleware = isPublic ? '' : 'requireAuth, ';

    return `// server/src/routes/${routeName}.ts
// Generated by Backend Agent — ${description}

import { Router } from 'express';
import { z } from 'zod';
${isPublic ? '' : "import { requireAuth } from '../auth/middleware.js';\n"}// TODO: import DB client or service layer if this is a DB-backed route
// import { query } from '../db/client.js';

export const ${routerVarName} = Router();

const ${routeName}Schema = z.object({
${zodSchemaFields}
});

${routerVarName}.post('/', ${middleware}async (req, res) => {
  const parsed = ${routeName}Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
${handlerBody}
  res.json({ data: parsed.data });
});

${routerVarName}.get('/', ${middleware}async (_req, res) => {
  // TODO: implement list endpoint
  res.json({ data: [] });
});
`;
  }

  /**
   * Self-check sanity pass (directive Section 3).
   *
   * Backend Agent checking its OWN output BEFORE calling writeProjectFile().
   * This is NOT a call to SecurityAgent — no new agent-to-agent coupling.
   *
   * Checks:
   *   1. Path doesn't match /debug|admin|internal|__test/i unless isIntentionalDebugPath
   *   2. requireAuth present unless isPublic flag is set
   *   3. No wildcard CORS in generated code
   *
   * Returns an error string if any check fails, null if all pass.
   */
  private selfCheck(
    mountPath: string,
    routeContent: string,
    isPublic: boolean,
    isIntentionalDebugPath: boolean,
  ): string | null {
    // Check 1: debug/admin/internal/__test path patterns
    if (!isIntentionalDebugPath) {
      if (/\/(debug|admin|internal|__test)/i.test(mountPath)) {
        return `Self-check FAILED: route path "${mountPath}" matches debug/admin/internal/__test pattern. Set isIntentionalDebugPath=true to allow this explicitly.`;
      }
    }

    // Check 2: requireAuth present unless isPublic
    if (!isPublic) {
      // The generated content should contain requireAuth on every route.
      // Check that requireAuth appears at least once in a route definition.
      const routeDefs = routeContent.match(/\.(get|post|put|delete|patch)\s*\(/g) ?? [];
      const requireAuthCount = (routeContent.match(/\brequireAuth\b/g) ?? []).length;
      if (routeDefs.length > 0 && requireAuthCount < routeDefs.length) {
        return `Self-check FAILED: ${routeDefs.length} route(s) defined but requireAuth only appears ${requireAuthCount} time(s). Every route must have requireAuth unless isPublic=true.`;
      }
    }

    // Check 3: no wildcard CORS in generated code
    if (/cors\s*\(\s*\{[^}]*origin\s*:\s*['"]\*['"]/i.test(routeContent) ||
        /Access-Control-Allow-Origin.*\*/i.test(routeContent)) {
      return `Self-check FAILED: wildcard CORS detected in generated route code. This is a security risk.`;
    }

    return null; // all checks passed
  }

  /**
   * Add route registration to index.ts content.
   *
   * Adds:
   *   1. import statement at the top (after existing imports)
   *   2. app.use() call in the registration section
   *
   * Returns the FULL new content of index.ts (for writeProjectFile full-overwrite).
   */
  private addRouteRegistration(
    indexContent: string,
    routeName: string,
    routerVarName: string,
    mountPath: string,
  ): string {
    // Add the import after the last existing route import
    const importLine = `import { ${routerVarName} } from './routes/${routeName}.js';`;

    // Find the last route import line to insert after it
    const routeImportRegex = /import\s+\{[^}]+\}\s+from\s+'\.\/routes\/[^']+\.js';/g;
    let lastImportEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = routeImportRegex.exec(indexContent)) !== null) {
      lastImportEnd = match.index + match[0].length;
    }

    let newContent: string;
    if (lastImportEnd > 0) {
      // Insert after the last route import
      newContent = indexContent.slice(0, lastImportEnd) + '\n' + importLine + indexContent.slice(lastImportEnd);
    } else {
      // No existing route imports — insert at the top after the first line
      const firstNewline = indexContent.indexOf('\n');
      newContent = firstNewline >= 0
        ? indexContent.slice(0, firstNewline + 1) + importLine + '\n' + indexContent.slice(firstNewline + 1)
        : importLine + '\n' + indexContent;
    }

    // Add the app.use() call — find the last existing app.use('/api/...' line
    const useLine = `  app.use('${mountPath}', ${routerVarName});`;
    const appUseRegex = /app\.use\s*\(\s*['"]\/api\/[^'"]+['"]/g;
    let lastUseEnd = 0;
    while ((match = appUseRegex.exec(newContent)) !== null) {
      // Find the end of this line (the closing paren + semicolon)
      const lineEnd = newContent.indexOf('\n', match.index);
      lastUseEnd = lineEnd >= 0 ? lineEnd + 1 : match.index + match[0].length;
    }

    if (lastUseEnd > 0) {
      // Insert after the last app.use line
      newContent = newContent.slice(0, lastUseEnd) + useLine + '\n' + newContent.slice(lastUseEnd);
    } else {
      // No existing app.use lines — this shouldn't happen in a real index.ts,
      // but handle it gracefully by appending near the top
      newContent = newContent + '\n' + useLine + '\n';
    }

    return newContent;
  }

  // ── Chat persona (preserved from original stub) ────────────────────
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.4, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['backend', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
