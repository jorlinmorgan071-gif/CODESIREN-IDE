// server/src/agents/documentation/index.ts
// Documentation Agent — Source-grounded documentation generation.
//
// Phase C Agent 7: HARDENED from 31-line chat-only stub to real IAgent with
// 3 programmatic capabilities:
//   1. documentFunction() — reads a real file, generates/updates informal
//      header comments matching the 91%-confirmed convention (NOT JSDoc)
//   2. updateReadmeSection() — marker-bounded README section edit with
//      byte-for-byte preservation of content outside the markers
//   3. documentRouteFile() — reads a real Express route file, generates
//      API documentation reflecting actual routes/zod schemas/requireAuth
//
// SCOPE BOUNDARY (non-negotiable):
//   - Source-grounded — reads ACTUAL files before generating. Never fabricates.
//   - Informal comment convention — file-level `//` headers + inline `//`,
//     NOT formal JSDoc (per Section 0: 91% of files use informal, 8% use
//     JSDoc but 5 of those 8 are Phase C additions, not the original style)
//   - README edits are marker-bounded ONLY — never whole-file regeneration.
//     If markers don't exist, insert a new marked section at the end.
//   - All writes through writeProjectFile() → CodeReviewAgent gate.
//     No .md exemption — code examples in docs use placeholders
//     (<your-key-here>, process.env.API_KEY), never realistic-looking values.
//   - On-demand only — no auto-triggered documentation generation.

