// server/src/skills/importer.ts
// Skill importer — converts prompt-based SKILL.md files (YAML frontmatter +
// markdown body) from upstream GitHub repos into Code Siren's TOML skill format.
//
// Two load paths:
//   1. loadVendoredSkills() — BOOT path. Reads vendored SKILL.md files checked
//      into the repo under server/src/skills/vendored/ (pinned to upstream
//      commit SHAs in MANIFEST.json). NO network at boot.
//   2. importSkillsFromRepo(repo) — explicit refresh via POST /api/skills/import.
//      Fetches a repo's skills/ directory over the network. Raw URLs use HEAD
//      so a repo's default branch is used regardless of whether it is `main`
//      or `master` — paperclipai/paperclip's default branch is `master`, so the
//      old hardcoded `main` made every paperclip raw URL 404.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill } from './manifest.js';
import { installSkill, listInstalledSkills } from './executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDORED_DIR = join(__dirname, 'vendored');

export interface GitHubSkillSource {
  repo: string;        // e.g. 'charlie947/social-media-skills'
  branch: string;     // informational; the raw fetch always uses HEAD
  skillDir: string;   // e.g. 'skills/post-writer' or 'leanrea'
}

export interface ImportedSkill {
  name: string;
  description: string;
  source: string;
  installed: boolean;
}

export interface ImportFailure {
  name: string;
  error: string;
}

export interface ImportRepoResult {
  imported: ImportedSkill[];
  failed: ImportFailure[];
  total: number;
}

export interface VendoredLoadResult {
  installed: number;
  failed: number;
  total: number;
  errors: string[];
}

interface VendoredManifestEntry {
  repo: string;
  skillDir: string;
  skillName: string;
  kept: boolean;
  dropReason?: string;
}

interface VendoredManifest {
  skills: VendoredManifestEntry[];
}

/**
 * Convert a prompt-based SKILL.md (YAML frontmatter + markdown body) into a
 * Code Siren TOML manifest and install it. Shared by the network import path
 * and the offline vendored load path so both produce identical skills.
 *
 * The markdown body is base64-encoded into a single "ai-prompt" step's
 * arguments_template to avoid TOML/JSON escaping issues; the ai-prompt tool
 * decodes it at execution time.
 */
