// server/src/orchestrator/parse.ts
// Helpers for extracting strict JSON from LLM responses.
//
// Both Gemini Flash and NVIDIA Nemotron are instructed to "Output ONLY
// valid JSON" but in practice both sometimes wrap the response in
// markdown fences (```json ... ```) or prepend a sentence. This module
// extracts the JSON body reliably.

export function extractJson<T = unknown>(text: string): T {
  const trimmed = text.trim();

  // Case 1: ```json\n{...}\n``` (or ```{...}```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    const candidate = fenceMatch[1].trim();
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // fall through
    }
  }

  // Case 2: the whole string is JSON
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }

  // Case 3: find the first { ... } block (greedy outermost)
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // fall through
    }
  }

  throw new Error(`extractJson: could not parse JSON from response. First 200 chars: ${trimmed.slice(0, 200)}`);
}

// ── Plan validation ──────────────────────────────────────────────────────

export interface ParsedPlan {
  projectName: string;
  summary: string;
  techStack: string[];
  milestones: Array<{
    id: string;
    title: string;
    description: string;
    assignedAgent: string;
    dependsOn: string[];
    acceptanceCriteria: string[];
  }>;
}

export function validatePlan(parsed: unknown): ParsedPlan {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('validatePlan: response is not an object');
  }
  const obj = parsed as Record<string, unknown>;

  const projectName = typeof obj.projectName === 'string' ? obj.projectName : '';
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const techStack = Array.isArray(obj.techStack)
    ? obj.techStack.filter((s): s is string => typeof s === 'string')
    : [];
  const milestonesRaw = Array.isArray(obj.milestones) ? obj.milestones : [];

  if (!projectName) throw new Error('validatePlan: projectName missing');
  if (milestonesRaw.length === 0) throw new Error('validatePlan: milestones array is empty');

  const milestones = milestonesRaw.map((m, i) => {
    if (typeof m !== 'object' || m === null) {
      throw new Error(`validatePlan: milestone[${i}] is not an object`);
    }
    const mo = m as Record<string, unknown>;
    return {
      id: typeof mo.id === 'string' ? mo.id : `M${String(i + 1).padStart(2, '0')}`,
      title: typeof mo.title === 'string' ? mo.title : `Milestone ${i + 1}`,
      description: typeof mo.description === 'string' ? mo.description : '',
      assignedAgent: typeof mo.assignedAgent === 'string' ? mo.assignedAgent : 'architect-agent',
      dependsOn: Array.isArray(mo.dependsOn)
        ? mo.dependsOn.filter((s): s is string => typeof s === 'string')
        : [],
      acceptanceCriteria: Array.isArray(mo.acceptanceCriteria)
        ? mo.acceptanceCriteria.filter((s): s is string => typeof s === 'string')
        : [],
    };
  });

  return { projectName, summary, techStack, milestones };
}

// ── Review decision validation ───────────────────────────────────────────

export interface ParsedReviewDecision {
  approved: boolean;
  summary: string;
  issues: string[];
  corrections: string;
}

export function validateReviewDecision(parsed: unknown): ParsedReviewDecision {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('validateReviewDecision: response is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  return {
    approved: !!obj.approved,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    issues: Array.isArray(obj.issues)
      ? obj.issues.filter((s): s is string => typeof s === 'string')
      : [],
    corrections: typeof obj.corrections === 'string' ? obj.corrections : '',
  };
}
