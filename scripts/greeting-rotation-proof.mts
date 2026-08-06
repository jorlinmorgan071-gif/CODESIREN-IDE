// scripts/greeting-rotation-proof.mts
//
// Phase B: Hands-Free — Greeting Rotation Pool behavioral proof.
//
// This script tests the greeting pool by importing the exported functions
// (pickGreeting, personalizeGreeting, getTimeTag, greetingPool) directly
// and simulating many session starts at different hours of the day.
//
// Tests:
//   1. Simulate 100 session starts at the current hour — confirm real variation
//   2. Simulate session starts at every hour — confirm time-restricted entries
//      only appear in their tagged window
//   3. Confirm name substitution uses a real display name
//   4. Confirm empty-name fallback works

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Import from the server source (tsx handles TS transpilation)
const {
  greetingPool,
  getTimeTag,
  pickGreeting,
  personalizeGreeting,
} = require('/home/z/my-project/server/src/systems/voice/voice-proxy.js') as typeof import('./server/src/systems/voice/voice-proxy.js');

function log(msg: string) {
  console.log(msg);
}

function main() {
  log('═'.repeat(72));
  log('Phase B: Hands-Free — Greeting Rotation Pool Behavioral Proof');
  log('═'.repeat(72));
  log('');

  // ── Check 1: Real variation across 100 sessions at current hour ───────
  log('── CHECK 1: Real variation across 100 simulated sessions ──');
  const currentHour = new Date().getHours();
  const currentTag = getTimeTag(currentHour);
  log(`  current time: ${new Date().toISOString()} (hour=${currentHour}, tag=${currentTag})`);

  const displayName = 'TestUser';
  const sessionGreetings: Array<{ id: string; tone: string; text: string }> = [];
  for (let i = 0; i < 100; i++) {
    const variant = pickGreeting(currentHour);
    const text = personalizeGreeting(variant.text, displayName);
    sessionGreetings.push({ id: variant.id, tone: variant.tone, text });
  }

  const idCounts: Record<string, number> = {};
  for (const g of sessionGreetings) {
    idCounts[g.id] = (idCounts[g.id] ?? 0) + 1;
  }
  const uniqueIds = Object.keys(idCounts);
  log(`  sessions simulated: 100`);
  log(`  unique greeting IDs: ${uniqueIds.length}`);
  log(`  distribution:`);
  for (const [id, count] of Object.entries(idCounts).sort((a, b) => b[1] - a[1])) {
    const pct = (count / 100 * 100).toFixed(0);
    const tone = greetingPool.find(g => g.id === id)?.tone ?? '?';
    log(`    ${id} (${tone}): ${count}x (${pct}%)`);
  }
  const variationPassed = uniqueIds.length >= 2;
  log(`  PASS: ${variationPassed ? '✓' : '✗'} (need ≥2 unique IDs, got ${uniqueIds.length})`);

  // ── Check 2: Name substitution ────────────────────────────────────────
  log('\n── CHECK 2: Name substitution uses real display name ──');
  const allContainName = sessionGreetings.every(g => g.text.includes(displayName));
  const noneHavePlaceholder = sessionGreetings.every(g => !g.text.includes('[name]'));
  log(`  all greetings contain "${displayName}": ${allContainName ? 'YES' : 'NO'}`);
  log(`  no greetings contain [name] placeholder: ${noneHavePlaceholder ? 'YES' : 'NO'}`);
  log(`  sample greetings:`);
  for (const g of sessionGreetings.slice(0, 5)) {
    log(`    [${g.id}] "${g.text}"`);
  }
  const namePassed = allContainName && noneHavePlaceholder;
  log(`  PASS: ${namePassed ? '✓' : '✗'}`);

  // ── Check 3: Time-restriction — test all 24 hours ─────────────────────
  log('\n── CHECK 3: Time-restricted entries only appear in their tagged window ──');
  const restrictedEntries = greetingPool.filter(g => g.timeTag !== 'any');
  log(`  time-restricted entries: ${restrictedEntries.map(g => `${g.id}(${g.timeTag})`).join(', ')}`);

  let timeRestrictionPassed = true;
  for (const restricted of restrictedEntries) {
    log(`\n  Testing ${restricted.id} (requires "${restricted.timeTag}"):`);
    for (let hour = 0; hour < 24; hour++) {
      const tag = getTimeTag(hour);
      const isAllowed = tag === restricted.timeTag;
      // Simulate 200 picks at this hour
      let appeared = 0;
      for (let i = 0; i < 200; i++) {
        const picked = pickGreeting(hour);
        if (picked.id === restricted.id) appeared++;
      }
      const status = isAllowed
        ? (appeared > 0 ? '✓ appeared' : '~ not picked (random)')
        : (appeared === 0 ? '✓ correctly absent' : `✗ APPEARED ${appeared}x`);
      if (!isAllowed && appeared > 0) {
        timeRestrictionPassed = false;
      }
      if (hour === currentHour || (!isAllowed && appeared > 0) || (isAllowed && appeared > 0)) {
        log(`    hour=${String(hour).padStart(2, '0')} tag=${tag} ${isAllowed ? 'ALLOWED' : 'BLOCKED'} → appeared=${appeared} ${status}`);
      }
    }
  }
  log(`\n  PASS: ${timeRestrictionPassed ? '✓' : '✗'}`);

  // ── Check 4: Empty name fallback ──────────────────────────────────────
  log('\n── CHECK 4: Empty name graceful fallback ──');
  const emptyNameGreetings = sessionGreetings.slice(0, 10).map(g => {
    const variant = greetingPool.find(v => v.id === g.id)!;
    return personalizeGreeting(variant.text, '');
  });
  const allNoPlaceholder = emptyNameGreetings.every(t => !t.includes('[name]'));
  log(`  greetings with empty name (no [name] leftover): ${allNoPlaceholder ? 'YES' : 'NO'}`);
  log(`  sample:`);
  for (const t of emptyNameGreetings.slice(0, 3)) {
    log(`    "${t}"`);
  }
  const emptyNamePassed = allNoPlaceholder;
  log(`  PASS: ${emptyNamePassed ? '✓' : '✗'}`);

  // ── Check 5: Pool composition ─────────────────────────────────────────
  log('\n── CHECK 5: Pool composition (2 warm, 2 cheeky, 3 sassy) ──');
  const warm = greetingPool.filter(g => g.tone === 'warm');
  const cheeky = greetingPool.filter(g => g.tone === 'cheeky');
  const sassy = greetingPool.filter(g => g.tone === 'sassy');
  log(`  warm: ${warm.length} (expected 2)`);
  log(`  cheeky: ${cheeky.length} (expected 2)`);
  log(`  sassy: ${sassy.length} (expected 3)`);
  log(`  total: ${greetingPool.length} (expected 7)`);
  const compositionPassed = warm.length === 2 && cheeky.length === 2 && sassy.length === 3 && greetingPool.length === 7;
  log(`  PASS: ${compositionPassed ? '✓' : '✗'}`);

  // ── Summary ───────────────────────────────────────────────────────────
  log('\n' + '═'.repeat(72));
  log('SUMMARY');
  log('═'.repeat(72));
  log(`  1. Variation:         ${variationPassed ? '✓ PASS' : '✗ FAIL'} (${uniqueIds.length} unique / 100 sessions)`);
  log(`  2. Name substitution:  ${namePassed ? '✓ PASS' : '✗ FAIL'} (all contain "${displayName}", no [name] leftover)`);
  log(`  3. Time restriction:   ${timeRestrictionPassed ? '✓ PASS' : '✗ FAIL'} (restricted entries stay in their window)`);
  log(`  4. Empty name fallback: ${emptyNamePassed ? '✓ PASS' : '✗ FAIL'} (no [name] leftover when name empty)`);
  log(`  5. Pool composition:   ${compositionPassed ? '✓ PASS' : '✗ FAIL'} (2 warm, 2 cheeky, 3 sassy = 7)`);
  const allPass = variationPassed && namePassed && timeRestrictionPassed && emptyNamePassed && compositionPassed;
  log(`\n  OVERALL: ${allPass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}`);
  log('═'.repeat(72));

  process.exit(allPass ? 0 : 1);
}

main();
