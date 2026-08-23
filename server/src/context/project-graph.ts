// server/src/context/project-graph.ts
// Minimal one-hop import scanner (Phase B, directive Section 2 source #5).
//
// Per directive Section 0 Finding 4: NO project-graph builder existed in the
// codebase before this file. Per directive Section 2: "If no project-graph
// builder exists yet, implement a minimal one via regex/require parsing —
// do not add a new heavy parser dependency without confirming none exists."
//
// Scope: for each file in `task.context.activeFiles`, read its content and
// extract its DIRECT imports (one hop only — we do NOT recurse into the
// imported files). Resolve relative imports against the file's directory;
// leave bare imports (e.g. 'react') as-is.
//
// What this is NOT:
//   - NOT a full TypeScript/JavaScript AST parser (we use regex)
//   - NOT a transitive dependency walker (only one hop)
//   - NOT a multi-language dependency resolver (TS/JS only — Python, Go,
//     Rust, etc. are not supported. The directive was specific about
//     "imports" which in a Code Siren context means ESM/CJS for now)
//
// Why regex + not a real parser:
//   - No existing parser dependency in package.json (verified during
//     Section 0 — no `typescript-eslint`, no `@babel/parser`, no `acorn`)
//   - Adding a parser dep is explicitly forbidden by the directive unless
//     none exists, AND even then the directive says "do not add a new
//     heavy parser dependency without confirming none exists"
//   - For one-hop imports, regex is sufficient — we just need to extract
//     the import specifier strings, not interpret them semantically

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import type { ProjectGraphNode } from './types.js';
import { resolveContainedWorkspacePath } from '../workspace/service.js';

/**
 * The result of scanning one file for imports.
 * - `file` is the path as it appeared in `activeFiles` (unchanged).
 * - `imports` are the import specifier strings, resolved when possible.
 * - `error` is set if the file couldn't be read (e.g. doesn't exist,
 *   permission denied). The caller decides whether to surface this.
 */
export interface ScanResult {
  file: string;
  imports: string[];
  error?: string;
}

// ── Regex patterns ───────────────────────────────────────────────────────
//
// These cover the common ESM and CJS import forms. They are intentionally
// permissive about whitespace and quote style (single OR double) to handle
// real-world code formatting. They do NOT try to handle:
//   - JSX namespace imports (rare, ignore)
//   - Dynamic import() inside expressions (we'd catch `import(...)` but
//     not the ones where the argument is a template literal — too edge)
//   - CSS @import, Python import, etc. (out of scope per directive)

// ESM: `import ... from '...'`, `import '...'` (side-effect only),
// `import * as ns from '...'`, `import {a, b} from '...'`,
// `import defaultExport, {a, b} from '...'`
const ESM_IMPORT_RE = /^\s*import\s+(?:[\w*{}\s,]+from\s+)?['"]([^'"]+)['"]/gm;

// CJS: `const x = require('...')`, `const {a, b} = require('...')`,
// `require('...')` (side-effect), `let x = require('...')`
const CJS_REQUIRE_RE = /(?:^|\s)(?:const|let|var)\s+[\w{}\s,]+\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm;
const CJS_BARE_REQUIRE_RE = /(?:^|\s)require\(\s*['"]([^'"]+)['"]\s*\)/gm;

// Dynamic ESM: `import('...')` (returns a promise)
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

/**
 * Extract raw import specifier strings from file content.
 * Returns a de-duplicated list. Order is preserved (first occurrence wins).
 */
export function extractImports(content: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const pushIfNew = (spec: string): void => {
    if (spec && !seen.has(spec)) {
      seen.add(spec);
      found.push(spec);
    }
  };

  // Reset lastIndex on each regex (they have the `g` flag)
  ESM_IMPORT_RE.lastIndex = 0;
  CJS_REQUIRE_RE.lastIndex = 0;
  CJS_BARE_REQUIRE_RE.lastIndex = 0;
  DYNAMIC_IMPORT_RE.lastIndex = 0;

  let m: RegExpExecArray | null;

  while ((m = ESM_IMPORT_RE.exec(content)) !== null) pushIfNew(m[1]);
  while ((m = CJS_REQUIRE_RE.exec(content)) !== null) pushIfNew(m[1]);
  while ((m = CJS_BARE_REQUIRE_RE.exec(content)) !== null) pushIfNew(m[1]);
  while ((m = DYNAMIC_IMPORT_RE.exec(content)) !== null) pushIfNew(m[1]);

  return found;
}

