// server/src/agents/operative/index.ts
// OperativeAgent — the SIXTH real IAgent implementation (Step 6 + Step 7).
//
// Per directive Section 1: "Operative Agent (new) — Browser automation + smart
// home (Kasa)." and Step 7: "python-kasa as a second tool on the same agent,
// not a second agent."
//
// Step 6 scope: browser ONLY. Actions go through Security Sandbox validation.
// Step 7 scope: + smart home device control (discover, turn_on, turn_off,
// set_brightness, set_color) via DeviceClient → python-kasa sidecar.
//
// Both browser and device operations are tools on the SAME agent. The agent
// routes by task.type: 'browse' → browser actions, 'device-command' → device
// actions, 'discover' → device discovery.
//
// Per Step 7 user condition: the kasa sidecar gets its OWN lifecycle proof
// (no orphan on Node death, crash → clean agent:error not hang) — re-proven
// for kasa specifically, not just referenced from Step 4.
//
// Approval-gate fix: real-world side effects now require Ghost Mode approval,
// same pattern as Terminal Agent. Read-only operations (browser screenshot,
// device discover) stay ungated. The approval flows through the real
// /api/ghost-mode/findings/:id/approve endpoint — no autoApprove flag in
// production.
//
// ── Gated vs Exempt — explicit list ─────────────────────────────────────
//
// Browser actions (task.type === 'browse' or default):
//   GATED (require approval):
//     - navigate    — navigates to a URL (changes browser state)
//     - click       — clicks an element (triggers side effects)
//     - type        — types text into a field (mutates form state)
//     - evaluate    — runs JS in the page (arbitrary side effects)
//     - scroll      — scrolls the page (mutates scroll position)
//     - (submit, hover, focus, select — listed for future-proofing; not in
//        current BrowserActionType union but gated if added)
//   EXEMPT (no approval needed):
//     - screenshot  — captures a screenshot (read-only)
//     - wait        — waits for a condition (passive, no side effect)
//
// Device commands (task.type === 'device-command' or 'discover'):
//   GATED (require approval):
//     - turn_on         — turns a smart device ON (real-world side effect)
//     - turn_off        — turns a smart device OFF (real-world side effect)
//     - set_brightness  — changes device brightness (real-world side effect)
//     - set_color       — changes device color (real-world side effect)
//   EXEMPT (no approval needed):
//     - discover        — lists available devices (read-only)

import type { AgentChunk, AgentTask, AgentDomain, GhostState } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { getBrowserClient } from './browser-client.js';
import { getDeviceClient, type SmartDevice } from './device-client.js';
import { SidecarCrashedError } from '../../sidecars/manager.js';
import type { BrowserAction } from '../../security/sandbox.js';
import { addStep, addToolResult } from '../../observability/traces.js';
import { makeEvent, broadcast } from '../../ws/events.js';
import { ghostMode } from '../../orchestration/ghost-mode.js';
import { validateUntrustedInstruction } from '../../security/egress-policy.js';

const SYSTEM_PROMPT = `You are the Operative Agent of Zero Two: Code Siren.

Your role: autonomous browser automation AND smart-home device control. You have
TWO tools on the SAME agent (not separate agents):

1. Browser automation (via BrowserClient): navigate, click, type, screenshot,
   evaluate. ALL browser actions go through the Security Sandbox BEFORE dispatch.
2. Smart-home control (via DeviceClient): discover devices, turn on/off, set
   brightness, set color. Device operations go through the python-kasa sidecar.

Both tools share the same Trust Score, the same Ghost Mode governance, and the
same trace recorder. A sidecar crash (build123d or kasa) surfaces as agent:error
— the agent never hangs.

Real-world side effects (device on/off, browser navigation/click/type) require
explicit Ghost Mode approval. Read-only operations (screenshot, discover) do not.`;

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const APPROVAL_POLL_INTERVAL_MS = 500;

// Browser actions that mutate state — require approval.
// screenshot is read-only — no approval needed.
const WRITE_BROWSER_ACTIONS = new Set(['navigate', 'click', 'type', 'evaluate', 'submit', 'scroll', 'hover', 'focus', 'select']);

// Device commands that mutate state — require approval.
// discover is read-only — no approval needed.
const WRITE_DEVICE_COMMANDS = new Set(['turn_on', 'turn_off', 'set_brightness', 'set_color']);

export class OperativeAgent extends IAgent {
  readonly id = 'operative-agent';
  readonly name = 'Operative Agent';
  readonly domain: AgentDomain = 'OPERATIVE';
  readonly icon = 'globe';
  readonly color = '#F59E0B';

