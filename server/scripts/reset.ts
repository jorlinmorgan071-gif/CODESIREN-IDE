// server/scripts/reset.ts
// npm run reset — clears in-memory state and trace files.
// Does NOT touch the database (if connected) or biometric templates.

import { existsSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

console.log('━'.repeat(50));
console.log('  Code Siren Reset');
console.log('━'.repeat(50));

// 1. Clear trace file
const tracesFile = join(process.cwd(), '.traces', 'runs.jsonl');
if (existsSync(tracesFile)) {
  unlinkSync(tracesFile);
  console.log('  ✓ Cleared .traces/runs.jsonl');
} else {
  console.log('  - .traces/runs.jsonl already absent');
}

// 2. Clear STL outputs
const stlDir = join(process.cwd(), '.stl-out');
if (existsSync(stlDir)) {
  rmSync(stlDir, { recursive: true });
  console.log('  ✓ Cleared .stl-out/');
} else {
  console.log('  - .stl-out/ already absent');
}

// 3. Clear G-code outputs
const gcodeDir = join(process.cwd(), '.stl-out', 'gcode-out');
if (existsSync(gcodeDir)) {
  rmSync(gcodeDir, { recursive: true });
  console.log('  ✓ Cleared .stl-out/gcode-out/');
}

// 4. NOTE: Do NOT clear .biometric-templates/ — that's user data, not runtime state
console.log('  - .biometric-templates/ preserved (user data)');

console.log('');
console.log('  ✓ Reset complete. Restart the server to apply.');
console.log('━'.repeat(50));