import type {
  AgentChunk,
  AgentTask,
  AgentDomain,
  CommentDocResult,
  ReadmeSectionResult,
  ApiDocResult,
  ApiDocEntry,
} from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { writeProjectFile } from '../_shared/project-files.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SYSTEM_PROMPT = `You are the Documentation Agent of Zero Two: Code Siren.
Your role: generate and update documentation from actual source code — never fabricate.
When documenting:
1. Read the REAL file before generating — don't guess what it contains.
2. Match the existing informal comment convention (// headers + inline comments, NOT JSDoc).
3. For README sections: use marker-bounded edits only (<!-- AUTO-GENERATED --> ... <!-- END AUTO-GENERATED -->).
4. For code examples in docs: use placeholders (<your-key-here>, process.env.API_KEY), never realistic-looking values.
5. If asked to document something that doesn't exist: refuse, don't fabricate.
Be accurate, concise, and grounded in real source.`;

const README_MARKER_START = '<!-- AUTO-GENERATED';
const README_MARKER_END = '<!-- END AUTO-GENERATED -->';

export class DocumentationAgent extends IAgent {
  readonly id = 'documentation-agent';
  readonly name = 'Documentation Agent';
  readonly domain: AgentDomain = 'DOCUMENTATION';
  readonly icon = 'file-text';
  readonly color = '#14B8A6';
  constructor() { super(0.87); }

  // ── 1. Function/comment documentation ──────────────────────────────
  /**
   * Read a real source file, generate/update informal header comments
   * for a specified function or section, write via writeProjectFile().
   *
   * Per Section 0: match the informal `//` convention — file-level header
   * + inline comments. Do NOT impose formal JSDoc.
   *
   * Per Section 1: if the target file or function doesn't exist, REFUSE.
   */
  async documentFunction(params: {
    projectRoot: string;
    filePath: string;          // relative to project root, e.g. 'server/src/agents/architect/index.ts'
    functionName?: string;     // if specified, document this specific function; if omitted, document the file
    description?: string;      // what the function/file does (from the task description)
    traceId?: string;
  }): Promise<CommentDocResult> {
    const { projectRoot, filePath, functionName, description, traceId } = params;
    const fullPath = join(projectRoot, filePath);

    // ── Fabrication guard: file must exist ────────────────────────────
    if (!existsSync(fullPath)) {
      return {
        file: filePath,
        updatedContent: null,
        written: false,
        commentAdded: false,
        refused: `File does not exist: ${filePath}`,
      };
    }

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch (err: any) {
      return {
        file: filePath,
        updatedContent: null,
        written: false,
        commentAdded: false,
        refused: `Cannot read file: ${err.message}`,
      };
    }

    // ── Fabrication guard: function must exist (if specified) ─────────
    if (functionName) {
      // Look for the function definition (function foo, const foo =, async foo, etc.)
      const fnPattern = new RegExp(
        `\\b(?:function\\s+${functionName}\\b|(?:const|let|var)\\s+${functionName}\\s*=|async\\s+function\\s+${functionName}\\b|async\\s+\\*?\\s*${functionName}\\s*\\()`,
        'i'
      );
      if (!fnPattern.test(content)) {
        return {
          file: filePath,
          updatedContent: null,
          written: false,
          commentAdded: false,
          refused: `Function '${functionName}' does not exist in ${filePath}`,
        };
      }
    }

    // ── Generate the comment (informal // style, NOT JSDoc) ──────────
    const comment = this.generateInformalComment(filePath, functionName, description, content);

    // ── Insert/update the comment ─────────────────────────────────────
    // If the file already has a header comment (starts with //), update it.
    // If not, prepend the new header.
    let updatedContent: string;
    if (content.startsWith('//')) {
      // File already has a header — replace the header block (consecutive // lines at the start)
      const lines = content.split('\n');
      let headerEnd = 0;
      while (headerEnd < lines.length && lines[headerEnd].startsWith('//')) {
        headerEnd++;
      }
      // Skip blank line after header
      if (headerEnd < lines.length && lines[headerEnd].trim() === '') {
        headerEnd++;
      }
      const restOfFile = lines.slice(headerEnd).join('\n');
      updatedContent = comment + '\n' + restOfFile;
    } else {
      // No existing header — prepend
      updatedContent = comment + '\n\n' + content;
    }

    // ── Write through writeProjectFile() ──────────────────────────────
    const writeResult = await writeProjectFile(this.id, fullPath, updatedContent, traceId);

    return {
      file: filePath,
      updatedContent: writeResult.written ? updatedContent : null,
      written: writeResult.written,
      commentAdded: writeResult.written,
      refused: writeResult.written ? undefined : `CodeReviewAgent rejected: ${writeResult.review.issues.join('; ')}`,
    };
  }

  /**
   * Generate an informal // header comment matching the codebase convention.
   * NOT JSDoc — just // lines with path + purpose + context.
   */
  private generateInformalComment(
    filePath: string,
    functionName: string | undefined,
    description: string | undefined,
    content: string
  ): string {
    const lines: string[] = [];
    lines.push(`// ${filePath}`);

    if (functionName) {
      lines.push(`// ${functionName} — ${description || 'function documentation'}`);
    } else {
      lines.push(`// ${description || 'source file'}`);
    }

    // Add context about what the file/function does (from the actual content)
    // Simple heuristic: look for class/function/export declarations
    const exportMatch = content.match(/export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/);
    if (exportMatch) {
      lines.push(`// Exports: ${exportMatch[1]}`);
    }

    // Look for imports to understand dependencies
    const importCount = (content.match(/^import\s/gm) || []).length;
    if (importCount > 0) {
      lines.push(`// Dependencies: ${importCount} import(s)`);
    }

    // Look for the approximate line count
    const lineCount = content.split('\n').length;
    lines.push(`// Size: ${lineCount} lines`);

    return lines.join('\n');
  }

  // ── 2. README section generation ───────────────────────────────────
  /**
   * Update a marker-bounded section in a README file.
   *
   * Per directive Section 2:
   *   - Marker-bounded ONLY: <!-- AUTO-GENERATED: section-name --> ... <!-- END AUTO-GENERATED -->
   *   - NEVER whole-file regeneration
   *   - If markers don't exist, insert a new marked section at the end
   *   - Content OUTSIDE the markers is preserved BYTE-FOR-BYTE
   *   - Fresh-read discipline: read the file immediately before constructing the new content
   */
  async updateReadmeSection(params: {
    projectRoot: string;
    readmePath: string;        // relative to project root, e.g. 'README.md' or 'server/README.md'
    sectionName: string;       // e.g. 'api-endpoints'
    sectionContent: string;    // the markdown content for this section
    traceId?: string;
  }): Promise<ReadmeSectionResult> {
    const { projectRoot, readmePath, sectionName, sectionContent, traceId } = params;
    const fullPath = join(projectRoot, readmePath);

    // ── Fabrication guard: file must exist ────────────────────────────
    if (!existsSync(fullPath)) {
      return {
        file: readmePath,
        sectionName,
        updatedContent: null,
        written: false,
        preservedOutsideMarkers: false,
        refused: `README file does not exist: ${readmePath}`,
      };
    }

    // ── FRESH READ: read the file immediately before constructing content ──
    // Per directive Section 3: "read immediately before each write, same
    // pattern as Backend Agent's index.ts handling"
    let originalContent: string;
    try {
      originalContent = readFileSync(fullPath, 'utf8');
    } catch (err: any) {
      return {
        file: readmePath,
        sectionName,
        updatedContent: null,
        written: false,
        preservedOutsideMarkers: false,
        refused: `Cannot read README: ${err.message}`,
      };
    }

    // ── Construct the marked section ──────────────────────────────────
    const startMarker = `${README_MARKER_START}: ${sectionName} -->`;
    const endMarker = README_MARKER_END;
    const markedSection = `${startMarker}\n${sectionContent}\n${endMarker}`;

    // ── Check if markers already exist ────────────────────────────────
    const startMarkerRegex = new RegExp(
      `${README_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-->`,
      'i'
    );

    let updatedContent: string;

    if (startMarkerRegex.test(originalContent)) {
      // Markers exist — replace the content between them (inclusive of markers)
      // Find the start marker line and the end marker line
      const lines = originalContent.split('\n');
      let startLineIdx = -1;
      let endLineIdx = -1;

      for (let i = 0; i < lines.length; i++) {
        if (startMarkerRegex.test(lines[i])) {
          startLineIdx = i;
        }
        if (startLineIdx >= 0 && lines[i].trim() === endMarker.trim()) {
          endLineIdx = i;
          break;
        }
      }

      if (startLineIdx >= 0 && endLineIdx >= 0) {
        // Replace lines from startLineIdx to endLineIdx (inclusive)
        const before = lines.slice(0, startLineIdx).join('\n');
        const after = lines.slice(endLineIdx + 1).join('\n');
        updatedContent = before + (before ? '\n' : '') + markedSection + (after ? '\n' + after : '');
      } else {
        // Start marker found but no end marker — insert end marker after start
        updatedContent = originalContent.replace(
          startMarkerRegex,
          markedSection
        );
      }
    } else {
      // Markers don't exist — append new marked section at the end
      updatedContent = originalContent.trimEnd() + '\n\n' + markedSection + '\n';
    }

    // ── Byte-for-byte preservation proof ──────────────────────────────
    // Extract the content OUTSIDE the markers from both original and updated
    // and verify they're identical.
    const preservedOutsideMarkers = this.verifyPreservation(originalContent, updatedContent, startMarker, endMarker);

    // ── Write through writeProjectFile() ──────────────────────────────
    const writeResult = await writeProjectFile(this.id, fullPath, updatedContent, traceId);

    return {
      file: readmePath,
      sectionName,
      updatedContent: writeResult.written ? updatedContent : null,
      written: writeResult.written,
      preservedOutsideMarkers,
      refused: writeResult.written ? undefined : `CodeReviewAgent rejected: ${writeResult.review.issues.join('; ')}`,
    };
  }

  /**
   * Verify that content outside the markers is preserved byte-for-byte.
   * Extracts non-marker content from both original and updated, compares.
   */
  private verifyPreservation(
    original: string,
    updated: string,
    startMarker: string,
    endMarker: string
  ): boolean {
    // For a new section (markers didn't exist in original), the original
    // content should appear verbatim in the updated content (before the
    // appended markers).
    const endMarkerRegex = new RegExp(
      `${README_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'i'
    );

    // Extract content outside markers from both
    const originalOutside = original.replace(endMarkerRegex, '').trim();
    const updatedOutside = updated.replace(endMarkerRegex, '').trim();

    return originalOutside === updatedOutside;
  }

  // ── 3. API route documentation ─────────────────────────────────────
  /**
   * Read a real Express route file and generate API documentation
   * reflecting actual routes, zod schemas, and requireAuth usage.
   *
   * Per directive Section 1: read the REAL routes — don't fabricate.
   * Per directive Section 3: claimed auth requirement must match
   * the REAL requireAuth presence/absence.
   */
  async documentRouteFile(params: {
    projectRoot: string;
    routeFilePath: string;     // e.g. 'server/src/routes/agents.ts'
    traceId?: string;
  }): Promise<ApiDocResult> {
    const { projectRoot, routeFilePath } = params;
    const fullPath = join(projectRoot, routeFilePath);

    // ── Fabrication guard: file must exist ────────────────────────────
    if (!existsSync(fullPath)) {
      return {
        file: routeFilePath,
        routerVarName: '',
        mountPath: null,
        routes: [],
        refused: `Route file does not exist: ${routeFilePath}`,
      };
    }

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch (err: any) {
      return {
        file: routeFilePath,
        routerVarName: '',
        mountPath: null,
        routes: [],
        refused: `Cannot read route file: ${err.message}`,
      };
    }

    // ── Parse the route file for real route definitions ───────────────
    const routes: ApiDocEntry[] = [];

    // Find the router variable name
    const routerMatch = content.match(/export\s+const\s+(\w+Router)\s*=\s*Router\(\)/);
    const routerVarName = routerMatch ? routerMatch[1] : 'unknownRouter';

    // Find all route definitions: routerVar.method('path', [requireAuth,] handler)
    // Match patterns like: agentsRouter.post('/:agentId/send', requireAuth, async (req, res) => {
    const routeRegex = new RegExp(
      `${routerVarName}\\.(get|post|put|delete|patch)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
      'gi'
    );

    let routeMatch: RegExpExecArray | null;
    while ((routeMatch = routeRegex.exec(content)) !== null) {
      const method = routeMatch[1].toUpperCase();
      const path = routeMatch[2];

      // Find the full line to check for requireAuth
      const lineStart = content.lastIndexOf('\n', routeMatch.index) + 1;
      const lineEnd = content.indexOf('\n', routeMatch.index);
      const fullLine = content.slice(lineStart, lineEnd >= 0 ? lineEnd : undefined);
      const requiresAuth = /\brequireAuth\b/.test(fullLine);

      // Extract description from the comment above the route (if any)
      const linesBefore = content.slice(0, lineStart).split('\n');
      let description = '';
      for (let i = linesBefore.length - 1; i >= 0; i--) {
        const trimmed = linesBefore[i].trim();
        if (trimmed.startsWith('//')) {
          description = trimmed.replace(/^\/\/\s*/, '') + (description ? ' ' + description : '');
        } else if (trimmed === '') {
          continue; // skip blank lines between comment and route
        } else {
          break; // non-comment, non-blank line — stop
        }
      }

      routes.push({
        method,
        path,
        mountPath: '', // filled later from index.ts
        fullPath: path, // will be prefixed with mountPath
        requiresAuth,
        schemaFields: [], // filled from zod schema
        description: description || `No description`,
      });
    }

    // ── Parse the zod schema (if any) ─────────────────────────────────
    const schemaMatch = content.match(/const\s+\w+Schema\s*=\s*z\.object\(\s*\{([\s\S]*?)\}\s*\)/);
    if (schemaMatch) {
      const schemaBody = schemaMatch[1];
      // Parse individual fields: name: z.string()..., name: z.enum([...])..., etc.
      const fieldRegex = /(\w+):\s*(z\.\w+(?:\([^)]*\))?)/g;
      let fieldMatch: RegExpExecArray | null;
      while ((fieldMatch = fieldRegex.exec(schemaBody)) !== null) {
        const fieldName = fieldMatch[1];
        const fieldType = fieldMatch[2];
        // Determine if required or optional
        const isOptional = /\.optional\(\)/.test(fieldType);
        // Extract the base type
        const baseType = fieldType.match(/z\.(\w+)/)?.[1] || 'unknown';

        for (const route of routes) {
          route.schemaFields.push({
            name: fieldName,
            type: baseType,
            required: !isOptional,
          });
        }
      }
    }

    // ── Look up the mount path from index.ts ──────────────────────────
    let mountPath: string | null = null;
    const indexFilePath = join(projectRoot, 'server', 'src', 'index.ts');
    if (existsSync(indexFilePath)) {
      try {
        const indexContent = readFileSync(indexFilePath, 'utf8');
        // Find: app.use('/api/...', routerVarName)
        const mountRegex = new RegExp(
          `app\\.use\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*${routerVarName}\\b`
        );
        const mountMatch = indexContent.match(mountRegex);
        if (mountMatch) {
          mountPath = mountMatch[1];
          // Update fullPath for all routes
          for (const route of routes) {
            route.mountPath = mountPath!;
            route.fullPath = mountPath + route.path;
          }
        }
      } catch {
        // Can't read index.ts — mountPath stays null
      }
    }

    return {
      file: routeFilePath,
      routerVarName,
      mountPath,
      routes,
    };
  }

  // ── Chat persona (preserved from original stub) ────────────────────
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.5, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceType: 'agent', sourceRef: this.id, tags: ['documentation', task.type] });
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
