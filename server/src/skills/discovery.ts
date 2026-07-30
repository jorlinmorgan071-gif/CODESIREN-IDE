// server/src/skills/discovery.ts
// Skill discovery — mine recurring tool sequences from traces.
//
// Port of the donor's skill_discovery.rs algorithm:
//   - For each trace, look at the ordered list of tool names called.
//   - For each subsequence of length [minLen..maxLen], accumulate frequency + outcomes.
//   - Keep subsequences with frequency >= minFrequency AND avg_outcome >= minOutcome.
//   - Sort by (frequency * avg_outcome) descending.
//
// Per user instruction (Step 3 condition): the discovery run itself is logged
// into the SAME trace format as agent runs — agentId='skill-discovery',
// executionMode='single-shot'. Every candidate sequence mined is a trace step;
// every kept/skipped decision is recorded. The resulting DiscoveredSkill[] is
// written to the trace's toolResults so it's inspectable via /api/traces/:taskId.

import { readFileSync, existsSync } from 'node:fs';
import { v4 as uuid } from 'uuid';
import type { AgentRunTrace } from '../observability/traces.js';
import {
  startTrace,
  addStep,
  completeTrace,
  setOutcome,
} from '../observability/traces.js';
import { getTracesFile } from '../observability/traces.js';
import { installSkill } from './executor.js';
import type { SkillManifest } from './manifest.js';

export interface DiscoveredSkill {
  name: string;
  description: string;
  tool_sequence: string[];
  frequency: number;
  avg_outcome: number;
  example_inputs: string[];
}

export interface DiscoveryConfig {
  minFrequency: number;
  minSequenceLength: number;
  maxSequenceLength: number;
  minOutcome: number;
}

const DEFAULT_CONFIG: DiscoveryConfig = {
  minFrequency: 2,
  minSequenceLength: 2,
  maxSequenceLength: 4,
  minOutcome: 0.5,
};

interface SeqAccum {
  outcomes: number[];
  inputs: string[];
}

/**
 * Run skill discovery over the trace file.
 *
 * Returns the discovered skills AND the traceId of the discovery run, so the
 * caller (or the /api/skills/discover route) can point the user at the inspectable trace.
 */