/**
 * Resolve a single import specifier against the importing file's directory.
 * - Relative specifiers (`./foo`, `../bar`) → resolved to a project-relative
 *   path, with `.ts`/`.js`/`.tsx`/`.jsx`/`/index.ts` extensions tried.
 * - Bare specifiers (`react`, `express`, `@scope/pkg`) → returned as-is
 *   (we don't walk node_modules).
 *
 * Returns the resolved path (project-relative) or the original specifier
 * if it couldn't be resolved (bare imports, or relative imports that don't
 * exist on disk — which can happen if the file was deleted between the
 * editor opening it and us scanning it).
 */
export function resolveImport(
  spec: string,
  importingFilePath: string,
  projectRoot: string,
): string {
  // Bare specifier (no leading `.` or `/`)
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    return spec;
  }

  // Absolute path (rare in import statements but technically valid)
  if (spec.startsWith('/')) {
    return spec;
  }

  // Relative specifier — resolve against the importing file's directory
  const importingDir = dirname(importingFilePath);
  let resolvedBase: string;
  try {
    resolvedBase = resolveContainedWorkspacePath(projectRoot, join(importingDir, spec));
  } catch {
    return spec;
  }
  const projectRelativeBase = relative(projectRoot, resolvedBase);

  // Try common TS/JS extensions + index files
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
  for (const ext of extensions) {
    const candidate = `${resolvedBase}${ext}`;
    if (existsSync(candidate)) {
      try {
        const canonicalCandidate = resolveContainedWorkspacePath(projectRoot, relative(projectRoot, candidate), { mustExist: true });
        return relative(projectRoot, canonicalCandidate);
      } catch {
        return spec;
      }
    }
  }
  // Try /index.{ext} (directory imports)
  for (const ext of extensions) {
    const candidate = join(resolvedBase, `index${ext}`);
    if (existsSync(candidate)) {
      try {
        const canonicalCandidate = resolveContainedWorkspacePath(projectRoot, relative(projectRoot, candidate), { mustExist: true });
        return relative(projectRoot, canonicalCandidate);
      } catch {
        return spec;
      }
    }
  }

  // Couldn't resolve — return the project-relative base path (without
  // extension) so the caller at least sees what the import pointed at.
  return projectRelativeBase;
}

/**
 * Scan a single file for its direct imports. Returns the file path
 * (unchanged from the input) + the list of resolved imports.
 */
export function scanFile(
  filePath: string,
  projectRoot: string,
): ScanResult {
  let fullPath: string;
  try {
    fullPath = resolveContainedWorkspacePath(projectRoot, filePath, { mustExist: true });
  } catch (error: any) {
    if (error?.message === 'Workspace file does not exist') {
      return { file: filePath, imports: [], error: `file not found: ${filePath}` };
    }
    return { file: filePath, imports: [], error: 'workspace path rejected' };
  }

  if (!existsSync(fullPath)) {
    return {
      file: filePath,
      imports: [],
      error: `file not found: ${fullPath}`,
    };
  }

  let content: string;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch (err: any) {
    return {
      file: filePath,
      imports: [],
      error: `read failed: ${err.message}`,
    };
  }

  const rawImports = extractImports(content);
  const resolvedImports = rawImports.map(spec => resolveImport(spec, filePath, projectRoot));

  return {
    file: filePath,
    imports: resolvedImports,
  };
}

/**
 * Scan multiple files for their direct imports. Returns one
 * ProjectGraphNode per file (with `imports` resolved where possible).
 *
 * Files that couldn't be read are still included in the result (with empty
 * `imports`) — the projectGraph contract is "one entry per open file",
 * not "one entry per successfully-scanned file". The scan error is logged
 * but not surfaced in the ProjectGraphNode (to keep the ContextBundle
 * shape clean — the budget module doesn't need to know about scan errors).
 */
export function scanProjectGraph(
  filePaths: string[],
  projectRoot: string,
): ProjectGraphNode[] {
  const results: ProjectGraphNode[] = [];
  for (const filePath of filePaths) {
    const scan = scanFile(filePath, projectRoot);
    if (scan.error) {
      console.warn(`[context:project-graph] ${scan.error} (file will have empty imports)`);
    }
    results.push({
      file: scan.file,
      imports: scan.imports,
    });
  }
  return results;
}

/**
 * Infer a language string from a file extension. Used by the manager.ts
 * when loading open file contents into OpenFile objects.
 */
export function inferLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.md': 'markdown',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.rb': 'ruby',
    '.php': 'php',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.toml': 'toml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'shell',
    '.bash': 'shell',
    '.sql': 'sql',
    '.txt': 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}
