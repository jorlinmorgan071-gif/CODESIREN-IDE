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
  skillDir: string;   // e.g. 'skills/post-writer'
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
    const descMatch = yaml.match(/^description:\s*>??\s*([\s\S]*?)(?=\n[a-z]|\n---|$)/im);
    if (nameMatch) name = nameMatch[1].trim().replace(/['"]/g, '');
    if (descMatch) {
      // Clean up multi-line descriptions
      description = descMatch[1].trim().replace(/\n\s+/g, ' ').replace(/['"]/g, '');
      if (description.length > 200) description = description.slice(0, 197) + '...';
    }
  }

  // Convert to TOML manifest format
  // The skill wraps the markdown prompt as a single "ai-prompt" step.
  // The AI receives the skill's instructions and follows them.
  const escapedMarkdown = markdown.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const toml = `# ${name}
# Imported from https://github.com/${source.repo}
# Converted from SKILL.md (prompt-based) to TOML (tool-sequence)

name = "${name}"
version = "1.0.0"
description = "${description}"
author = "imported-from-${source.repo}"
required_capabilities = ["ai-prompt"]

[[steps]]
tool_name = "ai-prompt"
arguments_template = '{"instructions": "${escapedMarkdown}"}'
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

/**
 * Get the list of currently installed skill names.
 */
export function getInstalledSkillNames(): string[] {
  return listInstalledSkills().map((s: { name: string }) => s.name);
}
