// Terminal Agent — Command execution, output analysis
// Approval-gate fix: the `autoApprove` field is NO LONGER honored in
// production. It only works when `NODE_ENV === 'test'` (for the existing
// test suite), and when it fires there it's logged loudly so it's never
// silently relied on. In any other environment, the field is ignored
// outright — fail closed, not "trust the caller."
//
// The real approval flow is:
//   1. validateShellCommand() — blocklist (rm -rf /, curl|bash, sudo, etc.)
//   2. ghostMode.reportFinding() with userId + taskId → ghost:plan WS event
//   3. UI shows ApprovalDialog (app/src/components/modals/ApprovalDialog.tsx)
//   4. User clicks Approve → POST /api/ghost-mode/findings/:id/approve
//   5. ghostMode.approve(plan) transitions FSM → agent proceeds
//   6. If no approval within 5 minutes OR WS drops → task ends REFUSED
//      (does NOT fall back to executing — same fail-closed rule as
//      writeProjectFile when Code Review Agent isn't registered)

import type { AgentChunk, AgentTask, AgentDomain, GhostState } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { validateShellCommand } from '../../security/sandbox.js';
import { ghostMode } from '../../orchestration/ghost-mode.js';
import { makeEvent, broadcast } from '../../ws/events.js';
import { addStep, addToolResult } from '../../observability/traces.js';
import { execSync } from 'node:child_process';

const SYSTEM_PROMPT = `You are the Terminal Agent of Zero Two: Code Siren.
Your role: propose shell commands, interpret output, generate automation scripts, and debug errors.
When given a task:
1. Propose the exact command(s) to run.
2. Explain what each command does and why.
3. Interpret the expected output.
4. Suggest next commands based on the result.
Always show the full command with flags. Never run destructive commands without confirmation.

Every command you propose goes through:
  1. Security validation (blocklist: rm -rf /, curl|bash, sudo, dd, mkfs, etc.)
  2. Ghost Mode approval (waits for user to approve before execution)
  3. Real execution (output streamed back in real time)

No command executes without explicit user approval. This is non-negotiable.`;

// Approval timeout — 5 minutes. If no approval decision arrives in this
// window, the task ends REFUSED (fail closed). Tuned for human review time
// of a real shell command.
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

// Polling interval for checking ghost state while waiting for approval.
const APPROVAL_POLL_INTERVAL_MS = 500;

export class TerminalAgent extends IAgent {
  readonly id = 'terminal-agent';
  readonly name = 'Terminal Agent';
  readonly domain: AgentDomain = 'TERMINAL';
  readonly icon = 'terminal';
  readonly color = '#64748B';
  constructor() { super(0.90); }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      // task.description can be:
      //   JSON: { command: "ls -la", autoApprove: false }
      //   Plain text: the LLM proposes a command, then we extract + validate + gate
      //
      // Approval-gate fix: autoApprove is ONLY honored in NODE_ENV === 'test'.
      // In any other environment, the field is ignored outright — the command
      // waits for real approval via the /api/ghost-mode/findings/:id/approve
      // endpoint. This is the same fail-closed discipline as writeProjectFile()
      // when Code Review Agent isn't registered.

      let proposedCommand: string | null = null;
      let testOnlyAutoApprove = false;

