// server/scripts/export-traces.ts
// Phase 6 — Export traces as a standalone JSON file.
//
// Reads .traces/runs.jsonl (the append-only trace log) and writes a pretty-
// printed JSON array. Each line is one AgentRunTrace object.
//
// Usage:
//   npm run export-traces                    → writes traces-export-<timestamp>.json
//   npm run export-traces -- --out=/path     → writes to /path
//   npm run export-traces -- --limit=100     → only last 100 traces
//   npm run export-traces -- --agent=arch    → filter by agentId substring
//
// Does NOT mutate any source data. Does NOT modify any protected system.

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, '..');

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
}

async function main() {
  console.log('━'.repeat(60));
  console.log('  Code Siren Export Traces');
  console.log('━'.repeat(60));

  // Parse args
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const agentArg = process.argv.find((a) => a.startsWith('--agent='));

  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;
  const agentFilter = agentArg ? agentArg.split('=')[1] : undefined;

  const tracesFile = join(SERVER_DIR, '.traces', 'runs.jsonl');
  if (!existsSync(tracesFile)) {
    console.log('  ✗ No traces file found at .traces/runs.jsonl');
    console.log('    Run the server and trigger some agent tasks first.');
    process.exit(1);
  }

  const stat = statSync(tracesFile);
  console.log(`  Source: .traces/runs.jsonl (${formatBytes(stat.size)})`);

  // Read + parse JSONL
  const content = readFileSync(tracesFile, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  console.log(`  Read ${lines.length} trace lines`);

  let traces: any[] = [];
  for (const line of lines) {
    try {
      traces.push(JSON.parse(line));
    } catch (err: any) {
      console.error(`  ⚠ skipping unparseable line: ${err.message}`);
    }
  }

  // Filter by agent
  if (agentFilter) {
    traces = traces.filter((t) => t.agentId?.includes(agentFilter));
    console.log(`  After agent filter ('${agentFilter}'): ${traces.length} traces`);
  }

  // Sort newest first
  traces.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  // Apply limit
  if (limit && traces.length > limit) {
    traces = traces.slice(0, limit);
    console.log(`  After limit (${limit}): ${traces.length} traces`);
  }

  // Write output
  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outPath = outArg
    ? outArg.split('=')[1]
    : join(SERVER_DIR, `traces-export-${timestamp}.json`);

  const output = {
    exportedAt: new Date().toISOString(),
    sourceFile: '.traces/runs.jsonl',
    sourceSizeBytes: stat.size,
    count: traces.length,
    traces,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  const outStat = statSync(outPath);
  console.log('');
  console.log(`  ✓ Exported ${traces.length} traces`);
  console.log(`    → ${outPath}`);
  console.log(`    Size: ${formatBytes(outStat.size)}`);
  console.log('');
  console.log('━'.repeat(60));
}

main().catch((err) => {
  console.error('export-traces fatal:', err);
  process.exit(1);
});
