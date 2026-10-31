// server/src/skills/importer.ts
// Skill importer — fetches SKILL.md files from GitHub repos and converts
// them to Code Siren's TOML format.
//
// The repos use a "prompt-based" skill format (SKILL.md with YAML
// frontmatter), while Code Siren uses "tool-sequence" TOML skills. This
// importer converts the prompt-based skills to a TOML manifest that wraps
// the markdown prompt as a single "ai-prompt" step — the AI receives the
// skill's instructions and follows them.

import { loadSkill } from './manifest.js';
import { installSkill, listInstalledSkills } from './executor.js';

export interface GitHubSkillSource {
  repo: string;        // e.g. 'charlie947/social-media-skills'
  branch: string;     // e.g. 'main'
  skillDir: string;   // e.g. 'skills/post-writer' or 'leanrea'
}

export interface ImportedSkill {
  name: string;
  description: string;
  source: string;
  installed: boolean;
}

/**
 * Fetch a SKILL.md file from a GitHub repo and convert it to a TOML manifest.
 * Returns the installed skill name, or throws on error.
 */
export async function importSkillFromGitHub(source: GitHubSkillSource): Promise<ImportedSkill> {
  const rawUrl = `https://raw.githubusercontent.com/${source.repo}/${source.branch}/${source.skillDir}/SKILL.md`;
  const res = await fetch(rawUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${rawUrl}: ${res.status} ${res.statusText}`);
  }
  const markdown = await res.text();

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
    //   2. description: >
    //        multi-line folded
    //   3. description: single line no quotes
    const descLineMatch = yaml.match(/^description:\s*(.*)$/m);
    if (descLineMatch) {
      const descValue = descLineMatch[1].trim();
      if (descValue === '>' || descValue === '|' || descValue === '' ) {
        // Multi-line folded/literal — collect subsequent indented lines
        const yamlLines = yaml.split('\n');
        const descLineIdx = yamlLines.findIndex((l) => l.match(/^description:/));
        const collected: string[] = [];
        for (let i = descLineIdx + 1; i < yamlLines.length; i++) {
          const line = yamlLines[i];
          // Stop at unindented line (next field)
          if (line.match(/^[^\s]/) || line.trim() === '') break;
          collected.push(line.trim());
        }
        description = collected.join(' ').replace(/['"]/g, '');
      } else {
        // Single line (with or without quotes)
        description = descValue.replace(/^['"]|['"]$/g, '');
      }
      if (description.length > 200) description = description.slice(0, 197) + '...';
    }
  }

  // Convert to TOML manifest format.
  // The skill wraps the markdown prompt as a single "ai-prompt" step.
  // The AI receives the skill's instructions and follows them.
  //
  // The arguments_template is a JSON string inside a TOML double-quoted string.
  // We need to escape for BOTH layers:
  //   1. TOML: backslash → \\, double-quote → \", newline → \\n (literal backslash-n)
  //   2. JSON: the instructions value is a JSON string, so internal double-quotes
  //      must be escaped as \", and backslashes as \\
  //
  // The safest approach: use TOML triple-quoted strings (multiline) which
  // don't require escaping double-quotes. The JSON arguments_template goes
  // inside a TOML triple-quoted string.
  //
  // But @iarna/toml (our TOML parser) may not handle triple-quoted strings
  // well with complex content. Instead, we use a different approach:
  // store the instructions as a base64-encoded string to avoid ALL escaping
  // issues. The ai-prompt tool decodes it at execution time.
  const instructionsB64 = Buffer.from(markdown).toString('base64');
  const toml = `# ${name}
# Imported from https://github.com/${source.repo}
# Converted from SKILL.md (prompt-based) to TOML (tool-sequence)
# Instructions are base64-encoded to avoid TOML/JSON escaping issues.

name = "${name}"
version = "1.0.0"
description = "${description}"
author = "imported-from-${source.repo}"
required_capabilities = ["ai-prompt"]

[[steps]]
tool_name = "ai-prompt"
arguments_template = '{"instructions_b64": "${instructionsB64}"}'
output_key = "result"
`;

  // Load + install
  const manifest = loadSkill(toml);
  installSkill(manifest);

  return {
    name,
    description,
    source: `https://github.com/${source.repo}/tree/${source.branch}/${source.skillDir}`,
    installed: true,
  };
}

/**
 * Import multiple skills from a GitHub repo.
 * Fetches the contents of the skills/ directory and imports each subdirectory.
 */