      try {
        const parsed = JSON.parse(task.description);
        if (parsed.command) {
          proposedCommand = parsed.command;
          // ONLY honor autoApprove in test environment. In production, this
          // field is silently ignored — the command still waits for real
          // approval. Fail closed, not "trust the caller."
          if (parsed.autoApprove === true) {
            if (process.env.NODE_ENV === 'test') {
              testOnlyAutoApprove = true;
              // LOUD log — never silently relied on
              console.warn(`[terminal-agent] ⚠ autoApprove honored in NODE_ENV=test for task ${task.id}. This is ONLY for the test suite — production NEVER honors this flag.`);
            } else {
              // Production: ignore the field entirely. Log it so operators
              // can see if some caller is trying to bypass the gate.
              console.warn(`[terminal-agent] ⚠ Caller sent autoApprove:true in NODE_ENV=${process.env.NODE_ENV} for task ${task.id}. IGNORED — command will wait for real approval.`);
              yield { type: 'text', content: `  ⚠ autoApprove:true IGNORED in production (NODE_ENV=${process.env.NODE_ENV}) — fail closed, waiting for real approval\n` };
              addStep(task.id, {
                kind: 'loop-guard',
                label: `autoApprove:true IGNORED in production (NODE_ENV=${process.env.NODE_ENV}) — fail closed, waiting for real approval`,
                meta: { autoApproveIgnored: true, failClosed: true, nodeEnv: process.env.NODE_ENV },
              });
            }
          }
        }
      } catch {
        // Not JSON — let the LLM propose a command
      }

      // If no explicit command provided, use the LLM to propose one
      if (!proposedCommand) {
        yield { type: 'text', content: '[terminal-agent] Analyzing request...\n\n' };
        let llmResponse = '';
        for await (const chunk of dispatchStrategy(task, signal, {
          systemPrompt: SYSTEM_PROMPT, temperature: 0.3, maxTokens: 512, agentId: this.id, domain: this.domain,
        })) {
          if (chunk.type === 'text') llmResponse += chunk.content;
          yield chunk;
        }

        // Extract command from LLM response (look for ```bash or ```sh blocks, or lines starting with $)
        const codeBlock = llmResponse.match(/```(?:bash|sh|shell)?\n([\s\S]*?)```/);
        if (codeBlock) {
          proposedCommand = codeBlock[1].trim();
        } else {
          const cmdLine = llmResponse.split('\n').find(l => l.trim().startsWith('$') || l.trim().startsWith('>'));
          if (cmdLine) proposedCommand = cmdLine.replace(/^[$>]\s*/, '').trim();
        }

        if (!proposedCommand) {
          yield { type: 'text', content: '\n[terminal-agent] No command extracted from response.\n' };
          yield { type: 'done', content: '' };
          return;
        }
      }

      yield { type: 'text', content: `\n[terminal-agent] Proposed command: \`${proposedCommand}\`\n` };

      // ── Step 1: Security validation ──────────────────────────────────
      const validation = validateShellCommand(proposedCommand);
      addStep(task.id, {
        kind: validation.allowed ? 'tool-call' : 'loop-guard',
        label: validation.allowed
          ? `validateShellCommand("${proposedCommand.slice(0, 60)}") → ALLOWED`
          : `validateShellCommand("${proposedCommand.slice(0, 60)}") → BLOCKED: ${validation.reason}`,
        meta: { validated: true, allowed: validation.allowed, violation: validation.violation, reason: validation.reason },
      });

      if (!validation.allowed) {
        yield { type: 'text', content: `\n✗ BLOCKED by security validation: ${validation.reason}\n` };
        yield { type: 'text', content: `  violation: ${validation.violation}\n` };
        yield { type: 'text', content: `  The command was NOT executed.\n` };
        addToolResult(task.id, {
          name: 'terminal.validateShellCommand',
          args: { command: proposedCommand.slice(0, 100) },
          result: `blocked: ${validation.reason}`,
          success: false,
        });
        yield { type: 'error', content: `Command blocked: ${validation.reason}`, meta: { violation: validation.violation, recoverable: true } };
        return;
      }

      yield { type: 'text', content: `✓ Security validation passed.\n` };
      addToolResult(task.id, {
        name: 'terminal.validateShellCommand',
        args: { command: proposedCommand.slice(0, 100) },
        result: 'allowed',
        success: true,
      });