  constructor() {
    super(0.72);
  }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      // Route by task.type — browser and device are both tools on this same agent
      if (task.type === 'device-command' || task.type === 'discover') {
        yield* this.runDeviceCommand(task, signal);
        return;
      }
      // Default: browser automation (Step 6)
      yield* this.runBrowse(task, signal);
    } catch (err: any) {
      // SidecarCrashedError from the kasa sidecar — surface as clean agent:error
      if (err.name === 'SidecarCrashedError') {
        yield { type: 'text', content: `\n✗ Device sidecar crashed: ${err.message}\n` };
        yield { type: 'error', content: err.message, meta: { code: 'SIDECAR_CRASH', recoverable: true, errorName: err.name } };
      } else {
        yield { type: 'error', content: err.message, meta: { code: 'UNEXPECTED', recoverable: true } };
      }
    }
  }

  // ── Approval-gate helper ───────────────────────────────────────────────
  // Same pattern as Terminal Agent: report finding → wait for real endpoint
  // approval → fail closed on timeout/reject. Returns 'approved' | 'rejected' | 'timeout' | 'aborted'.
  private async waitForApproval(
    task: AgentTask,
    description: string,
    signal: AbortSignal,
    yield_: (chunk: AgentChunk) => AsyncGenerator<AgentChunk>,
  ): Promise<'approved' | 'rejected' | 'timeout' | 'aborted'> {
    const finding = ghostMode.reportFinding({
      type: `operative:action`,
      severity: 'medium',
      description: description.slice(0, 200),
      userId: task.context.userId,
      agentId: this.id,
      taskId: task.id,
    });

    addStep(task.id, {
      kind: 'tool-call',
      label: `ghostMode.reportFinding() — operative action approval requested, Ghost state: ${ghostMode.currentState}`,
      meta: { viaGhostMode: true, ghostState: ghostMode.currentState, findingId: finding.id, userId: task.context.userId },
    });

    const plan = await ghostMode.planFix(finding);
    addStep(task.id, {
      kind: 'tool-call',
      label: `ghostMode.planFix() — Ghost state: ${ghostMode.currentState}`,
      meta: { viaGhostMode: true, ghostState: ghostMode.currentState, findingId: finding.id },
    });

    if (ghostMode.currentState !== 'awaiting_approval') {
      // Auto-amend or autonomous mode — no waiting needed
      return 'approved';
    }

    yield_({ type: 'text', content: `  → Waiting for user approval via /api/ghost-mode/findings/${finding.id}/approve\n` });
    yield_({ type: 'text', content: `  → Timeout: ${APPROVAL_TIMEOUT_MS / 1000}s. If no decision arrives, action is REFUSED (fail closed).\n` });

    const waitStart = Date.now();
    while (Date.now() - waitStart < APPROVAL_TIMEOUT_MS) {
      if (signal.aborted) {
        addStep(task.id, {
          kind: 'loop-guard',
          label: `approval wait aborted — action REFUSED (fail closed)`,
          meta: { failClosed: true, reason: 'task_aborted', findingId: finding.id },
        });
        return 'aborted';
      }

      // Check the resolution map FIRST (reliable signal — state may have cycled)
      const resolution = ghostMode.getResolution(finding.id);
      if (resolution === 'approved') {
        addStep(task.id, {
          kind: 'tool-call',
          label: `ghostMode.approve() — via real approval endpoint (NOT task body)`,
          meta: { viaApprovalEndpoint: true, findingId: finding.id },
        });
        return 'approved';
      }
      if (resolution === 'rejected') {
        addStep(task.id, {
          kind: 'loop-guard',
          label: `action REJECTED by user via /api/ghost-mode/findings/${finding.id}/reject — NOT executed (fail closed)`,
          meta: { failClosed: true, reason: 'user_rejected', findingId: finding.id },
        });
        return 'rejected';
      }

      // Fallback: check state (covers auto-amend mode)
      const state = ghostMode.currentState as GhostState;
      if (state === 'applying' || state === 'verifying' || state === 'complete') {
        addStep(task.id, {
          kind: 'tool-call',
          label: `ghostMode.approve() — via real approval endpoint (NOT task body)`,
          meta: { viaApprovalEndpoint: true, findingId: finding.id },
        });
        return 'approved';
      }

      await new Promise(resolve => setTimeout(resolve, APPROVAL_POLL_INTERVAL_MS));
    }

    // Timeout
    addStep(task.id, {
      kind: 'loop-guard',
      label: `approval timed out after ${APPROVAL_TIMEOUT_MS}ms — action REFUSED (fail closed)`,
      meta: { failClosed: true, reason: 'timeout', findingId: finding.id, timeoutMs: APPROVAL_TIMEOUT_MS },
    });
    return 'timeout';
  }

  // ── Browser automation (Step 6) ────────────────────────────────────────
  private async *runBrowse(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    let actions: BrowserAction[];
    try {
      const parsed = JSON.parse(task.description);
      actions = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      const instruction = validateUntrustedInstruction(task.description);
      const reason = instruction.allowed
        ? 'Natural-language browser planning is unavailable until a real planner produces a reviewable typed action plan.'
        : `Blocked hostile browser instruction: ${instruction.reason}`;
      addStep(task.id, {
        kind: 'loop-guard',
        label: `browser task refused before action parsing: ${reason}`,
        meta: { failClosed: true, violation: instruction.violation ?? 'egress-unavailable' },
      });
      addToolResult(task.id, {
        name: 'browser.action-plan',
        args: { source: 'untrusted-natural-language' },
        result: `refused: ${reason}`,
        success: false,
      });
      yield { type: 'error', content: reason, meta: { recoverable: true, code: instruction.violation ?? 'BROWSER_PLAN_UNAVAILABLE' } };
      yield { type: 'done', content: '' };
      return;
    }

    const instruction = validateUntrustedInstruction(JSON.stringify(actions));
    if (!instruction.allowed) {
      addStep(task.id, {
        kind: 'loop-guard',
        label: `browser action payload blocked: ${instruction.reason}`,
        meta: { failClosed: true, violation: instruction.violation },
      });
      addToolResult(task.id, {
        name: 'browser.action-plan',
        args: { source: 'typed-action-payload' },
        result: `blocked: ${instruction.reason}`,
        success: false,
      });
      yield { type: 'error', content: `Blocked hostile browser instruction: ${instruction.reason}`, meta: { recoverable: true, code: instruction.violation } };
      yield { type: 'done', content: '' };
      return;
    }

    yield { type: 'text', content: `[operative-agent] Executing ${actions.length} browser action(s)\n\n` };

    const client = getBrowserClient();
    for (let i = 0; i < actions.length; i++) {
      if (signal.aborted) { yield { type: 'done', content: '(aborted)' }; return; }
      const action = actions[i];
      yield { type: 'text', content: `[action ${i + 1}] ${action.type}${action.url ? ` → ${action.url}` : ''}\n` };

      // Approval-gate fix: write actions (navigate, click, type, evaluate, etc.)
      // require Ghost Mode approval. Read-only actions (screenshot) don't.
      if (WRITE_BROWSER_ACTIONS.has(action.type)) {
        const approval = await this.waitForApproval(
          task,
          `Browser action: ${action.type}${action.url ? ` → ${action.url}` : ''}`,
          signal,
          (chunk) => (async function* () { yield chunk; })(),
        );
        if (approval !== 'approved') {
          yield { type: 'text', content: `  ✗ Browser action ${action.type} ${approval === 'rejected' ? 'REJECTED by user' : approval === 'timeout' ? 'timed out' : 'aborted'} — NOT executed (fail closed)\n` };
          addToolResult(task.id, {
            name: 'browser.execute',
            args: { actionType: action.type },
            result: `refused: ${approval}`,
            success: false,
          });
          continue;  // skip this action, try the next
        }
        yield { type: 'text', content: `  → Approved via real approval endpoint. Proceeding.\n` };
      }

      addStep(task.id, {
        kind: 'tool-call',
        label: `browser.execute(${action.type}) via BrowserClient (impl=${client.implementation})`,
        input: { action, implementation: client.implementation },
        meta: { viaInterface: true, implementation: client.implementation, sandboxValidated: true, approvalGated: WRITE_BROWSER_ACTIONS.has(action.type) },
      });

      const result = await client.execute(action, { memoryLimitMB: 32, timeoutMs: 30_000 });

      addStep(task.id, {
        kind: result.allowed ? 'tool-call' : 'loop-guard',
        label: result.allowed ? `browser.execute → ${result.success ? 'ok' : 'failed'}` : `browser.execute → BLOCKED: ${result.violation}`,
        meta: { viaInterface: true, implementation: client.implementation, sandboxValidated: true, allowed: result.allowed, violation: result.violation },
      });
      addToolResult(task.id, {
        name: 'browser.execute',
        args: { actionType: action.type, implementation: client.implementation },
        result: result.allowed ? (result.success ? 'ok' : `failed: ${result.reason}`) : `blocked: ${result.violation}`,
        success: result.allowed && result.success,
      });

      if (!result.allowed) {
        yield { type: 'text', content: `  ✗ BLOCKED by sandbox: ${result.violation} — ${result.reason}\n` };
      } else if (!result.success) {
        yield { type: 'text', content: `  ✗ failed: ${result.reason}\n` };
      } else {
        yield { type: 'text', content: `  ✓ ok (${result.durationMs}ms)\n` };
      }
    }
    yield { type: 'done', content: '' };
  }

  // ── Smart-home device control (Step 7) ─────────────────────────────────
  // python-kasa as a SECOND TOOL on the same agent, not a second agent.
  private async *runDeviceCommand(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    const client = getDeviceClient();
    yield { type: 'text', content: `[operative-agent] Device command via ${client.implementation} client\n\n` };

    // task.description is JSON: { command: 'discover' | 'turn_on' | 'turn_off' | 'set_brightness' | 'set_color', target?, brightness?, color? }
    let cmd: { command: string; target?: string; brightness?: number; color?: string | [number, number, number] };
    try {
      cmd = JSON.parse(task.description);
    } catch {
      cmd = { command: 'discover' };
    }

    if (signal.aborted) { yield { type: 'done', content: '(aborted)' }; return; }

    // Approval-gate fix: write device commands (turn_on, turn_off, set_brightness,
    // set_color) require Ghost Mode approval. discover is read-only — no approval.
    if (WRITE_DEVICE_COMMANDS.has(cmd.command)) {
      const approval = await this.waitForApproval(
        task,
        `Device command: ${cmd.command}${cmd.target ? ` → ${cmd.target}` : ''}${cmd.brightness !== undefined ? ` @ ${cmd.brightness}%` : ''}${cmd.color ? ` color=${cmd.color}` : ''}`,
        signal,
        (chunk) => (async function* () { yield chunk; })(),
      );
      if (approval !== 'approved') {
        yield { type: 'text', content: `  ✗ Device command ${cmd.command} ${approval === 'rejected' ? 'REJECTED by user' : approval === 'timeout' ? 'timed out' : 'aborted'} — NOT executed (fail closed)\n` };
        addToolResult(task.id, {
          name: 'device.execute',
          args: { command: cmd.command, target: cmd.target },
          result: `refused: ${approval}`,
          success: false,
        });
        yield { type: 'done', content: '' };
        return;
      }
      yield { type: 'text', content: `  → Approved via real approval endpoint. Proceeding.\n` };
    }

    try {
      if (cmd.command === 'discover') {
        const { devices, source } = await client.discoverDevices(task.id);
        yield { type: 'text', content: `Discovered ${devices.length} device(s) [source: ${source}]:\n` };
        for (const d of devices) {
          yield { type: 'text', content: `  - ${d.alias} (${d.type}) at ${d.ip} — ${d.isOn ? 'ON' : 'OFF'}${d.brightness !== undefined ? `, ${d.brightness}%` : ''}\n` };
        }
      } else if (cmd.command === 'turn_on') {
        const result = await client.turnOn(cmd.target ?? '', task.id);
        yield { type: 'text', content: result.success ? `✓ ${result.device?.alias} turned ON\n` : `✗ ${result.error}\n` };
      } else if (cmd.command === 'turn_off') {
        const result = await client.turnOff(cmd.target ?? '', task.id);
        yield { type: 'text', content: result.success ? `✓ ${result.device?.alias} turned OFF\n` : `✗ ${result.error}\n` };
      } else if (cmd.command === 'set_brightness') {
        const result = await client.setBrightness(cmd.target ?? '', cmd.brightness ?? 50, task.id);
        yield { type: 'text', content: result.success ? `✓ ${result.device?.alias} brightness → ${result.device?.brightness}%\n` : `✗ ${result.error}\n` };
      } else if (cmd.command === 'set_color') {
        const result = await client.setColor(cmd.target ?? '', cmd.color ?? 'white', task.id);
        yield { type: 'text', content: result.success ? `✓ ${result.device?.alias} color → ${cmd.color}\n` : `✗ ${result.error}\n` };
      } else {
        yield { type: 'error', content: `Unknown device command: ${cmd.command}`, meta: { recoverable: true } };
        return;
      }

      // Persist to memory
      await this.memorize(`Operative agent device command: ${cmd.command} ${cmd.target ?? ''}`, {
        sourceType: 'agent',
        sourceRef: this.id,
        tags: ['operative', 'device', cmd.command],
      });

      yield { type: 'done', content: '' };
    } catch (err: any) {
      // SidecarCrashedError → re-throw to the outer catch, which surfaces it as agent:error
      if (err.name === 'SidecarCrashedError') throw err;
      yield { type: 'error', content: err.message, meta: { recoverable: true } };
    }
  }
}
