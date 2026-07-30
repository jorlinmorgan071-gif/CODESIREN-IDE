// server/scripts/seed-memories.ts
// Brain Visualizer Section 5 — seed 1000+ test memory rows for stress-testing.
// Usage: npx tsx scripts/seed-memories.ts [--count=1000]
// Creates fake agent_memory entries with varied agent_ids + content.
// Does NOT touch real memories — only adds new ones.

import { memoryEngine } from '../src/memory/engine.js';

async function main() {
  const countArg = process.argv.find((a) => a.startsWith('--count='));
  const count = countArg ? parseInt(countArg.split('=')[1], 10) : 1000;

  console.log('━'.repeat(50));
  console.log(`  Seeding ${count} test memories…`);
  console.log('━'.repeat(50));

  const agentIds = [
    'architect-agent', 'frontend-agent', 'backend-agent', 'database-agent',
    'security-agent', 'devops-agent', 'qa-tester-agent', 'documentation-agent',
    'performance-agent', 'terminal-agent', 'memory-agent', 'ui-designer-agent',
    'research-agent', 'deployment-agent', 'prompt-engineer-agent', 'code-review-agent',
    'extension-agent', 'fabrication-agent', 'operative-agent', 'sentinel-agent',
  ];

  const startTime = Date.now();
  for (let i = 0; i < count; i++) {
    const agentId = agentIds[i % agentIds.length];
    const content = `Test memory #${i}: ${agentId} learned about topic ${Math.floor(Math.random() * 100)} at ${new Date().toISOString()}`;
    await memoryEngine.memorize(content, {
      sourceType: 'agent',
      sourceRef: agentId,
      tags: ['test', 'seed', `batch-${Math.floor(i / 100)}`],
    }, agentId);

    if ((i + 1) % 100 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${i + 1}/${count} seeded (${elapsed}s)`);
    }
  }

  const total = await memoryEngine.count();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(`  ✓ Seeded ${count} memories in ${elapsed}s`);
  console.log(`  Total memories now: ${total}`);
  console.log('━'.repeat(50));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