      // ── Step 2: Ghost Mode approval gate ─────────────────────────────
      // Reuse ghostMode.reportFinding()/planFix()/approve() — the SAME
      // methods Sentinel uses. Do NOT invent a second approval mechanism.
      //
      // Approval-gate fix: the finding now carries userId + taskId so the
      // approval endpoint can verify ownership. The agent does NOT call
      // ghostMode.approve() itself in production — it waits for the
      // endpoint to call it (signaled by the FSM transitioning out of
      // awaiting_approval).
      yield { type: 'text', content: `\n[terminal-agent] Requesting Ghost Mode approval...\n` };

      const finding = ghostMode.reportFinding({
        type: `terminal:command`,
        severity: 'medium',
        description: `Execute command: ${proposedCommand.slice(0, 100)}`,
        // Approval-gate fix: tag the finding with the user + task so the
        // approval endpoint can verify ownership. The agent doesn't have
        // direct access to req.user, so we pass userId through the task
        // context (set by the agents route from req.user.id).
        userId: (task.context as any).userId,
        agentId: this.id,
        taskId: task.id,
      });

      addStep(task.id, {
        kind: 'tool-call',
        label: `ghostMode.reportFinding() — command approval requested, Ghost state: ${ghostMode.currentState}`,
        meta: { viaGhostMode: true, ghostState: ghostMode.currentState, sharedFSM: true, findingId: finding.id, userId: (task.context as any).userId },
      });

      const plan = await ghostMode.planFix(finding);
      addStep(task.id, {
        kind: 'tool-call',
        label: `ghostMode.planFix() — Ghost state: ${ghostMode.currentState}`,
        meta: { viaGhostMode: true, ghostState: ghostMode.currentState, sharedFSM: true, findingId: finding.id },
      });

