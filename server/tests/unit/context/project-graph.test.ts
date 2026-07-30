// tests/unit/context/project-graph.test.ts
//
// Phase B Step 4 — Unit tests for the minimal one-hop import scanner.
//
// Per directive Section 5 Step 4: "Verify: file A imports file B →
// projectGraph includes that edge"

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractImports,
  resolveImport,
  scanFile,
  scanProjectGraph,
  inferLanguage,
} from '../../../src/context/project-graph.js';

describe('Phase B — project-graph.ts extractImports', () => {
  it('extracts ESM default imports', () => {
    const code = `import React from 'react';\nimport fs from 'node:fs';\n`;
    expect(extractImports(code)).toEqual(['react', 'node:fs']);
  });

  it('extracts ESM named imports', () => {
    const code = `import { useState, useEffect } from 'react';\n`;
    expect(extractImports(code)).toEqual(['react']);
  });

  it('extracts ESM namespace imports', () => {
    const code = `import * as path from 'node:path';\n`;
    expect(extractImports(code)).toEqual(['node:path']);
  });

  it('extracts ESM mixed default + named imports', () => {
    const code = `import React, { useState } from 'react';\n`;
    expect(extractImports(code)).toEqual(['react']);
  });

  it('extracts ESM side-effect-only imports', () => {
    const code = `import './polyfills';\nimport 'core-js/stable';\n`;
    expect(extractImports(code)).toEqual(['./polyfills', 'core-js/stable']);
  });

  it('extracts CJS require() with const/let/var', () => {
    const code = [
      `const fs = require('node:fs');`,
      `let path = require('node:path');`,
      `var util = require('node:util');`,
      `const { Readable } = require('node:stream');`,
    ].join('\n');
    expect(extractImports(code)).toEqual(['node:fs', 'node:path', 'node:util', 'node:stream']);
  });

  it('extracts bare require() (side-effect)', () => {
    const code = `require('dotenv/config');\nconsole.log('hi');\n`;
    expect(extractImports(code)).toEqual(['dotenv/config']);
  });

  it('extracts dynamic import()', () => {
    const code = [
      `const mod = await import('./lazy-module');`,
      `button.onclick = () => import('react-dom/client');`,
    ].join('\n');
    expect(extractImports(code)).toEqual(['./lazy-module', 'react-dom/client']);
  });

  it('handles double-quoted imports', () => {
    const code = `import React from "react";\nconst fs = require("node:fs");\n`;
    expect(extractImports(code)).toEqual(['react', 'node:fs']);
  });

  it('de-duplicates repeated imports', () => {
    const code = [
      `import { useState } from 'react';`,
      `import { useEffect } from 'react';`, // same specifier, different binding
      `import React from 'react';`,
    ].join('\n');
    expect(extractImports(code)).toEqual(['react']);
  });

  it('returns empty array for content with no imports', () => {
    const code = `const x = 1;\nconsole.log(x);\nfunction foo() { return 42; }\n`;
    expect(extractImports(code)).toEqual([]);
  });

  it('does NOT match import-like strings inside string literals', () => {
    // The regex matches lines that START with `import` (after whitespace),
    // so this should not match:
    const code = `const msg = "import fake from 'not-real'";\n`;
    expect(extractImports(code)).toEqual([]);
  });
});

describe('Phase B — project-graph.ts resolveImport', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cs-pg-'));
    // Create a small fake project:
    //   /src/index.ts
    //   /src/utils/helper.ts
    //   /src/utils/index.ts
    //   /src/data.json
    mkdirSync(join(tmpRoot, 'src', 'utils'), { recursive: true });
    writeFileSync(join(tmpRoot, 'src', 'index.ts'), `export const x = 1;`);
    writeFileSync(join(tmpRoot, 'src', 'utils', 'helper.ts'), `export const helper = () => 42;`);
    writeFileSync(join(tmpRoot, 'src', 'utils', 'index.ts'), `export * from './helper';`);
    writeFileSync(join(tmpRoot, 'src', 'data.json'), `{"a":1}`);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves relative import with .ts extension', () => {
    // index.ts imports './utils/helper' → src/utils/helper.ts
    const resolved = resolveImport('./utils/helper', 'src/index.ts', tmpRoot);
    expect(resolved).toBe(join('src', 'utils', 'helper.ts'));
  });

  it('resolves relative import with .json extension', () => {
    const resolved = resolveImport('./data', 'src/index.ts', tmpRoot);
    expect(resolved).toBe(join('src', 'data.json'));
  });

  it('resolves directory import (index.ts)', () => {
    // index.ts imports './utils' → src/utils/index.ts
    const resolved = resolveImport('./utils', 'src/index.ts', tmpRoot);
    expect(resolved).toBe(join('src', 'utils', 'index.ts'));
  });

  it('resolves parent-directory relative import', () => {
    // src/utils/helper.ts imports '../index' → src/index.ts
    const resolved = resolveImport('../index', 'src/utils/helper.ts', tmpRoot);
    expect(resolved).toBe(join('src', 'index.ts'));
  });

  it('returns bare specifier unchanged (does not walk node_modules)', () => {
    expect(resolveImport('react', 'src/index.ts', tmpRoot)).toBe('react');
    expect(resolveImport('express', 'src/index.ts', tmpRoot)).toBe('express');
    expect(resolveImport('@scope/pkg', 'src/index.ts', tmpRoot)).toBe('@scope/pkg');
  });

  it('returns absolute specifier unchanged', () => {
    expect(resolveImport('/etc/passwd', 'src/index.ts', tmpRoot)).toBe('/etc/passwd');
  });

  it('returns project-relative path (no extension) for unresolvable relative imports', () => {
    // File doesn't exist on disk — return the path without extension
    const resolved = resolveImport('./nonexistent', 'src/index.ts', tmpRoot);
    expect(resolved).toBe(join('src', 'nonexistent'));
  });
});

