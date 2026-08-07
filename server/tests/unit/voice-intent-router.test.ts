// server/tests/unit/voice-intent-router.test.ts
// Phase B: Hands-Free — Voice-to-Code-Written v1 intent router tests.
//
// Tests the trigger phrase detection, strip logic, and the fail-safe
// behavior of classifyIntent() when the LLM returns unparseable/invalid JSON.
//
// Note: classifyIntent() uses the real ModelRouter, which falls back to the
// stub engine when no LLM is configured. The stub engine returns a canned
// response — the tests verify that the router fails SAFE (defaults to 'chat')
// regardless of what the stub returns, since the stub response won't be valid
// JSON matching the schema.

import { describe, it, expect } from 'vitest';
import {
  containsTriggerPhrase,
  stripTriggerPhrase,
  classifyIntent,
  CONFIDENCE_THRESHOLD,
} from '../../src/orchestration/voice-intent-router.js';

describe('Phase B: Voice-to-Code-Written — Trigger Phrase', () => {

  it('containsTriggerPhrase matches "go siren" at the start', () => {
    expect(containsTriggerPhrase('go siren add a login route')).toBe(true);
    expect(containsTriggerPhrase('Go Siren add a login route')).toBe(true);
    expect(containsTriggerPhrase('GO SIREN add a login route')).toBe(true);
  });

  it('containsTriggerPhrase matches "go, siren" with comma', () => {
    expect(containsTriggerPhrase('go, siren add a login route')).toBe(true);
    expect(containsTriggerPhrase('Go, Siren, add a login route')).toBe(true);
  });

  it('containsTriggerPhrase matches "that\'s it siren" variant', () => {
    expect(containsTriggerPhrase("that's it siren add a login route")).toBe(true);
    expect(containsTriggerPhrase("thats it siren add a login route")).toBe(true);
    expect(containsTriggerPhrase("That's it, Siren, add a login route")).toBe(true);
  });

  it('containsTriggerPhrase matches trigger phrase mid-transcript', () => {
    expect(containsTriggerPhrase('um, let me think... go siren add a login route')).toBe(true);
  });

  it('containsTriggerPhrase does NOT match normal speech without trigger', () => {
    expect(containsTriggerPhrase('add a login route')).toBe(false);
    expect(containsTriggerPhrase('hey siren add a login route')).toBe(false);  // wake word ≠ trigger
    expect(containsTriggerPhrase('how do I add a login route?')).toBe(false);
    expect(containsTriggerPhrase('create a migration')).toBe(false);
    expect(containsTriggerPhrase('')).toBe(false);
  });

  it('does not false-match "siren" alone or "go" alone', () => {
    expect(containsTriggerPhrase('siren')).toBe(false);
    expect(containsTriggerPhrase('go')).toBe(false);
    expect(containsTriggerPhrase('go siren')).toBe(true);  // bare trigger is still a trigger
    expect(containsTriggerPhrase('siren go')).toBe(false);  // wrong order
  });
});

describe('Phase B: Voice-to-Code-Written — stripTriggerPhrase', () => {

  it('strips "go siren" prefix', () => {
    expect(stripTriggerPhrase('go siren add a login route')).toBe('add a login route');
  });

  it('strips "go, siren" with comma', () => {
    expect(stripTriggerPhrase('go, siren add a login route')).toBe('add a login route');
  });

  it('strips mid-transcript trigger phrase', () => {
    // The strip leaves a double-space when removing a mid-transcript trigger;
    // the caller (voice-proxy) trims + uses it as LLM input, so whitespace
    // normalization isn't critical here. We just verify the trigger is gone.
    const result = stripTriggerPhrase('um let me think go siren add a login route');
    expect(result).not.toContain('go siren');
    expect(result).toContain('add a login route');
    expect(result).toContain('um let me think');
  });

  it('returns empty string when only the trigger phrase is present', () => {
    expect(stripTriggerPhrase('go siren')).toBe('');
    expect(stripTriggerPhrase('Go, Siren')).toBe('');
  });

  it('leaves trailing punctuation that isn\'t part of the trigger', () => {
    // The trigger phrase regex matches "go, siren" but not the trailing "."
    // So "Go, Siren." → "." (the period remains). This is fine — the caller
    // trims + checks for empty, and "." is not empty but is effectively
    // a no-op transcript that the router will classify as chat.
    const result = stripTriggerPhrase('Go, Siren.');
    expect(result).toBe('.');
  });

  it('returns the original string when no trigger phrase is present', () => {
    expect(stripTriggerPhrase('add a login route')).toBe('add a login route');
  });
});

describe('Phase B: Voice-to-Code-Written — classifyIntent fail-safe', () => {

  it('returns empty transcript as chat with confidence 0', async () => {
    const result = await classifyIntent('');
    expect(result.type).toBe('chat');
    expect(result.confidence).toBe(0);
  });

  it('returns whitespace-only transcript as chat with confidence 0', async () => {
    const result = await classifyIntent('   ');
    expect(result.type).toBe('chat');
    expect(result.confidence).toBe(0);
  });

  // The stub engine returns a canned response that won't be valid JSON.
  // classifyIntent must fail SAFE — default to 'chat', never accidentally
  // trigger a write.
  it('defaults to chat when LLM returns unparseable response (stub engine)', async () => {
    const result = await classifyIntent('add a login route');
    // The stub engine's response won't match our JSON schema — must be chat
    expect(result.type).toBe('chat');
    expect(result.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    // rawResponse should be non-empty (the stub did return something)
    expect(typeof result.rawResponse).toBe('string');
  });

  it('never returns write-route with the stub engine (fail-safe)', async () => {
    // Run multiple times to be sure — the stub returns the same canned response
    for (let i = 0; i < 5; i++) {
      const result = await classifyIntent('add a login route');
      expect(result.type).not.toBe('write-route');
    }
  });
});

describe('Phase B: Voice-to-Code-Written — CONFIDENCE_THRESHOLD', () => {

  it('threshold is 0.7 (documented)', () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.7);
  });
});
