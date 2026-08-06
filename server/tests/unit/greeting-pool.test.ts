// server/tests/unit/greeting-pool.test.ts
// Phase B: Hands-Free — Greeting rotation pool tests.
//
// Tests:
//   1. Pool has exactly 7 variants (2 warm, 2 cheeky, 3 sassy)
//   2. getTimeTag() returns correct tags for all 24 hours
//   3. pickGreeting() only returns eligible greetings for the current hour
//   4. Time-restricted greetings never appear outside their window
//   5. Random selection varies across many calls (not always the same one)
//   6. personalizeGreeting() substitutes [name] with the real display name
//   7. personalizeGreeting() gracefully omits name when empty
//   8. All greetings contain exactly one [name] placeholder (before substitution)

import { describe, it, expect } from 'vitest';
import {
  greetingPool,
  getTimeTag,
  pickGreeting,
  personalizeGreeting,
  type GreetingVariant,
} from '../../src/systems/voice/voice-proxy.js';

describe('Phase B: Greeting Rotation Pool', () => {

  // ── TEST 1: Pool composition ──────────────────────────────────────────
  it('pool has exactly 7 variants: 2 warm, 2 cheeky, 3 sassy', () => {
    expect(greetingPool.length).toBe(7);

    const warm = greetingPool.filter(g => g.tone === 'warm');
    const cheeky = greetingPool.filter(g => g.tone === 'cheeky');
    const sassy = greetingPool.filter(g => g.tone === 'sassy');

    expect(warm.length).toBe(2);
    expect(cheeky.length).toBe(2);
    expect(sassy.length).toBe(3);

    // Every variant has a unique id
    const ids = greetingPool.map(g => g.id);
    expect(new Set(ids).size).toBe(7);

    // Every variant has all required fields
    for (const g of greetingPool) {
      expect(typeof g.id).toBe('string');
      expect(typeof g.tone).toBe('string');
      expect(typeof g.timeTag).toBe('string');
      expect(typeof g.text).toBe('string');
      expect(g.text.length).toBeGreaterThan(10);
    }
  });

  // ── TEST 2: getTimeTag ────────────────────────────────────────────────
  it('getTimeTag returns correct tags for all 24 hours', () => {
    // 05:00–11:59 → 'morning'
    for (let h = 5; h < 12; h++) {
      expect(getTimeTag(h)).toBe('morning');
    }
    // 12:00–17:59 → 'afternoon'
    for (let h = 12; h < 18; h++) {
      expect(getTimeTag(h)).toBe('afternoon');
    }
    // 18:00–22:59 → 'evening'
    for (let h = 18; h < 23; h++) {
      expect(getTimeTag(h)).toBe('evening');
    }
    // 23:00–04:59 → 'late-night'
    for (const h of [23, 0, 1, 2, 3, 4]) {
      expect(getTimeTag(h)).toBe('late-night');
    }
  });

  // ── TEST 3: pickGreeting returns only eligible greetings ──────────────
  it('pickGreeting only returns greetings eligible for the current hour', () => {
    // Test every hour of the day
    for (let hour = 0; hour < 24; hour++) {
      const currentTag = getTimeTag(hour);
      // Run many picks to cover the random distribution
      for (let i = 0; i < 50; i++) {
        const picked = pickGreeting(hour);
        // The picked greeting must be 'any' or match the current time tag
        expect(
          picked.timeTag === 'any' || picked.timeTag === currentTag,
          `hour=${hour} currentTag=${currentTag} picked.timeTag=${picked.timeTag} (id=${picked.id}) — should be 'any' or '${currentTag}'`
        ).toBe(true);
      }
    }
  });

  // ── TEST 4: Time-restricted greetings never appear outside their window ─
  it('time-restricted greetings never appear outside their time window', () => {
    // warm-2 is 'morning' only — must never appear at 15:00 (afternoon)
    const warm2 = greetingPool.find(g => g.id === 'warm-2')!;
    expect(warm2.timeTag).toBe('morning');

    for (let i = 0; i < 200; i++) {
      const picked = pickGreeting(15); // afternoon
      expect(picked.id).not.toBe('warm-2');
    }

    // cheeky-2 is 'late-night' only — must never appear at 10:00 (morning)
    const cheeky2 = greetingPool.find(g => g.id === 'cheeky-2')!;
    expect(cheeky2.timeTag).toBe('late-night');

    for (let i = 0; i < 200; i++) {
      const picked = pickGreeting(10); // morning
      expect(picked.id).not.toBe('cheeky-2');
    }

    // sassy-2 is 'evening' only — must never appear at 03:00 (late-night)
    const sassy2 = greetingPool.find(g => g.id === 'sassy-2')!;
    expect(sassy2.timeTag).toBe('evening');

    for (let i = 0; i < 200; i++) {
      const picked = pickGreeting(3); // late-night
      expect(picked.id).not.toBe('sassy-2');
    }
  });

  // ── TEST 5: Random selection varies ───────────────────────────────────
  it('random selection varies across many calls (not always the same one)', () => {
    // Pick 500 greetings at a time when the pool is largest (afternoon → 'any' entries)
    // At afternoon (12-17), eligible = all 'any' entries + any 'afternoon' entries
    // 'any' entries: warm-1, cheeky-1, sassy-1, sassy-3 = 4 entries
    // No 'afternoon'-tagged entries exist in the pool, so eligible = 4
    const picks: string[] = [];
    for (let i = 0; i < 500; i++) {
      picks.push(pickGreeting(14).id); // 14:00 = afternoon
    }
    const uniqueIds = new Set(picks);
    // With 4 eligible greetings and 500 picks, we should see at least 3 unique ones
    // (statistically, seeing only 1 would be ~1/4^499 — impossible)
    expect(uniqueIds.size).toBeGreaterThanOrEqual(3);

    // No single greeting should dominate (>60% would suggest bias)
    for (const id of uniqueIds) {
      const count = picks.filter(p => p === id).length;
      const ratio = count / picks.length;
      expect(ratio).toBeLessThan(0.6);
    }
  });

  // ── TEST 6: Name substitution ─────────────────────────────────────────
  it('personalizeGreeting substitutes [name] with the real display name', () => {
    const name = 'Alex';
    const result = personalizeGreeting('Hey [name]. Code Siren is live.', name);
    expect(result).toBe('Hey Alex. Code Siren is live.');
    expect(result).not.toContain('[name]');

    // Multi-occurrence substitution
    const result2 = personalizeGreeting('[name], [name], [name] — three times.', name);
    expect(result2).toBe('Alex, Alex, Alex — three times.');
    expect(result2).not.toContain('[name]');
  });

  // ── TEST 7: Empty name graceful fallback ──────────────────────────────
  it('personalizeGreeting gracefully omits name when empty', () => {
    // Empty string → removes "[name]. " or "[name], " prefix
    const result1 = personalizeGreeting('Hey [name]. Code Siren is live.', '');
    expect(result1).toBe('Hey Code Siren is live.');
    expect(result1).not.toContain('[name]');

    // With comma
    const result2 = personalizeGreeting('Good morning, [name]. Fresh coffee.', '');
    expect(result2).toBe('Good morning, Fresh coffee.');
    expect(result2).not.toContain('[name]');

    // Null/undefined name
    const result3 = personalizeGreeting('Hey [name]. Code Siren is live.', undefined as unknown as string);
    expect(result3).toBe('Hey Code Siren is live.');
    expect(result3).not.toContain('[name]');

    // Name with only whitespace
    const result4 = personalizeGreeting('Hey [name]. Code Siren is live.', '   ');
    expect(result4).toBe('Hey Code Siren is live.');
    expect(result4).not.toContain('[name]');
  });

  // ── TEST 8: All greetings have exactly one [name] placeholder ─────────
  it('all greetings in the pool contain exactly one [name] placeholder', () => {
    for (const g of greetingPool) {
      const matches = g.text.match(/\[name\]/g);
      expect(
        matches?.length,
        `greeting "${g.id}" should have exactly 1 [name] placeholder, found ${matches?.length ?? 0}`
      ).toBe(1);
    }
  });

  // ── TEST 9: Full pipeline — pick + personalize produces valid output ──
  it('full pipeline: pickGreeting + personalizeGreeting produces valid output for every hour', () => {
    const testName = 'Jordan';
    for (let hour = 0; hour < 24; hour++) {
      const variant = pickGreeting(hour);
      const greeting = personalizeGreeting(variant.text, testName);

      // Output must not contain the placeholder
      expect(greeting).not.toContain('[name]');

      // Output must contain the name (since we provided one)
      expect(greeting).toContain(testName);

      // Output must be a reasonable length (not empty, not absurdly long)
      expect(greeting.length).toBeGreaterThan(20);
      expect(greeting.length).toBeLessThan(200);
    }
  });

  // ── TEST 10: Eligible pool size per time tag ──────────────────────────
  it('eligible pool has at least 3 greetings at every time of day', () => {
    // The 'any' tag gives us 4 greetings. Time-specific tags add more.
    // At every hour, the eligible pool must have ≥3 greetings (the 'any' ones
    // alone provide 4, so this should always pass).
    for (let hour = 0; hour < 24; hour++) {
      const currentTag = getTimeTag(hour);
      const eligible = greetingPool.filter(
        g => g.timeTag === 'any' || g.timeTag === currentTag
      );
      expect(
        eligible.length,
        `hour=${hour} tag=${currentTag} eligible=${eligible.length}`
      ).toBeGreaterThanOrEqual(3);
    }
  });

  // ── TEST 11: Time-restricted entries only fire in their window ────────
  it('each time-restricted entry appears ONLY in its tagged window', () => {
    const restricted = greetingPool.filter(g => g.timeTag !== 'any');
    expect(restricted.length).toBe(3); // warm-2, cheeky-2, sassy-2

    for (const g of restricted) {
      // For every hour NOT in this tag's window, the greeting must never be picked
      for (let hour = 0; hour < 24; hour++) {
        const tag = getTimeTag(hour);
        if (tag !== g.timeTag) {
          // Run 100 picks — this greeting should never appear
          for (let i = 0; i < 100; i++) {
            const picked = pickGreeting(hour);
            expect(
              picked.id,
              `greeting "${g.id}" (tag=${g.timeTag}) should not be picked at hour=${hour} (tag=${tag})`
            ).not.toBe(g.id);
          }
        }
      }
    }
  });
});
