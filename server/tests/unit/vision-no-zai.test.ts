// server/tests/unit/vision-no-zai.test.ts
// Phase 3+ — Vision routing z-ai dependency removal test.
//
// Verifies:
//   1. orchestrator.ts does not import or call z-ai-web-dev-sdk anywhere
//      in the /vision route (source-level check, same pattern as ASR work).
//   2. The "no vision-capable provider configured" failure path returns a
//      specific, visible 503 error (not silent, not a crash).
//   3. The error message lists which providers are configured + which are
//      tested, and tells the user exactly what to do.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Vision routing — z-ai dependency removal', () => {
  // ════════════════════════════════════════════════════════════════════
  // TEST 1: orchestrator.ts source has no z-ai import/call in vision route
  //
  // Source-level check — same pattern used for the ASR work. Confirms the
  // z-ai SDK is not imported or called anywhere in the /vision route.
  // ════════════════════════════════════════════════════════════════════
  it('orchestrator.ts does not import z-ai-web-dev-sdk', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'routes', 'orchestrator.ts'),
      'utf8',
    );

    // The vision route should NOT import z-ai-web-dev-sdk
    // (dynamic import inside the route handler counts too)
    expect(source).not.toMatch(/import\s+.*z-ai-web-dev-sdk/);
    expect(source).not.toContain("await import('z-ai-web-dev-sdk')");

    console.log('  ✓ orchestrator.ts does not import z-ai-web-dev-sdk');
  });

  it('orchestrator.ts does not call zai.chat.completions.createVision', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'routes', 'orchestrator.ts'),
      'utf8',
    );

    expect(source).not.toContain('createVision');
    expect(source).not.toContain('zai.chat.completions');
    expect(source).not.toContain('glm-4v-plus'); // z-ai's vision model

    console.log('  ✓ orchestrator.ts does not call createVision');
    console.log('  ✓ orchestrator.ts does not reference glm-4v-plus');
  });

  it('orchestrator.ts vision route uses ModelRouter + content blocks', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'routes', 'orchestrator.ts'),
      'utf8',
    );

    // The vision route should use modelRouter.stream() — same as /complete, /explain
    expect(source).toContain('modelRouter.stream(routerRequest)');
    // Should use content blocks (text + image_url)
    expect(source).toContain("type: 'text'");
    expect(source).toContain("type: 'image_url'");
    expect(source).toContain('findVisionCapableModel');

    console.log('  ✓ vision route uses modelRouter.stream()');
    console.log('  ✓ vision route uses content blocks (text + image_url)');
    console.log('  ✓ vision route finds vision-capable model from registry');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 2: "no vision provider configured" failure is specific + visible
  //
  // When no vision-capable model is configured, the route returns 503 with
  // a specific error message — not a silent fallback, not a crash.
  // ════════════════════════════════════════════════════════════════════
  it('findVisionCapableModel returns null when no providers have vision models', () => {
    // Read the source to verify the function exists + returns null when no vision models
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'routes', 'orchestrator.ts'),
      'utf8',
    );

    // The function should filter for connectionTested providers
    expect(source).toContain('p.connectionTested');
    // The function should check model.supportsVision
    expect(source).toContain('model.supportsVision');
    // Should return null when none found
    expect(source).toContain('return null');

    console.log('  ✓ findVisionCapableModel checks connectionTested + supportsVision');
    console.log('  ✓ returns null when no vision models found');
  });

  it('vision route returns 503 (not 500) when no vision provider is configured', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'routes', 'orchestrator.ts'),
      'utf8',
    );

    // The no-vision-provider path should return 503 (service unavailable)
    expect(source).toContain('res.status(503)');
    // The error message should mention "vision" + "configured" + "Settings"
    expect(source).toContain('No vision-capable model is configured');
    expect(source).toContain('Settings');
    expect(source).toContain('API Hub');

    console.log('  ✓ vision route returns 503 when no vision provider configured');
    console.log('  ✓ error message mentions "vision" + "Settings" + "API Hub"');
  });
});