export async function importSkillsFromRepo(repo: string, branch: string = 'main'): Promise<ImportedSkill[]> {
  const apiUrl = `https://api.github.com/repos/${repo}/contents/skills`;
  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': 'code-siren' },
  });
  if (!res.ok) {
    throw new Error(`Failed to list skills in ${repo}: ${res.status}`);
  }
  const contents = await res.json() as Array<{ name: string; type: string }>;
  const skillDirs = contents.filter((c) => c.type === 'dir').map((c) => c.name);

  const results: ImportedSkill[] = [];
  for (const skillName of skillDirs) {
    try {
      const imported = await importSkillFromGitHub({
        repo,
        branch,
        skillDir: `skills/${skillName}`,
      });
      results.push(imported);
    } catch (err) {
      console.warn(`[skills:importer] failed to import ${skillName} from ${repo}: ${(err as Error).message}`);
    }
  }
  return results;
}

// ── Curated skill list ────────────────────────────────────────────────
// A hand-picked selection of the most useful skills from Morgan's 5 repos.
// Not all 314 skills from repo 2 are included — just the ones most relevant
// to Code Siren's use case (coding, debugging, architecture, security, docs).
export const CURATED_SKILLS: GitHubSkillSource[] = [
  // Repo 1: paperclipai/paperclip (9 skills — import all)
  { repo: 'paperclipai/paperclip', branch: 'main', skillDir: 'skills/agentmail' },
  { repo: 'paperclipai/paperclip', branch: 'main', skillDir: 'skills/complain' },
  { repo: 'paperclipai/paperclip', branch: 'main', skillDir: 'skills/paperclip-board' },
  { repo: 'paperclipai/paperclip', branch: 'main', skillDir: 'skills/paperclip-converting-plans-to-tasks' },
  { repo: 'paperclipai/paperclip', branch: 'main', skillDir: 'skills/paperclip-create-agent' },
  { repo: 'paperclipai/paperclip', branch: 'main', skillDir: 'skills/paperclip' },
  { repo: 'paperclipai/paperclip', branch: 'main', skillDir: 'skills/para-memory-files' },
  { repo: 'paperclipai/paperclip', branch: 'main', skillDir: 'skills/slack' },
  { repo: 'paperclipai/paperclip', branch: 'main', skillDir: 'skills/suggestion-box' },

  // Repo 2: affaan-m/ECC (314 skills — import the 20 most useful for Code Siren)
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/api-design' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/architecture-decision-records' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/article-writing' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/backend-patterns' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/brand-discovery' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/coding-standards' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/competitive-platform-analysis' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/deep-research' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/docs-governance' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/documentation-lookup' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/agent-security-hardening' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/agent-self-evaluation' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/accessibility' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/angular-developer' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/api-connector-builder' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/agent-architecture-audit' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/ai-regression-testing' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/content-engine' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/crosspost' },
  { repo: 'affaan-m/ECC', branch: 'main', skillDir: 'skills/context-and-decisions' },

  // Repo 3: kaankiziltug/logo-design-skill (1 skill)
  { repo: 'kaankiziltug/logo-design-skill', branch: 'main', skillDir: 'skills/logo-design' },

  // Repo 4: aicodeking/leanrea (1 skill — at leanrea/SKILL.md, not skills/)
  { repo: 'aicodeking/leanrea', branch: 'main', skillDir: 'leanrea' },

  // Repo 5: charlie947/social-media-skills (17 skills — import all)
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/analytics-dashboard' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/content-matrix' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/gemini-carousel' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/gemini-infographic' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/graphic-designer' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/hook-generator' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/newsletter-voice' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/niche-research' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/pinned-comment' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/post-formatter' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/post-scorer' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/post-writer' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/profile-optimizer' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/quote-post' },
  { repo: 'charlie947/social-media-skills', branch: 'main', skillDir: 'skills/reels-scripting' },
];

/**
 * Import the curated skill list at server boot.
 * Called from src/index.ts during startup. Safe to call multiple times —
 * installSkill() overwrites by name. Network calls are made in parallel
 * for speed. Failures are logged but don't block server startup.
 */
export async function importCuratedSkills(): Promise<{ installed: number; failed: number; total: number }> {
  console.log(`[skills:importer] importing ${CURATED_SKILLS.length} curated skills from GitHub...`);
  let installed = 0;
  let failed = 0;

  // Import in parallel batches of 5 to avoid rate limiting
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
 * Get the list of currently installed skill names.
 */
export function getInstalledSkillNames(): string[] {
  return listInstalledSkills().map((s: { name: string }) => s.name);
}
