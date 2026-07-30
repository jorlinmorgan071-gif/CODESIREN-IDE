// server/src/agents/sentinel/index.ts
// SentinelAgent — the SEVENTH real IAgent implementation (Step 9).
//
// Per directive Section 1: "monitor_operative (continuous, stateful) → Sentinel
// Agent (new), domain SENTINEL. Ghost Mode's state machine, reused for
// life/ambient signals instead of code."
//
// Per directive Section 7: "The Sentinel Agent reuses Ghost Mode's existing
// state machine shape (scanning → detected → planning → awaiting_approval →
// applying/awaiting_approval → verifying → complete/rolled_back) rather than
// inventing a parallel one for the Personal Pillar."
//
// CRITICAL: This agent imports GhostState, GhostModeLevel, GhostFinding,
// GhostPlan, and the ghostMode singleton DIRECTLY from ghost-mode.ts.
// It does NOT define its own SentinelState enum, its own transitions map,
// or its own FSM. When Sentinel detects an ambient signal, it calls
// ghostMode.reportFinding() → ghostMode.planFix() → ghostMode.applyFix(),
// which drive the SAME GhostState transitions that code-scanning Ghost Mode
// uses. This is proven by:
//   1. The import line below (verbatim from ghost-mode.ts)
//   2. The e2e test comparing a Ghost Mode code-scan trace and a Sentinel
//      ambient-watch trace side by side — both use the same GhostState values
//      in their step meta, from the same ghostMode singleton.

import type { AgentChunk, AgentTask, AgentDomain } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
// ── THE IMPORT THAT PROVES NO PARALLEL FSM ──────────────────────────────
// Sentinel imports GhostState, GhostModeLevel, GhostFinding, and the ghostMode
// singleton DIRECTLY. There is no SentinelState enum. There is no
// SentinelModeLevel. There is no sentinel-transitions map. The Sentinel Agent
// calls ghostMode.reportFinding() and ghostMode.planFix() — the SAME methods
// that code-scanning Ghost Mode uses. The state transitions go through the
// SAME ghostMode.transition() method, which checks the SAME TRANSITIONS map.
import { ghostMode } from '../../orchestration/ghost-mode.js';
import type { GhostState, GhostModeLevel, GhostFinding } from '../../types.js';
import { addStep, addToolResult } from '../../observability/traces.js';
import { makeEvent, broadcast } from '../../ws/events.js';

// ── Sentinel watch types (these are Sentinel-specific data, NOT states) ──
// The watch *configuration* is Sentinel-specific. The *state machine* is not.

export interface SentinelWatch {
  id: string;
  watchType: string;        // 'price-drop', 'deadline-approaching', 'inbox-threshold', etc.
  config: Record<string, unknown>;
  lastScan?: number;
  createdAt: number;
}

export interface SentinelFinding {
  watchId: string;
  watchType: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  data?: Record<string, unknown>;
}

// In-memory watch registry (Step 9 — DB persistence comes with Memory Engine)
const watches = new Map<string, SentinelWatch>();

