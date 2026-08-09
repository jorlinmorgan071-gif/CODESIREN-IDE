async function main() {
  const { loadAgents } = await import('./src/agents/loader.js');
  const results = await loadAgents();
  console.log(`Loaded ${results.length} agents:`);
  for (const { agent, dirName } of results) {
    console.log(`  ${dirName} → id=${agent.id}`);
  }
  if (results.length !== 20) {
    console.error(`EXPECTED 20, GOT ${results.length}`);
    process.exit(1);
  }
  console.log('PASS: 20 agents loaded');
}
main().catch(err => { console.error(err); process.exit(1); });
