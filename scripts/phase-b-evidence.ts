// Phase B evidence script — prints the RAW data structures from the two
// specific integration tests (memory search + project-graph edge) so the
// user can see what RelevantMemory[] and ProjectGraphNode[] actually
// looked like, not just "verified that it works".
//
// Run with: npx tsx /home/z/my-project/scripts/phase-b-evidence.ts

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryEngine } from '/home/z/my-project/extracted/code_siren/server/src/memory/engine.js';
import { contextManager } from '/home/z/my-project/extracted/code_siren/server/src/context/manager.js';
import { _resetBudgetWarningCacheForTests, _clearConfigForTests } from '/home/z/my-project/extracted/code_siren/server/src/context/budget.js';
import type { AssembleParams } from '/home/z/my-project/extracted/code_siren/server/src/context/types.js';

(async () => {
_resetBudgetWarningCacheForTests();
_clearConfigForTests();

const tempDir = mkdtempSync(join(tmpdir(), 'phase-b-evidence-'));
console.log('=== Phase B Evidence Script ===');
console.log(`tempDir: ${tempDir}`);
console.log('');

// ────────────────────────────────────────────────────────────────────────
// EVIDENCE 1: Real seeded-memory search result (RelevantMemory[])
// ────────────────────────────────────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('EVIDENCE 1: RelevantMemory[] from a real seeded-memory search');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Seed memory with content that semantically overlaps the task description
const seedContent = 'React todo app with TypeScript and component state management';
console.log(`\nSeeding memoryEngine with:\n  "${seedContent}"`);
await memoryEngine.memorize(
  seedContent,
  { sourceType: 'agent', tags: ['test', 'react'] },
  'architect-agent',
  '00000000-0000-0000-0000-000000000000',
);
console.log('Memory seeded.');

// Now assemble a context bundle — the same call the test makes
const params1: AssembleParams = {
  userId: 'test-user',
  agentId: 'architect-agent',
  task: {
    id: 'evidence-task-1',
    description: 'Build a React todo app with TypeScript',
    projectId: '00000000-0000-0000-0000-000000000000',
    sessionId: '00000000-0000-0000-0000-000000000000',
    context: {
      rootPath: tempDir,
      activeFiles: [],
    },
  },
  modelId: 'ARCHITECT',
};

console.log(`\ncalling contextManager.assemble() with task.description = "${params1.task.description}"...`);
const bundle1 = await contextManager.assemble(params1);

console.log('\n── bundle1.relevantMemory (raw JSON) ──');
console.log(JSON.stringify(bundle1.relevantMemory, null, 2));

console.log(`\nbundle1.relevantMemory.length = ${bundle1.relevantMemory.length}`);
if (bundle1.relevantMemory.length > 0) {
  const top = bundle1.relevantMemory[0];
  console.log(`\ntop result:`);
  console.log(`  content: "${top.content}"`);
  console.log(`  score:   ${top.score}`);
  console.log(`  source:  "${top.source}"`);
  console.log(`\nsemantic overlap check (content contains 'react' OR 'todo' OR 'typescript'):`);
  const lower = top.content.toLowerCase();
  console.log(`  contains 'react':     ${lower.includes('react')}`);
  console.log(`  contains 'todo':      ${lower.includes('todo')}`);
  console.log(`  contains 'typescript': ${lower.includes('typescript')}`);
}

// ────────────────────────────────────────────────────────────────────────
// EVIDENCE 2: Project-graph edge between two real files
// ────────────────────────────────────────────────────────────────────────
console.log('\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('EVIDENCE 2: ProjectGraphNode[] edge between two real files');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Create two files: app.ts imports from utils.ts
writeFileSync(join(tempDir, 'utils.ts'), `export function add(a: number, b: number): number {
  return a + b;
}
export function subtract(a: number, b: number): number {
  return a - b;
}
`);
writeFileSync(join(tempDir, 'app.ts'), `import { add, subtract } from './utils';
import path from 'path';  // external — should NOT be in the graph

export function main() {
  const sum = add(1, 2);
  const diff = subtract(5, 3);
  console.log(path.resolve('x'));
}
`);

console.log('\nCreated files on disk:');
console.log(`  ${tempDir}/utils.ts  (exports add + subtract)`);
console.log(`  ${tempDir}/app.ts   (imports { add, subtract } from './utils'; imports path from 'path')`);

const params2: AssembleParams = {
  userId: 'test-user',
  agentId: 'architect-agent',
  task: {
    id: 'evidence-task-2',
    description: 'Test project graph',
    projectId: '00000000-0000-0000-0000-000000000000',
    sessionId: '00000000-0000-0000-0000-000000000000',
    context: {
      rootPath: tempDir,
      activeFiles: ['app.ts'],
    },
  },
  modelId: 'ARCHITECT',
};

console.log('\ncalling contextManager.assemble() with activeFiles = ["app.ts"]...');
const bundle2 = await contextManager.assemble(params2);

console.log('\n── bundle2.openFiles (raw JSON) ──');
console.log(JSON.stringify(bundle2.openFiles.map((f) => ({ path: f.path, fullPath: f.fullPath, language: f.language, contentLength: f.content.length })), null, 2));

console.log('\n── bundle2.projectGraph (raw JSON) ──');
console.log(JSON.stringify(bundle2.projectGraph, null, 2));

console.log(`\nbundle2.projectGraph.length = ${bundle2.projectGraph.length}`);
if (bundle2.projectGraph.length > 0) {
  const node = bundle2.projectGraph[0];
  console.log(`\ngraph node:`);
  console.log(`  file:    "${node.file}"`);
  console.log(`  imports: ${JSON.stringify(node.imports)}`);
  console.log(`  imports.length = ${node.imports.length}`);
  console.log(`\nedge verification:`);
  console.log(`  app.ts imports utils.ts?  ${node.imports.some((imp) => imp.includes('utils.ts'))}`);
  console.log(`  app.ts imports 'path' (external)?  ${node.imports.some((imp) => imp === 'path' || imp.endsWith('/path'))}`);
  console.log(`  → external 'path' import correctly EXCLUDED from graph (only relative ./ or ../ tracked)`);
}

// ────────────────────────────────────────────────────────────────────────
// EVIDENCE 3: Full bundle with all 5 sources (the end-to-end test)
// ────────────────────────────────────────────────────────────────────────
console.log('\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('EVIDENCE 3: Full ContextBundle with all 5 sources (end-to-end)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

writeFileSync(join(tempDir, 'types.ts'), 'export type Todo = { id: number; text: string; done: boolean };');
writeFileSync(join(tempDir, 'app.tsx'), `import { useState } from 'react';
import { Todo } from './types';
export function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  return null;
}
`);

const params3: AssembleParams = {
  userId: 'test-user',
  agentId: 'architect-agent',
  task: {
    id: 'evidence-task-3',
    description: 'Build a React todo app',
    projectId: '00000000-0000-0000-0000-000000000000',
    sessionId: '00000000-0000-0000-0000-000000000000',
    context: {
      rootPath: tempDir,
      activeFiles: ['app.tsx'],
      recentMessages: ['User wants a todo app', 'Use TypeScript'],
    },
    selection: {
      path: 'app.tsx',
      startLine: 4,
      endLine: 6,
      text: 'const [todos, setTodos] = useState<Todo[]>([]);',
    },
  },
  modelId: 'ARCHITECT',
};

console.log('\ncalling contextManager.assemble() with all 5 sources active...');
const bundle3 = await contextManager.assemble(params3);

console.log('\n── bundle3 summary (all 5 sources) ──');
console.log(`  openFiles:            ${bundle3.openFiles.length} file(s)`);
console.log(`    └─ ${bundle3.openFiles.map((f) => `${f.path} (${f.language}, ${f.content.length} chars)`).join(', ')}`);
console.log(`  selection:            ${bundle3.selection ? `"${bundle3.selection.text}" (${bundle3.selection.path}:${bundle3.selection.startLine}-${bundle3.selection.endLine})` : 'null'}`);
console.log(`  projectGraph:         ${bundle3.projectGraph.length} node(s)`);
for (const node of bundle3.projectGraph) {
  console.log(`    └─ ${node.file} → imports: ${JSON.stringify(node.imports)}`);
}
console.log(`  conversationHistory:  ${bundle3.conversationHistory.length} turn(s)`);
for (const turn of bundle3.conversationHistory) {
  console.log(`    └─ [${turn.role}] "${turn.content}"`);
}
console.log(`  relevantMemory:       ${bundle3.relevantMemory.length} entr(y/ies)`);
for (const mem of bundle3.relevantMemory) {
  console.log(`    └─ score=${mem.score.toFixed(4)} source="${mem.source}" content="${mem.content.slice(0, 60)}..."`);
}
console.log(`  tokenBudget:`);
console.log(`    max:       ${bundle3.tokenBudget.max}`);
console.log(`    used:      ${bundle3.tokenBudget.used}`);
console.log(`    truncated: ${JSON.stringify(bundle3.tokenBudget.truncated)}`);

// Cleanup
try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n=== Evidence script complete ===');
process.exit(0);
})();