describe('Phase B — project-graph.ts scanFile + scanProjectGraph', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cs-pg-'));
    mkdirSync(join(tmpRoot, 'src'), { recursive: true });
    mkdirSync(join(tmpRoot, 'src', 'utils'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('scanFile: returns imports for a file with multiple ESM imports', () => {
    // File A imports file B + a bare module
    writeFileSync(join(tmpRoot, 'src', 'A.ts'), [
      `import { helper } from './utils/B';`,
      `import React from 'react';`,
      `import { useState } from 'react';`,
      `export const A = () => helper();`,
    ].join('\n'));
    writeFileSync(join(tmpRoot, 'src', 'utils', 'B.ts'), `export const helper = () => 42;`);

    const result = scanFile('src/A.ts', tmpRoot);

    expect(result.file).toBe('src/A.ts');
    expect(result.error).toBeUndefined();
    // Should contain resolved B.ts + bare 'react' (deduplicated)
    expect(result.imports).toContain(join('src', 'utils', 'B.ts'));
    expect(result.imports).toContain('react');
    // 'react' should appear only once (deduplicated)
    expect(result.imports.filter(i => i === 'react').length).toBe(1);
  });

  it('scanFile: returns empty imports + error for nonexistent file', () => {
    const result = scanFile('src/nonexistent.ts', tmpRoot);
    expect(result.file).toBe('src/nonexistent.ts');
    expect(result.imports).toEqual([]);
    expect(result.error).toContain('not found');
  });

  it('scanProjectGraph: builds one node per file (directive Step 4 verify)', () => {
    // THE directive verify case: file A imports file B → graph includes that edge
    writeFileSync(join(tmpRoot, 'src', 'A.ts'), [
      `import { foo } from './B';`,
      `import { bar } from './C';`,
    ].join('\n'));
    writeFileSync(join(tmpRoot, 'src', 'B.ts'), `export const foo = () => 1;`);
    writeFileSync(join(tmpRoot, 'src', 'C.ts'), `export const bar = () => 2;`);

    const graph = scanProjectGraph(['src/A.ts', 'src/B.ts'], tmpRoot);

    // One node per file (not per import)
    expect(graph.length).toBe(2);

    // Node for A.ts has 2 imports (B.ts + C.ts)
    const nodeA = graph.find(n => n.file === 'src/A.ts');
    expect(nodeA).toBeDefined();
    expect(nodeA!.imports.length).toBe(2);
    expect(nodeA!.imports).toContain(join('src', 'B.ts'));
    expect(nodeA!.imports).toContain(join('src', 'C.ts'));

    // Node for B.ts has 0 imports
    const nodeB = graph.find(n => n.file === 'src/B.ts');
    expect(nodeB).toBeDefined();
    expect(nodeB!.imports).toEqual([]);
  });

  it('scanProjectGraph: includes files with scan errors (empty imports)', () => {
    // Even if a file doesn't exist, it gets a node with empty imports
    const graph = scanProjectGraph(['src/missing.ts'], tmpRoot);
    expect(graph.length).toBe(1);
    expect(graph[0].file).toBe('src/missing.ts');
    expect(graph[0].imports).toEqual([]);
  });

  it('scanProjectGraph: handles empty input array', () => {
    const graph = scanProjectGraph([], tmpRoot);
    expect(graph).toEqual([]);
  });
});

describe('Phase B — project-graph.ts inferLanguage', () => {
  it('infers typescript for .ts', () => {
    expect(inferLanguage('foo.ts')).toBe('typescript');
    expect(inferLanguage('foo.tsx')).toBe('typescript');
  });

  it('infers javascript for .js', () => {
    expect(inferLanguage('foo.js')).toBe('javascript');
    expect(inferLanguage('foo.jsx')).toBe('javascript');
    expect(inferLanguage('foo.mjs')).toBe('javascript');
    expect(inferLanguage('foo.cjs')).toBe('javascript');
  });

  it('infers python for .py', () => {
    expect(inferLanguage('foo.py')).toBe('python');
  });

  it('infers json for .json', () => {
    expect(inferLanguage('package.json')).toBe('json');
  });

  it('infers markdown for .md', () => {
    expect(inferLanguage('README.md')).toBe('markdown');
  });

  it('returns plaintext for unknown extensions', () => {
    expect(inferLanguage('foo.unknownext')).toBe('plaintext');
    expect(inferLanguage('noextension')).toBe('plaintext');
  });
});