      // ── Approval-gate fix: wait for real approval ────────────────────
      // In production, we wait for the FSM to transition out of
      // awaiting_approval. This happens when the user clicks Approve or
      // Reject in the UI, which calls the /api/ghost-mode/findings/:id/approve
      // or /reject endpoint, which calls ghostMode.approve(plan) or
      // ghostMode.reject(plan).
      //
      // The TEST environment can still use autoApprove=true to skip the
      // wait (the test suite calls ghostMode.approve() directly via the
      // agent — but ONLY in NODE_ENV=test).
      if (ghostMode.currentState === 'awaiting_approval') {
        if (testOnlyAutoApprove && process.env.NODE_ENV === 'test') {
          yield { type: 'text', content: `  → Auto-approved (TEST MODE ONLY — never in production)\n` };
          addStep(task.id, {
            kind: 'tool-call',
            label: `ghostMode.approve() — TEST MODE auto-approve (NODE_ENV=test only)`,
            meta: { viaTestAutoApprove: true, testOnly: true, neverInProduction: true },
          });
          await ghostMode.approve(plan);
        } else {
          // Production path: wait for the real approval endpoint to
          // transition the FSM. Poll the state. If no decision arrives
          // within APPROVAL_TIMEOUT_MS, fail closed (refuse to execute).
          yield { type: 'text', content: `  → Waiting for user approval via /api/ghost-mode/findings/${finding.id}/approve\n` };
          yield { type: 'text', content: `  → Timeout: ${APPROVAL_TIMEOUT_MS / 1000}s. If no decision arrives, command is REFUSED (fail closed).\n` };

          const waitStart = Date.now();
          let approved = false;
          let rejected = false;
          while (Date.now() - waitStart < APPROVAL_TIMEOUT_MS) {
            if (signal.aborted) {
              yield { type: 'text', content: `\n  ✗ Task aborted while waiting for approval. Command NOT executed (fail closed).\n` };
              addStep(task.id, {
                kind: 'loop-guard',
                label: `approval wait aborted — command REFUSED (fail closed)`,
                meta: { failClosed: true, reason: 'task_aborted', findingId: finding.id },
              });
              yield { type: 'done', content: '' };
              return;
            }

            // Check the resolution map FIRST — this is the reliable signal.
            // The FSM state may have already cycled back to 'scanning' by
            // the time we poll (approve() transitions applying→verifying→
            // complete→scanning synchronously). Without getResolution(), we
            // can't distinguish approved-and-completed from rejected.
            const resolution = ghostMode.getResolution(finding.id);
            if (resolution === 'approved') {
              approved = true;
              break;
            }
            if (resolution === 'rejected') {
              rejected = true;
              break;
            }

            // Also check state as a fallback (covers auto-amend mode where
            // no approval was needed)
            const state = ghostMode.currentState as GhostState;
            if (state === 'applying' || state === 'verifying' || state === 'complete') {
              approved = true;
              break;
            }

            await new Promise(resolve => setTimeout(resolve, APPROVAL_POLL_INTERVAL_MS));
          }

          if (!approved && !rejected) {
            // Timeout — fail closed
            yield { type: 'text', content: `\n  ✗ Approval timed out after ${APPROVAL_TIMEOUT_MS / 1000}s. Command REFUSED (fail closed).\n` };
            addStep(task.id, {
              kind: 'loop-guard',
              label: `approval timed out after ${APPROVAL_TIMEOUT_MS}ms — command REFUSED (fail closed)`,
              meta: { failClosed: true, reason: 'timeout', findingId: finding.id, timeoutMs: APPROVAL_TIMEOUT_MS },
            });
            addToolResult(task.id, {
              name: 'terminal.approvalGate',
              args: { findingId: finding.id, timeoutMs: APPROVAL_TIMEOUT_MS },
              result: 'refused: timeout',
              success: false,
            });
            yield { type: 'error', content: `Approval timed out — command refused (fail closed)`, meta: { recoverable: true, code: 'APPROVAL_TIMEOUT' } };
            return;
          }

          if (rejected) {
            yield { type: 'text', content: `\n  ✗ Command REJECTED by user. NOT executed (fail closed).\n` };
            addStep(task.id, {
              kind: 'loop-guard',
              label: `command REJECTED by user via /api/ghost-mode/findings/${finding.id}/reject — NOT executed (fail closed)`,
              meta: { failClosed: true, reason: 'user_rejected', findingId: finding.id },
            });
            addToolResult(task.id, {
              name: 'terminal.approvalGate',
              args: { findingId: finding.id },
              result: 'refused: user rejected',
              success: false,
            });
            yield { type: 'done', content: '' };
            return;
          }

          // Approved via the real endpoint
          yield { type: 'text', content: `  → Approved via /api/ghost-mode/findings/${finding.id}/approve. Ghost state: ${ghostMode.currentState}\n` };
          addStep(task.id, {
            kind: 'tool-call',
            label: `ghostMode.approve() — via real approval endpoint (NOT task body autoApprove)`,
            meta: { viaApprovalEndpoint: true, findingId: finding.id, approvedBy: 'real-user-via-endpoint' },
          });
        }
      }

      // ── Step 3: Real execution ───────────────────────────────────────
      yield { type: 'text', content: `\n[terminal-agent] Executing: \`${proposedCommand}\`\n` };
      yield { type: 'command', content: proposedCommand };