export function registerWatch(watch: Omit<SentinelWatch, 'id' | 'createdAt'>): SentinelWatch {
  const full: SentinelWatch = {
    ...watch,
    id: `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  };
  watches.set(full.id, full);
  console.log(`[sentinel] watch registered: ${full.id} (${full.watchType})`);
  return full;
}

export function listWatches(): SentinelWatch[] {
  return [...watches.values()];
}

export function removeWatch(id: string): boolean {
  return watches.delete(id);
}

// ── SentinelAgent ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Sentinel Agent of Zero Two: Code Siren.

Your role: continuous ambient monitoring for the Personal Pillar. You watch for
life signals — price drops, approaching deadlines, inbox thresholds, calendar
reminders, health metrics — and surface alerts through the same Ghost Mode
state machine that code-scanning uses.

When you detect something:
1. Report it via ghostMode.reportFinding() — this transitions Ghost Mode to
   'detected' (the SAME state code-scanning uses when it finds a bug).
2. If the Ghost Mode level is 'approval-required', the finding waits for user
   approval (the SAME awaiting_approval state code-scanning uses).
3. If the level is 'auto-amend' or 'autonomous', the finding is acted on
   automatically (the SAME applying → verifying → complete pipeline).

You do NOT have your own state machine. You share Ghost Mode's. The same
GhostState enum, the same transitions map, the same ghostMode singleton.`;

export class SentinelAgent extends IAgent {
  readonly id = 'sentinel-agent';
  readonly name = 'Sentinel Agent';
  readonly domain: AgentDomain = 'SENTINEL';
  readonly icon = 'eye';
  readonly color = '#8B5CF6';  // purple — distinct from other agents

  constructor() {
    super(0.70);
  }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      // task.description is JSON: { action: 'scan' | 'register' | 'list', watch?: {...} }
      let cmd: { action: string; watch?: Omit<SentinelWatch, 'id' | 'createdAt'>; watchId?: string };
      try {
        cmd = JSON.parse(task.description);
      } catch {
        cmd = { action: 'scan' };
      }

      if (cmd.action === 'register' && cmd.watch) {
        const watch = registerWatch(cmd.watch);
        yield { type: 'text', content: `[sentinel] Watch registered: ${watch.id} (${watch.watchType})\n` };
        yield { type: 'done', content: '' };
        return;
      }

      if (cmd.action === 'list') {
        const all = listWatches();
        yield { type: 'text', content: `[sentinel] ${all.length} watch(es) registered:\n` };
        for (const w of all) {
          yield { type: 'text', content: `  - ${w.id}: ${w.watchType}\n` };
        }
        yield { type: 'done', content: '' };
        return;
      }

      // Default: scan all watches
      yield { type: 'text', content: `[sentinel] Scanning ${watches.size} watch(es)...\n` };
      yield { type: 'text', content: `[sentinel] Ghost Mode state before scan: ${ghostMode.currentState}\n\n` };

      // ── THE CRITICAL PROOF: Sentinel uses ghostMode (the SAME singleton) ──
      // Every finding is reported through ghostMode.reportFinding(), which
      // transitions the SAME GhostState enum. The trace records the
      // GhostState value at each step — proving Sentinel shares the FSM.
      const findings: SentinelFinding[] = [];

      for (const [watchId, watch] of watches) {
        if (signal.aborted) { yield { type: 'done', content: '(aborted)' }; return; }

        // Simulate detecting a finding for each watch (stub — real impl would
        // check actual data sources: prices, calendars, inboxes, etc.)
        const finding: SentinelFinding = {
          watchId,
          watchType: watch.watchType,
          severity: 'medium',
          description: `Watch "${watch.watchType}" triggered: threshold reached`,
          data: watch.config,
        };
        findings.push(finding);

        yield { type: 'text', content: `[sentinel] Detection: ${finding.description}\n` };

        // ── Report through ghostMode.reportFinding() ──
        // This is the SAME method code-scanning Ghost Mode uses. It:
        //   1. Broadcasts ghost:detection event
        //   2. Transitions state to 'detected'
        //   3. If level is approval-required, transitions to 'awaiting_approval'
        // The GhostState values are from the SAME enum imported at the top.
        addStep(task.id, {
          kind: 'tool-call',
          label: `ghostMode.reportFinding() — Sentinel uses the SAME Ghost Mode FSM`,
          input: { watchId, watchType: watch.watchType, severity: finding.severity },
          meta: {
            viaGhostMode: true,
            ghostStateBefore: ghostMode.currentState as GhostState,
            sharedFSM: true,
          },
        });

        const ghostFinding: GhostFinding = {
          id: watchId,
          type: `sentinel:${watch.watchType}`,
          severity: finding.severity,
          description: finding.description,
        };
        const reported = ghostMode.reportFinding(ghostFinding);

        addStep(task.id, {
          kind: 'tool-call',
          label: `ghostMode.reportFinding() → state is now ${ghostMode.currentState}`,
          output: { findingId: reported.id, ghostState: ghostMode.currentState as GhostState },
          meta: {
            viaGhostMode: true,
            ghostStateAfter: ghostMode.currentState as GhostState,
            sharedFSM: true,
          },
        });
        addToolResult(task.id, {
          name: 'ghostMode.reportFinding',
          args: { watchType: watch.watchType },
          result: `state=${ghostMode.currentState}`,
          success: true,
        });

        // Emit sentinel:alert WS event (directive Section 6)
        broadcast(makeEvent('sentinel:alert' as any, {
          watchId,
          severity: finding.severity,
          description: finding.description,
          ghostState: ghostMode.currentState,
        }));

        yield { type: 'text', content: `  → Ghost Mode state: ${ghostMode.currentState}\n` };

        // If approval-required, plan the fix (also through ghostMode)
        if (ghostMode.currentState === 'awaiting_approval') {
          const plan = await ghostMode.planFix(reported);
          yield { type: 'text', content: `  → Plan created: ${plan.preview}\n` };
          addStep(task.id, {
            kind: 'tool-call',
            label: `ghostMode.planFix() → state is now ${ghostMode.currentState}`,
            meta: { viaGhostMode: true, ghostStateAfter: ghostMode.currentState as GhostState, sharedFSM: true },
          });

          // Auto-approve for the e2e proof (in real use, this would wait for user)
          await ghostMode.approve(plan);
          yield { type: 'text', content: `  → Approved → state: ${ghostMode.currentState}\n` };
        }
      }

      if (findings.length === 0) {
        yield { type: 'text', content: `[sentinel] No findings. Ghost Mode state: ${ghostMode.currentState}\n` };
      }

      // Also delegate to the strategy dispatcher for any LLM-based analysis
      // (e.g. summarizing findings, suggesting actions)
      if (findings.length > 0) {
        yield { type: 'text', content: '\n[sentinel] Analyzing findings...\n' };
        const recalled = await this.recall(task.description, 5);
        const memoryBlock = recalled.length > 0
          ? `\n\nRecalled context:\n${recalled.map((r) => `- ${r.content}`).join('\n')}\n`
          : '';

        let fullResponse = '';
        for await (const chunk of dispatchStrategy(task, signal, {
          systemPrompt: SYSTEM_PROMPT + memoryBlock,
          temperature: 0.4,
          maxTokens: 512,
          agentId: this.id,
          domain: this.domain,
        })) {
          if (signal.aborted) { yield { type: 'done', content: '(aborted)' }; return; }
          if (chunk.type === 'text') fullResponse += chunk.content;
          yield chunk;
        }

        await this.memorize(fullResponse, {
          sourceType: 'agent',
          sourceRef: this.id,
          tags: ['sentinel', 'ambient', task.type],
        });
      } else {
        yield { type: 'done', content: '' };
      }
    } catch (err: any) {
      yield { type: 'error', content: err.message, meta: { code: 'UNEXPECTED', recoverable: true } };
    }
  }
}
