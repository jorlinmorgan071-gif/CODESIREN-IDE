// server/tests/unit/skills-vendored.test.ts
// Step 2a — Skills vendoring + paperclip 404 root-cause fix.
//
// Covers:
//   1. Boot loads vendored skills offline (no network); installed count equals
//      the vendored (kept) count from MANIFEST.json.
//   2. Only `para-memory-files` of the 9 paperclip skills is vendored; the 8
//      Paperclip-platform-specific skills are not installed.
//   3. The paperclip 404 root-cause fix: importSkillFromGitHub fetches raw/HEAD
//      (not raw/<branch>), so a repo whose default branch is `master` works.
//   4. installSkillFromMarkdown converts + installs without any network.
//   5. importSkillsFromRepo surfaces per-skill failures (not swallowed) so the
//      POST /api/skills/import response can report them.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadVendoredSkills,
  importSkillFromGitHub,
  installSkillFromMarkdown,
  importSkillsFromRepo,
} from '../../src/skills/importer.js';
import { clearInstalledSkills, listInstalledSkills } from '../../src/skills/executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDORED_DIR = join(__dirname, '../../src/skills/vendored');

function readManifest() {
  return JSON.parse(readFileSync(join(VENDORED_DIR, 'MANIFEST.json'), 'utf8')) as {
    skills: Array<{ repo: string; skillDir: string; skillName: string; kept: boolean; dropReason?: string }>;
    summary: { totalCurated: number; kept: number; dropped: number };
  };
}

describe('vendored skills — offline boot load', () => {
  beforeEach(() => clearInstalledSkills());

  test('loadVendoredSkills installs every kept skill from the repo, no network', () => {
    const result = loadVendoredSkills(VENDORED_DIR);

    // No failures, and installed == total kept == installed-store count.
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.installed).toBe(result.total);
    expect(listInstalledSkills().length).toBe(result.installed);

    // installed count equals the vendored (kept) count recorded in MANIFEST.json
    const manifest = readManifest();
    expect(result.installed).toBe(manifest.summary.kept);
    expect(result.total).toBe(manifest.summary.kept);
  });

  test('only para-memory-files of the 9 paperclip skills is vendored', () => {
    loadVendoredSkills(VENDORED_DIR);
    const names = listInstalledSkills().map((s) => s.name);

    expect(names).toContain('para-memory-files');

    // The 8 Paperclip-platform-specific skills are NOT installed.
    const dropped = [
      'agentmail',
      'complain',
      'paperclip-board',
      'paperclip-converting-plans-to-tasks',
      'paperclip-create-agent',
      'paperclip',
      'slack',
      'suggestion-box',
    ];
    for (const name of dropped) {
      expect(names).not.toContain(name);
    }
  });

  test('every kept MANIFEST entry has its SKILL.md on disk and parses', () => {
    // loadVendoredSkills already proved this (failed === 0), but assert the
    // invariant explicitly: kept count in manifest == installed count in store.
    const manifest = readManifest();
    const keptEntries = manifest.skills.filter((s) => s.kept);
    loadVendoredSkills(VENDORED_DIR);
    expect(listInstalledSkills().length).toBeGreaterThanOrEqual(keptEntries.length);
    // exactly the kept count (store was cleared first)
    expect(listInstalledSkills().length).toBe(keptEntries.length);
  });
});

describe('paperclip 404 root-cause fix — HEAD in the raw URL', () => {
  beforeEach(() => clearInstalledSkills());
  afterEach(() => vi.unstubAllGlobals());

  test('importSkillFromGitHub fetches raw/HEAD (not raw/main), so paperclip (default master) does not 404', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (url: string) => {
        fetched.push(url);
        return new Response(
          '---\nname: para-memory-files\ndescription: a memory skill\n---\n# body\n',
          { status: 200 },
        );
      },
    );

    // branch is intentionally 'main' — the old hardcoded value that 404'd
    // paperclip. The fix must fetch HEAD regardless of this field.
    await importSkillFromGitHub({
      repo: 'paperclipai/paperclip',
      branch: 'main',
      skillDir: 'skills/para-memory-files',
    });

    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toBe(
      'https://raw.githubusercontent.com/paperclipai/paperclip/HEAD/skills/para-memory-files/SKILL.md',
    );
    expect(fetched[0]).not.toContain('/main/');
  });

  test('a 404 on the raw URL throws a clear error mentioning the URL + status', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );
    await expect(
      importSkillFromGitHub({ repo: 'some/repo', branch: 'main', skillDir: 'skills/x' }),
    ).rejects.toThrow(/Failed to fetch.*404/);
  });
});

describe('installSkillFromMarkdown — offline conversion', () => {
  beforeEach(() => clearInstalledSkills());

  test('converts a SKILL.md to a TOML skill and installs it without any network', () => {
    const md =
      '---\nname: my-vendored-skill\ndescription: "does a useful thing"\n---\n# My Skill\n\nFollow these steps.\n';
    const result = installSkillFromMarkdown(
      { repo: 'some/repo', branch: 'HEAD', skillDir: 'skills/my-vendored-skill' },
      md,
    );
    expect(result.installed).toBe(true);
    expect(result.name).toBe('my-vendored-skill');
    expect(result.source).toContain('/tree/HEAD/');
    expect(listInstalledSkills().some((s) => s.name === 'my-vendored-skill')).toBe(true);
  });

  test('a description containing a double-quote does not break TOML parsing', () => {
    const md =
      '---\nname: quote-skill\ndescription: she said "hello" then left\n---\nbody\n';
    const result = installSkillFromMarkdown(
      { repo: 'some/repo', branch: 'HEAD', skillDir: 'skills/quote-skill' },
      md,
    );
    expect(result.installed).toBe(true);
    expect(result.description).toContain('hello');
  });
});

describe('importSkillsFromRepo — failure visibility', () => {
  beforeEach(() => clearInstalledSkills());
  afterEach(() => vi.unstubAllGlobals());

  test('per-skill failures are collected (not swallowed) and surfaced in the result', async () => {
    vi.stubGlobal(
      'fetch',
      async (url: string) => {
        // GitHub contents API listing
        if (url.startsWith('https://api.github.com/')) {
          return new Response(
            JSON.stringify([
              { name: 'good-one', type: 'dir' },
              { name: 'broken-one', type: 'dir' },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // raw URLs: 200 for good-one, 404 for broken-one
        if (url.includes('/good-one/')) {
          return new Response('---\nname: good-one\ndescription: ok\n---\nbody\n', { status: 200 });
        }
        return new Response('Not Found', { status: 404, statusText: 'Not Found' });
      },
    );

    const result = await importSkillsFromRepo('some/repo', 'HEAD');

    expect(result.total).toBe(2);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].name).toBe('good-one');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe('broken-one');
    expect(result.failed[0].error).toMatch(/404/);
  });

  test('a repo whose contents listing fails throws (surfaces in the API 500)', async () => {
    vi.stubGlobal(
      'fetch',
      async (url: string) => {
        if (url.startsWith('https://api.github.com/')) {
          return new Response('Not Found', { status: 404 });
        }
        return new Response('', { status: 200 });
      },
    );
    await expect(importSkillsFromRepo('no-such/repo')).rejects.toThrow(/Failed to list skills.*404/);
  });
});