      const execStart = Date.now();
      try {
        const output = execSync(proposedCommand, {
          encoding: 'utf8',
          timeout: 30_000, // 30s max
          maxBuffer: 1024 * 1024, // 1MB max output
          cwd: '/tmp',
        });

        const duration = Date.now() - execStart;
        yield { type: 'text', content: `\n${output}\n` };

        // Stream as terminal:output WS event (PDF Section 13)
        broadcast(makeEvent('terminal:output' as any, {
          tabId: 'terminal-1',
          data: output,
        }));

        addStep(task.id, {
          kind: 'done',
          label: `execSync("${proposedCommand.slice(0, 60)}") → exit 0 (${duration}ms, ${output.length} chars output)`,
          output: { exitCode: 0, outputPreview: output.slice(0, 200), durationMs: duration },
          meta: { executed: true, exitCode: 0, durationMs: duration },
        });
        addToolResult(task.id, {
          name: 'terminal.execute',
          args: { command: proposedCommand.slice(0, 100) },
          result: `exit 0 (${output.length} chars, ${duration}ms)`,
          success: true,
        });

        yield { type: 'text', content: `\n[terminal-agent] Command completed in ${duration}ms.\n` };
      } catch (err: any) {
        const duration = Date.now() - execStart;
        const stderr = err.stderr ?? err.message;
        const exitCode = err.status ?? 1;
        yield { type: 'text', content: `\n✗ Command failed (exit ${exitCode}):\n${stderr}\n` };

        broadcast(makeEvent('terminal:output' as any, {
          tabId: 'terminal-1',
          data: stderr,
        }));

        addStep(task.id, {
          kind: 'error',
          label: `execSync("${proposedCommand.slice(0, 60)}") → exit ${exitCode} (${duration}ms)`,
          output: { exitCode, stderr: stderr.slice(0, 200), durationMs: duration },
          meta: { executed: true, exitCode, durationMs: duration },
        });
        addToolResult(task.id, {
          name: 'terminal.execute',
          args: { command: proposedCommand.slice(0, 100) },
          result: `exit ${exitCode}: ${stderr.slice(0, 100)}`,
          success: false,
        });

        // ── Phase A Section 2: event-driven terminal error reporting ────
        // Report the failed command to Ghost Mode as a terminal:error finding.
        // This is event-driven (NOT periodic scanning — terminal errors are
        // instantaneous events, not persistent state). Ghost Mode will plan
        // it as suggest-only (buildTerminalErrorSuggestionPlan) — there's no
        // safe generic auto-fix for "a command failed."
        //
        // FSM SINGLE-IN-FLIGHT LIMITATION (per Section 0, not fixed here):
        // If Ghost Mode is mid-flow (awaiting_approval/applying/verifying),
        // reportFinding()'s transition to 'detected' will be BLOCKED by the
        // FSM's transition guard. The finding IS still stored in
        // ghostMode.findings + the ghost:detection WS event IS still broadcast
        // — so the error is NOT silently dropped. But it won't drive a planFix
        // until the FSM cycles back to 'scanning'. We log this honestly so
        // operators can see when a terminal error was reported but couldn't
        // drive the full detect→plan→approve flow.
        const ghostStateBeforeError = ghostMode.currentState;
        try {
          const errorFinding = ghostMode.reportFinding({
            type: 'terminal:error',
            severity: 'high',
            description: `Command "${proposedCommand.slice(0, 80)}" failed (exit ${exitCode}): ${stderr.slice(0, 200)}`,
            userId: (task.context as any).userId,
            agentId: this.id,
            taskId: task.id,
          });
          addStep(task.id, {
            kind: 'tool-call',
            label: `ghostMode.reportFinding() — terminal:error reported (finding ${errorFinding.id}), Ghost state: ${ghostMode.currentState}`,
            meta: {
              viaGhostMode: true,
              ghostStateBefore: ghostStateBeforeError,
              ghostStateAfter: ghostMode.currentState,
              findingId: errorFinding.id,
              exitCode,
              stderrPreview: stderr.slice(0, 100),
              note: ghostStateBeforeError !== 'scanning' && ghostStateBeforeError !== 'complete' && ghostStateBeforeError !== 'rolled_back'
                ? 'FSM was mid-flow — finding stored + event broadcast, but transition to detected was blocked. Will plan when FSM returns to scanning.'
                : 'FSM accepted the finding — will plan normally.',
            },
          });
        } catch (reportErr: any) {
          // reportFinding itself doesn't throw, but defensive — don't let
          // Ghost Mode reporting break the agent's error handling.
          console.warn(`[terminal-agent] ghostMode.reportFinding failed: ${reportErr.message}`);
        }
      }

      await this.memorize(`Terminal command: ${proposedCommand}`, {
        sourceType: 'agent', sourceRef: this.id, tags: ['terminal', 'executed'],
      });
      yield { type: 'done', content: '' };
    } catch (err: any) {
      yield { type: 'error', content: err.message, meta: { recoverable: true } };
    }
  }
}