export async function discoverSkills(
  config: Partial<DiscoveryConfig> = {},
): Promise<{ discovered: DiscoveredSkill[]; traceId: string }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const traceId = uuid();

  // Start the discovery trace — same shape as any agent run.
  startTrace({
    taskId: traceId,
    agentId: 'skill-discovery',
    domain: 'EXTENSION',  // discovery is an Extension-Agent-adjacent capability
    executionMode: 'single-shot',
    input: `discoverSkills(minFreq=${cfg.minFrequency}, minLen=${cfg.minSequenceLength}, maxLen=${cfg.maxSequenceLength}, minOutcome=${cfg.minOutcome})`,
  });

  const file = getTracesFile();
  if (!existsSync(file)) {
    addStep(traceId, {
      kind: 'error',
      label: `trace file not found: ${file}`,
    });
    setOutcome(traceId, 'error', 'trace file not found');
    completeTrace(traceId, '(no traces to mine)');
    return { discovered: [], traceId };
  }

  // 1. Read all traces from the JSONL file.
  const fileStart = Date.now();
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  addStep(traceId, {
    kind: 'llm-call',  // reusing 'llm-call' as the "read input" step kind
    label: `read ${lines.length} trace lines from ${file}`,
    output: { lineCount: lines.length },
    durationMs: Date.now() - fileStart,
  });

  // 2. Parse each line and extract (toolCalls, outcome, input) triples.
  const triples: Array<{ toolCalls: string[]; outcome: number; input: string }> = [];
  let skippedTraces = 0;
  for (const line of lines) {
    try {
      const t = JSON.parse(line) as AgentRunTrace;
      // Only mine react/codeact runs — single-shot has no tool calls.
      if (t.executionMode === 'single-shot') {
        skippedTraces++;
        continue;
      }
      // Extract the ordered tool names from toolResults
      const toolCalls = t.toolResults.map((r) => r.name);
      if (toolCalls.length === 0) {
        skippedTraces++;
        continue;
      }
      // outcome: success=1.0, loop-blocked=0.3, max-turns=0.5, error=0.0, aborted=0.0
      const outcomeScore = outcomeToScore(t.outcome);
      triples.push({
        toolCalls,
        outcome: outcomeScore,
        input: t.input.slice(0, 200),
      });
    } catch {
      skippedTraces++;
    }
  }
  addStep(traceId, {
    kind: 'parse',
    label: `parsed ${triples.length} mineable traces (skipped ${skippedTraces})`,
    output: { mineable: triples.length, skipped: skippedTraces },
  });

  if (triples.length === 0) {
    addStep(traceId, {
      kind: 'done',
      label: 'no mineable traces — nothing to discover',
    });
    setOutcome(traceId, 'success');
    completeTrace(traceId, '(no candidates)');
    return { discovered: [], traceId };
  }

  // 3. Mine subsequences.
  const mineStart = Date.now();
  const accums = new Map<string, SeqAccum>();
  for (const { toolCalls, outcome, input } of triples) {
    if (toolCalls.length < cfg.minSequenceLength) continue;
    const upper = Math.min(cfg.maxSequenceLength + 1, toolCalls.length + 1);
    for (let length = cfg.minSequenceLength; length < upper; length++) {
      for (let start = 0; start <= toolCalls.length - length; start++) {
        const seq = toolCalls.slice(start, start + length);
        const key = seq.join(' → ');
        let accum = accums.get(key);
        if (!accum) {
          accum = { outcomes: [], inputs: [] };
          accums.set(key, accum);
        }
        accum.outcomes.push(outcome);
        if (input && accum.inputs.length < 3) accum.inputs.push(input);
      }
    }
  }
  addStep(traceId, {
    kind: 'parse',
    label: `enumerated ${accums.size} unique candidate sequences`,
    output: { candidateCount: accums.size },
    durationMs: Date.now() - mineStart,
  });

  // 4. Filter by minFrequency + minOutcome, build DiscoveredSkill records.
  const filterStart = Date.now();
  const discovered: DiscoveredSkill[] = [];
  let kept = 0;
  let skippedFreq = 0;
  let skippedOutcome = 0;
  for (const [seqStr, accum] of accums) {
    const freq = accum.outcomes.length;
    const avg = accum.outcomes.reduce((a, b) => a + b, 0) / freq;
    if (freq < cfg.minFrequency) {
      skippedFreq++;
      continue;
    }
    if (avg < cfg.minOutcome) {
      skippedOutcome++;
      continue;
    }
    const seq = seqStr.split(' → ');
    discovered.push({
      name: seq.join('_'),
      description: `Auto-discovered skill: ${seqStr} (seen ${freq} times, avg outcome ${avg.toFixed(2)})`,
      tool_sequence: seq,
      frequency: freq,
      avg_outcome: avg,
      example_inputs: accum.inputs,
    });
    kept++;
  }
  addStep(traceId, {
    kind: 'parse',
    label: `filtered: kept ${kept}, skipped ${skippedFreq} (below minFreq ${cfg.minFrequency}), skipped ${skippedOutcome} (below minOutcome ${cfg.minOutcome})`,
    output: { kept, skippedFreq, skippedOutcome },
    durationMs: Date.now() - filterStart,
  });

  // 5. Sort by (frequency * avg_outcome) descending.
  discovered.sort((a, b) => (b.frequency * b.avg_outcome) - (a.frequency * a.avg_outcome));
  addStep(traceId, {
    kind: 'parse',
    label: `sorted ${discovered.length} discovered skills by frequency*outcome`,
    output: { sorted: discovered.length },
  });

  // 6. Auto-install each discovered skill as a manifest (so it can be invoked).
  // The manifest uses the tool_sequence as steps with empty argument templates —
  // real skills installed from TOML have proper templates; auto-discovered ones
  // are skeletons that the Extension Agent can later refine.
  for (const skill of discovered) {
    const manifest: SkillManifest = {
      name: skill.name,
      version: '0.0.0-auto',
      description: skill.description,
      author: 'skill-discovery',
      steps: skill.tool_sequence.map((tool, i) => ({
        tool_name: tool,
        arguments_template: '{}',
        output_key: `step_${i}_output`,
      })),
      required_capabilities: skill.tool_sequence,
      metadata: {
        auto_discovered: true,
        frequency: skill.frequency,
        avg_outcome: skill.avg_outcome,
        example_inputs: skill.example_inputs,
      },
    };
    installSkill(manifest);
  }
  addStep(traceId, {
    kind: 'tool-call',  // reusing 'tool-call' as the "write to skill store" step kind
    label: `auto-installed ${discovered.length} skill manifests into the in-memory skill store`,
    output: { installed: discovered.length },
  });

  // 7. Write the discovered skills into the trace's toolResults so /api/traces/:id
  // surfaces them — same shape as agent tool calls.
  for (const skill of discovered) {
    // The executor's completeTrace signature takes a single output string; we
    // stash the full discovered list in the trace's toolResults via addToolResult.
    // We import addToolResult lazily to avoid a cycle.
    const { addToolResult } = await import('../observability/traces.js');
    addToolResult(traceId, {
      name: 'skill-discovery',
      args: { sequence: skill.tool_sequence },
      result: skill,
      success: true,
    });
  }

  setOutcome(traceId, 'success');
  const summary = `discovered ${discovered.length} skill(s) from ${triples.length} trace(s)`;
  completeTrace(traceId, summary);

  return { discovered, traceId };
}

function outcomeToScore(outcome: AgentRunTrace['outcome']): number {
  switch (outcome) {
    case 'success': return 1.0;
    case 'max-turns': return 0.5;
    case 'loop-blocked': return 0.3;
    case 'error': return 0.0;
    case 'aborted': return 0.0;
    default: return 0.0;
  }
}
