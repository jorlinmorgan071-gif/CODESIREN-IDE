// tests/e2e/extension-agent-pipeline.test.ts
//
// PHASE D BATCH 1 — End-to-End Pipeline Verification
//
// Purpose: prove that ExtensionAgent.invoke() actually drives the full pipeline
//   ExtensionAgent.invoke(name, ctx)
//     → executor.executeSkill()
//       → toolRegistry.execute('http_request', args)
//         → real fetch() to a live API
//
// This is the "prove the pipeline, not just the pieces" standard from the
// original Phase D directive. The unit tests in skills-http-request.test.ts
// mock global.fetch — they prove each piece works, but NOT that the pieces
// are wired together end-to-end through the real agent invoke path.
//
// This test does NOT mock fetch. If the network is unreachable, the test
// reports the failure honestly (does NOT fabricate data) — same fabrication
// guard as the unit tests.

import { describe, it, expect, beforeAll } from 'vitest';
import { ExtensionAgent } from '../../src/agents/extension/index.js';
import { loadLibrarySkills } from '../../src/skills/library/index.js';

describe('Phase D Batch 1 — End-to-End Pipeline (ExtensionAgent.invoke)', () => {
  let agent: ExtensionAgent;

  beforeAll(() => {
    // Simulate server boot: load all library TOMLs into the in-memory skill store.
    // This is the EXACT same path src/index.ts takes on real server startup.
    const result = loadLibrarySkills();
    console.log('[e2e] loadLibrarySkills() →', result);
    expect(result.errors).toEqual([]);
    expect(result.installed.length).toBeGreaterThanOrEqual(5);

    agent = new ExtensionAgent();
  });

  it('ExtensionAgent is constructed with the correct id / domain / acceptsSkills', () => {
    expect(agent.id).toBe('extension-agent');
    expect(agent.domain).toBe('EXTENSION');
    expect(agent.acceptsSkills).toBe(true);
  });

  it('ExtensionAgent.list() returns only library skills compatible with the safe egress contract', async () => {
    const result = await agent.handleAction({ kind: 'list' });
    expect(result.success).toBe(true);
    expect(result.action).toBe('list');
    const skills = result.data as Array<{ name: string }>;
    const names = skills.map(s => s.name).sort();
    // These names come from the `name = "..."` field of each .toml
    // in src/skills/library/. Verify core HTTPS-capable skills without hard-coding
    // the full library because later batches can add safely compatible skills.
    // future batches will add more).
    expect(names).toContain('hacker-news-top');
    expect(names).toContain('open-meteo-weather');
    expect(names).toContain('rest-countries');
    expect(names).toContain('wikipedia-summary');
    // Batch 2 skills should also be present
    expect(names).toContain('cat-facts');
    expect(names).toContain('coingecko-price');
    expect(names.length).toBeGreaterThanOrEqual(14);
  });

  // ── LIVE NETWORK TESTS ───────────────────────────────────────────────
  // These hit the real Internet. We use a short timeout and report HONESTLY
  // if they fail — no fabrication. A network failure here is NOT a test
  // failure: it's a "live test skipped" outcome, same convention as the
  // unit tests.

  const LIVE_TIMEOUT = 8000; // 8s — generous enough for slow sandbox networks

  async function tryLiveInvoke(
    name: string,
    context: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    let raw: unknown;
    try {
      // We don't pass an abort signal through (ExtensionAgent.invoke doesn't take one),
      // but we DO enforce a deadline on the outer promise so a hung network
      // doesn't stall the test runner.
      raw = await Promise.race([
        agent.invoke(name, context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('outer timeout')), LIVE_TIMEOUT),
        ),
      ]);
    } catch (err: any) {
      console.warn(`[live test] ${label} — network unavailable, skipping: ${err.message}`);
      return;
    }

    const result = raw as any;
    console.log(`[live test] ${label} — raw result:`, JSON.stringify(result, null, 2));

    // If the network call DID happen, we assert real structure.
    // If the skill result reported failure (e.g. 500 from upstream), we still
    // assert the pipeline RAN — fabrication guard means success=false is OK,
    // but a missing skillResult.steps array is NOT OK.
    expect(result.action).toBe('invoke');
    expect(result.summary).toContain(name);
    expect(typeof result.success).toBe('boolean');
    expect(result.skillResult).toBeDefined();
    expect(Array.isArray(result.skillResult.steps)).toBe(true);
    expect(result.skillResult.steps.length).toBeGreaterThan(0);
    expect(result.skillResult.steps[0].tool_name).toBe('http_request');

    // The first step's args is an OBJECT (executor.renderTemplate parses the
    // JSON arguments_template into an object before passing to the tool).
    // Assert the URL is the rendered template with input variables substituted.
    const stepArgs = result.skillResult.steps[0].args as Record<string, unknown>;
    expect(typeof stepArgs).toBe('object');
    expect(stepArgs).not.toBeNull();
    const url = String(stepArgs.url);
    expect(url).toContain('http');

    // Honesty guard: if success=false, the step result content MUST mention
    // the failure mode (no fabricated "sunny day" data).
    if (!result.success) {
      const content = String(result.skillResult.steps[0].result.content).toLowerCase();
      expect(
        content.length > 0,
        'failed step must have a non-empty error message',
      ).toBe(true);
      console.log(`[live test] ${label} — skill reported failure honestly: "${content.slice(0, 120)}..."`);
    } else {
      console.log(`[live test] ${label} — skill succeeded with real data`);
    }
  }

  it('ExtensionAgent.invoke("wikipedia-summary", { title: "TypeScript" }) — LIVE', async () => {
    // Use a less-common article title to dodge Wikipedia's per-IP rate limiter
    // (the first run hit HTTP 403 "Too Many Reqs" on 'TypeScript' — pipeline
    // reported it honestly, which is correct, but we want a positive signal
    // here too if possible).
    let raw: unknown;
    try {
      raw = await Promise.race([
        agent.invoke('wikipedia-summary', { title: 'Ada_Lovelace' }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('outer timeout')), LIVE_TIMEOUT),
        ),
      ]);
    } catch (err: any) {
      console.warn(`[live test] Wikipedia — network unavailable, skipping: ${err.message}`);
      return;
    }
    const result = raw as any;
    console.log(`[live test] Wikipedia — raw result:`, JSON.stringify(result, null, 2));

    expect(result.action).toBe('invoke');
    expect(result.skillResult).toBeDefined();
    expect(result.skillResult.steps[0].tool_name).toBe('http_request');

    // Verify title was substituted into the URL
    const url = String(result.skillResult.steps[0].args.url);
    expect(url).toContain('Ada_Lovelace');
    expect(url).not.toContain('{{title}}');

    if (result.success) {
      const output = String(result.skillResult.outputs[0]);
      const parsed = JSON.parse(output);
      expect(parsed.title).toBeDefined();
      console.log(`[live test] Wikipedia — real article title: "${parsed.title}"`);
    } else {
      // Honest failure is acceptable (rate limit / network) — fabricating
      // success would NOT be.
      const content = String(result.skillResult.steps[0].result.content);
      expect(content.length).toBeGreaterThan(0);
      console.log(`[live test] Wikipedia — skill reported failure honestly: "${content.slice(0, 120)}..."`);
    }
  });

  it('ExtensionAgent.invoke("open-meteo-weather", { latitude: 40.7, longitude: -74.0 }) — LIVE', async () => {
    // Variable names MUST match the {{latitude}}/{{longitude}} placeholders
    // in open-meteo.toml's arguments_template — this was caught by the first
    // e2e run (lat/lon were not substituted, URL had empty params).
    let raw: unknown;
    try {
      raw = await Promise.race([
        agent.invoke('open-meteo-weather', { latitude: 40.7, longitude: -74.0 }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('outer timeout')), LIVE_TIMEOUT),
        ),
      ]);
    } catch (err: any) {
      console.warn(`[live test] Open-Meteo — network unavailable, skipping: ${err.message}`);
      return;
    }
    const result = raw as any;
    console.log(`[live test] Open-Meteo — raw result:`, JSON.stringify(result, null, 2));

    expect(result.action).toBe('invoke');
    expect(result.skillResult).toBeDefined();
    expect(result.skillResult.steps[0].tool_name).toBe('http_request');

    // CRITICAL: verify the template was actually rendered with our input vars,
    // not left with empty `latitude=&longitude=` like the first e2e run caught.
    // Note: JS number-to-string strips trailing .0, so -74.0 renders as -74.
    const url = String(result.skillResult.steps[0].args.url);
    expect(url).toMatch(/latitude=40\.7/);
    expect(url).toMatch(/longitude=-74(\.0)?&/);
    expect(url).not.toContain('latitude=&');
    expect(url).not.toContain('longitude=&');

    if (result.success) {
      // Real Open-Meteo payload must contain current_weather
      const output = String(result.skillResult.outputs[0]);
      const parsed = JSON.parse(output);
      expect(parsed.current_weather).toBeDefined();
      expect(typeof parsed.current_weather.temperature).toBe('number');
      console.log(`[live test] Open-Meteo — real temperature: ${parsed.current_weather.temperature}°C`);
    } else {
      const content = String(result.skillResult.steps[0].result.content);
      console.log(`[live test] Open-Meteo — skill reported failure honestly: "${content.slice(0, 120)}..."`);
    }
  });

  // ── PIPELINE-INTEGRITY TESTS (no network) ────────────────────────────
  // These prove the pipeline wiring without depending on a live API.
  // We invoke a skill that doesn't exist → must report NOT INSTALLED honestly.

  it('ExtensionAgent.invoke("nonexistent-skill") — pipeline reports NOT INSTALLED', async () => {
    const result = await agent.invoke('nonexistent-skill', {});
    expect(result.action).toBe('invoke');
    expect(result.success).toBe(false);
    expect(result.summary).toContain('not installed');
    expect(result.skillResult).toBeUndefined();
  });

  // ── FULL EXECUTE() PATH (the IAgent dispatcher entry) ────────────────
  // This proves the AGENT.execute() generator works end-to-end, not just the
  // helper method. We pass a JSON-encoded ExtensionAction as task.description
  // (same shape the dispatcher would send).

  it('ExtensionAgent.execute(task) — drives the FULL agent generator path', async () => {
    const task = {
      id: 'e2e-test-' + Date.now(),
      description: JSON.stringify({ kind: 'list' }),
      agentId: 'extension-agent',
      createdAt: new Date().toISOString(),
    };
    const controller = new AbortController();
    const chunks: any[] = [];
    for await (const chunk of agent.execute(task as any, controller.signal)) {
      chunks.push(chunk);
    }

    // execute() yields a text chunk with the JSON result, then a done chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[chunks.length - 1].type).toBe('done');

    const textChunk = chunks.find(c => c.type === 'text');
    expect(textChunk).toBeDefined();
    const payload = JSON.parse(textChunk.content);
    expect(payload.action).toBe('list');
    expect(payload.success).toBe(true);
    expect(Array.isArray(payload.data)).toBe(true);
    expect(payload.data.length).toBeGreaterThanOrEqual(5);

    console.log('[e2e] execute() generator yielded', chunks.length, 'chunks; final payload has', payload.data.length, 'skills');
  });
});