export function installSkillFromMarkdown(source: GitHubSkillSource, markdown: string): ImportedSkill {
  // Parse YAML frontmatter (between --- markers)
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  let name = source.skillDir.split('/').pop() ?? 'imported-skill';
  let description = `Imported from ${source.repo}`;

  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1];
    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim().replace(/['"]/g, '');

    // Parse description — handles 3 YAML formats:
    //   1. description: "single line"
    //   2. description: >  (or |) multi-line folded/literal
    //   3. description: single line no quotes
    const descLineMatch = yaml.match(/^description:\s*(.*)$/m);
    if (descLineMatch) {
      const descValue = descLineMatch[1].trim();
      if (descValue === '>' || descValue === '|' || descValue === '') {
        const yamlLines = yaml.split('\n');
        const descLineIdx = yamlLines.findIndex((l) => l.match(/^description:/));
        const collected: string[] = [];
        for (let i = descLineIdx + 1; i < yamlLines.length; i++) {
          const line = yamlLines[i];
          if (line.match(/^[^\s]/) || line.trim() === '') break;
          collected.push(line.trim());
        }
        description = collected.join(' ').replace(/['"]/g, '');
      } else {
        description = descValue.replace(/^['"]|['"]$/g, '');
      }
      if (description.length > 200) description = description.slice(0, 197) + '...';
    }
  }

  // Escape the description for a TOML double-quoted string so internal quotes
  // or backslashes do not break loadSkill() parsing.
  const descriptionEscaped = description.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const instructionsB64 = Buffer.from(markdown).toString('base64');
  const toml = `# ${name}
# Imported from https://github.com/${source.repo}
# Converted from SKILL.md (prompt-based) to TOML (tool-sequence)
# Instructions are base64-encoded to avoid TOML/JSON escaping issues.

name = "${name}"
version = "1.0.0"
description = "${descriptionEscaped}"
author = "imported-from-${source.repo}"
required_capabilities = ["ai-prompt"]

[[steps]]
tool_name = "ai-prompt"
arguments_template = '{"instructions_b64": "${instructionsB64}"}'
output_key = "result"
`;

  const manifest = loadSkill(toml);
  installSkill(manifest);

  return {
    name,
    description,
    source: `https://github.com/${source.repo}/tree/HEAD/${source.skillDir}`,
    installed: true,
  };
}

/**
 * Fetch a SKILL.md from a GitHub repo and install it. The raw URL uses HEAD so
 * the repo's default branch is used regardless of its name — fixes the
 * paperclipai/paperclip 404s (default branch is `master`, the curated list
 * used to hardcode `main`).
 */
export async function importSkillFromGitHub(source: GitHubSkillSource): Promise<ImportedSkill> {
  const rawUrl = `https://raw.githubusercontent.com/${source.repo}/HEAD/${source.skillDir}/SKILL.md`;
  const res = await fetch(rawUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${rawUrl}: ${res.status} ${res.statusText}`);
  }
  const markdown = await res.text();
  return installSkillFromMarkdown(source, markdown);
}

/**
 * Import all skills from a GitHub repo's skills/ directory over the network.
 * Per-skill failures are COLLECTED (not swallowed) so the POST /api/skills/import
 * response can surface them. This is the explicit refresh path — boot does not
 * call it.
 */
export async function importSkillsFromRepo(repo: string, branch: string = 'HEAD'): Promise<ImportRepoResult> {
  const apiUrl = `https://api.github.com/repos/${repo}/contents/skills`;
  const res = await fetch(apiUrl, { headers: { 'User-Agent': 'code-siren' } });
  if (!res.ok) {
    throw new Error(`Failed to list skills in ${repo}: ${res.status}`);
  }
  const contents = await res.json() as Array<{ name: string; type: string }>;
  const skillDirs = contents.filter((c) => c.type === 'dir').map((c) => c.name);

  const imported: ImportedSkill[] = [];
  const failed: ImportFailure[] = [];
  for (const skillName of skillDirs) {
    try {
      const result = await importSkillFromGitHub({ repo, branch, skillDir: `skills/${skillName}` });
      imported.push(result);
      console.log(`[skills:importer] ✓ imported: ${result.name}`);
    } catch (err) {
      const msg = (err as Error).message;
      failed.push({ name: skillName, error: msg });
      console.warn(`[skills:importer] ✗ failed to import ${skillName} from ${repo}: ${msg}`);
    }
  }
  return { imported, failed, total: skillDirs.length };
}

// ── Curated skill list (historical; now realized as vendored files) ────
// The curated set is vendored into server/src/skills/vendored/ and loaded
// offline at boot by loadVendoredSkills(). This list is kept for reference and
// for an explicit full curated refresh over the network if ever needed. branch
// is 'HEAD' for every entry (the raw fetch ignores it and uses HEAD anyway).
export const CURATED_SKILLS: GitHubSkillSource[] = [
  // Repo 1: paperclipai/paperclip (default branch is `master` — 9 skills)
  { repo: 'paperclipai/paperclip', branch: 'HEAD', skillDir: 'skills/agentmail' },
  { repo: 'paperclipai/paperclip', branch: 'HEAD', skillDir: 'skills/complain' },
  { repo: 'paperclipai/paperclip', branch: 'HEAD', skillDir: 'skills/paperclip-board' },
  { repo: 'paperclipai/paperclip', branch: 'HEAD', skillDir: 'skills/paperclip-converting-plans-to-tasks' },
  { repo: 'paperclipai/paperclip', branch: 'HEAD', skillDir: 'skills/paperclip-create-agent' },
  { repo: 'paperclipai/paperclip', branch: 'HEAD', skillDir: 'skills/paperclip' },
  { repo: 'paperclipai/paperclip', branch: 'HEAD', skillDir: 'skills/para-memory-files' },
  { repo: 'paperclipai/paperclip', branch: 'HEAD', skillDir: 'skills/slack' },
  { repo: 'paperclipai/paperclip', branch: 'HEAD', skillDir: 'skills/suggestion-box' },

  // Repo 2: affaan-m/ECC (20 most useful for Code Siren)
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/api-design' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/architecture-decision-records' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/article-writing' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/backend-patterns' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/brand-discovery' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/coding-standards' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/competitive-platform-analysis' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/deep-research' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/docs-governance' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/documentation-lookup' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/agent-security-hardening' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/agent-self-evaluation' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/accessibility' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/angular-developer' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/api-connector-builder' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/agent-architecture-audit' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/ai-regression-testing' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/content-engine' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/crosspost' },
  { repo: 'affaan-m/ECC', branch: 'HEAD', skillDir: 'skills/context-and-decisions' },

  // Repo 3: kaankiziltug/logo-design-skill (1 skill)
  { repo: 'kaankiziltug/logo-design-skill', branch: 'HEAD', skillDir: 'skills/logo-design' },

  // Repo 4: aicodeking/leanrea (1 skill — at leanrea/SKILL.md, not skills/)
  { repo: 'aicodeking/leanrea', branch: 'HEAD', skillDir: 'leanrea' },

  // Repo 5: charlie947/social-media-skills (15 skills)
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/analytics-dashboard' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/content-matrix' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/gemini-carousel' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/gemini-infographic' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/graphic-designer' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/hook-generator' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/newsletter-voice' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/niche-research' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/pinned-comment' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/post-formatter' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/post-scorer' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/post-writer' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/profile-optimizer' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/quote-post' },
  { repo: 'charlie947/social-media-skills', branch: 'HEAD', skillDir: 'skills/reels-scripting' },
];

/**
 * Import the curated skill list over the network. NOT called at boot — boot
 * uses loadVendoredSkills(). Kept for an explicit full curated refresh.
 */
export async function importCuratedSkills(): Promise<{ installed: number; failed: number; total: number }> {
  console.log(`[skills:importer] importing ${CURATED_SKILLS.length} curated skills from GitHub...`);
  let installed = 0;
  let failed = 0;

  const batchSize = 5;
  for (let i = 0; i < CURATED_SKILLS.length; i += batchSize) {
    const batch = CURATED_SKILLS.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((source) => importSkillFromGitHub(source))
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        installed++;
        console.log(`[skills:importer] ✓ imported: ${result.value.name}`);
      } else {
        failed++;
        console.warn(`[skills:importer] ✗ failed: ${result.reason?.message ?? 'unknown error'}`);
      }
    }
  }

  console.log(`[skills:importer] done: ${installed} imported, ${failed} failed, ${CURATED_SKILLS.length} total`);
  return { installed, failed, total: CURATED_SKILLS.length };
}

/**
 * Load vendored upstream skills from the repo (offline — NO network). Reads
 * MANIFEST.json and installs every `kept: true` skill via installSkillFromMarkdown.
 * This is the boot path. Safe to call multiple times — installSkill() overwrites.
 *
 * Failures (a missing or malformed vendored SKILL.md) are collected into
 * `errors` and counted in `failed` rather than aborting the whole load, so the
 * server still boots with the skills that did parse.
 */
export function loadVendoredSkills(vendoredDir: string = VENDORED_DIR): VendoredLoadResult {
  const manifestPath = join(vendoredDir, 'MANIFEST.json');
  const installed: string[] = [];
  const errors: string[] = [];

  if (!existsSync(manifestPath)) {
    const msg = `vendored MANIFEST.json not found at ${manifestPath}`;
    console.warn(`[skills:vendored] ${msg}`);
    return { installed: 0, failed: 0, total: 0, errors: [msg] };
  }

  let manifest: VendoredManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    const msg = `failed to parse MANIFEST.json: ${(err as Error).message}`;
    console.warn(`[skills:vendored] ${msg}`);
    return { installed: 0, failed: 0, total: 0, errors: [msg] };
  }

  const kept = manifest.skills.filter((s) => s.kept);
  let failed = 0;
  for (const entry of kept) {
    const skillMdPath = join(vendoredDir, entry.repo, entry.skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      failed++;
      errors.push(`${entry.repo}/${entry.skillDir}: SKILL.md not found at ${skillMdPath}`);
      console.warn(`[skills:vendored] ✗ missing: ${entry.repo}/${entry.skillDir}`);
      continue;
    }
    try {
      const markdown = readFileSync(skillMdPath, 'utf8');
      const result = installSkillFromMarkdown(
        { repo: entry.repo, branch: 'HEAD', skillDir: entry.skillDir },
        markdown,
      );
      installed.push(result.name);
      console.log(`[skills:vendored] ✓ installed '${result.name}' from ${entry.repo}/${entry.skillDir}`);
    } catch (err) {
      failed++;
      errors.push(`${entry.repo}/${entry.skillDir}: ${(err as Error).message}`);
      console.warn(`[skills:vendored] ✗ failed: ${entry.repo}/${entry.skillDir}: ${(err as Error).message}`);
    }
  }

  console.log(`[skills:vendored] loaded ${installed.length} skill(s), ${failed} failed, ${kept.length} total kept`);
  return { installed: installed.length, failed, total: kept.length, errors };
}

/**
 * Get the list of currently installed skill names.
 */
export function getInstalledSkillNames(): string[] {
  return listInstalledSkills().map((s: { name: string }) => s.name);
}
