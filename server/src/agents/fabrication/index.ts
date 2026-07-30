// server/src/agents/fabrication/index.ts
// FabricationAgent — the FIFTH real IAgent implementation (Step 4 + Step 5).
//
// Per directive Section 1: "Fabrication Agent (new) — Agent Workforce, domain
// FABRICATION. build123d → STL generation, OrcaSlicer/Moonraker/OctoPrint handoff."
//
// Per directive Section 3: "Fabrication Agent | Specialist | Claude 3.5 Sonnet
// (planning) + local build123d execution | Parametric CAD generation, STL export,
// slicer profile selection, print job submission and monitoring"
//
// Step 4 scope: CAD ONLY. build123d script → STL file.
// Step 5 scope: + slicing + printer discovery + print submission. All printer
// operations go through the PrinterClient interface (printer-client.ts) — the
// stub impl is injected by default, real Moonraker/OctoPrint/PrusaLink impls
// are drop-in at deployment time.
//
// Lifecycle contract (per Step 4 user condition): the build123d sidecar is
// spawned and owned by the Node server via SidecarManager. When the Node server
// dies, the sidecar dies (no orphan). When the sidecar crashes mid-job, the
// Fabrication Agent catches it and yields an 'error' chunk — it never hangs.
//
// Approval-gate fix: print submission (fabricate-print task type) now requires
// Ghost Mode approval, same pattern as Terminal Agent. The approval flows
// through the real /api/ghost-mode/findings/:id/approve endpoint. CAD-only
// (fabricate-cad) and discover stay ungated — they produce files / list
// printers but don't submit real-world print jobs. Slice alone produces a
// G-code file but doesn't submit — also ungated.
//
// ── Gated vs Exempt — explicit list ─────────────────────────────────────
//
// Task types (task.type field on AgentTask):
//   GATED (require approval before the action executes):
//     - fabricate-print  — full pipeline: CAD → slice → PRINT SUBMISSION
//                          The print submission sends G-code to a physical
//                          printer (real-world side effect). Approval is
//                          requested AFTER CAD generation succeeds but
//                          BEFORE sliceAndPrint() is called. If rejected,
//                          the STL file is still available — the user can
//                          resubmit with fabricate-print to retry.
//   EXEMPT (no approval needed):
//     - fabricate-cad    — CAD generation only. Produces an STL file on disk.
//                          No printer is contacted. The file is inert until
//                          a separate fabricate-print task submits it.
//     - slice            — slices an existing STL into G-code. Produces a
//                          G-code file on disk. No printer is contacted.
//                          The file is inert until a human manually submits
//                          it via the printer's own interface.
//     - discover         — lists available printers on the network.
//                          Read-only — no printer state changes.

import type { AgentChunk, AgentTask, AgentDomain, GhostState } from '../../types.js';
import { IAgent } from '../base-agent.js';
import { generateCad } from './cad.js';
import { sliceAndPrint, sliceStl, discoverPrinters } from './printer.js';
import { makeEvent, broadcast } from '../../ws/events.js';
import { ghostMode } from '../../orchestration/ghost-mode.js';
import { addStep, addToolResult } from '../../observability/traces.js';

const SYSTEM_PROMPT = `You are the Fabrication Agent of Zero Two: Code Siren.

Your role: generate 3D CAD models from natural language prompts using the build123d
Python library, slice them into G-code, and submit them to 3D printers.

When asked to fabricate something:
1. Restate the part you're going to create (dimensions, features).
2. Delegate to the CAD generation pipeline — the build123d sidecar will run
   the script and produce an STL.
3. Slice the STL into G-code via the PrinterClient interface.
4. Submit the G-code to a discovered printer via the PrinterClient interface.
5. Report the print job status.

You do NOT manage printer hardware directly — all printer operations go through
the PrinterClient interface, which can be a stub (development) or a real
Moonraker/OctoPrint/PrusaLink client (deployment).

Print submission requires explicit Ghost Mode approval — a real human must
approve before a print job is sent to a physical printer.`;

type FabStage = 'generating-script' | 'executing-script' | 'stl-exported' | 'retrying'
  | 'printer-discovered' | 'slicing' | 'sliced' | 'submitting-print' | 'print-submitted';

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const APPROVAL_POLL_INTERVAL_MS = 500;

export class FabricationAgent extends IAgent {
  readonly id = 'fabrication-agent';
  readonly name = 'Fabrication Agent';
  readonly domain: AgentDomain = 'FABRICATION';
  readonly icon = 'box';  // lucide 'box' icon — represents 3D
  readonly color = '#10B981';  // emerald — distinct from the 17 Engineering-Pillar colors

  constructor() {
    super(0.75);  // starts lower — earns trust through successful STL generations
  }

  // ── Approval-gate helper ───────────────────────────────────────────────
  // Same pattern as Terminal/Operative agents. Returns 'approved' | 'rejected' | 'timeout' | 'aborted'.
  private async waitForApproval(
    task: AgentTask,
    description: string,
    signal: AbortSignal,
  ): Promise<'approved' | 'rejected' | 'timeout' | 'aborted'> {
    const finding = ghostMode.reportFinding({
      type: `fabrication:print`,
      severity: 'high',  // print submission is a real-world side effect — high severity
      description: description.slice(0, 200),
      userId: task.context.userId,
      agentId: this.id,
      taskId: task.id,
    });

    addStep(task.id, {
      kind: 'tool-call',
      label: `ghostMode.reportFinding() — fabrication print approval requested, Ghost state: ${ghostMode.currentState}`,
      meta: { viaGhostMode: true, ghostState: ghostMode.currentState, findingId: finding.id, userId: task.context.userId },
    });

    const plan = await ghostMode.planFix(finding);
    addStep(task.id, {
      kind: 'tool-call',
      label: `ghostMode.planFix() — Ghost state: ${ghostMode.currentState}`,
      meta: { viaGhostMode: true, ghostState: ghostMode.currentState, findingId: finding.id },
    });

    if (ghostMode.currentState !== 'awaiting_approval') {
      return 'approved';
    }

    const waitStart = Date.now();
    while (Date.now() - waitStart < APPROVAL_TIMEOUT_MS) {
      if (signal.aborted) {
        addStep(task.id, {
          kind: 'loop-guard',
          label: `approval wait aborted — print REFUSED (fail closed)`,
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
          label: `print REJECTED by user via /api/ghost-mode/findings/${finding.id}/reject — NOT submitted (fail closed)`,
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

    addStep(task.id, {
      kind: 'loop-guard',
      label: `approval timed out after ${APPROVAL_TIMEOUT_MS}ms — print REFUSED (fail closed)`,
      meta: { failClosed: true, reason: 'timeout', findingId: finding.id, timeoutMs: APPROVAL_TIMEOUT_MS },
    });
    return 'timeout';
  }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      // Step 5: route based on task.type
      //   fabricate-cad   → CAD only (Step 4) — NO approval needed (produces file only)
      //   fabricate-print → CAD + slice + print (Step 5) — approval needed before print submission
      //   slice           → slice an existing STL (Step 5) — NO approval (produces G-code file only)
      //   discover        → discover printers only (Step 5) — NO approval (read-only)
      if (task.type === 'discover') {
        yield* this.runDiscover(task, signal);
        return;
      }
      if (task.type === 'slice') {
        yield* this.runSlice(task, signal);
        return;
      }
      // Default: fabricate-cad (Step 4 behavior) or fabricate-print (Step 5 full pipeline)
      yield* this.runFabricate(task, signal);
    } catch (err: any) {
      yield { type: 'text', content: `\n✗ Fabrication pipeline error: ${err.message}\n` };
      if (err.name === 'SidecarCrashedError') {
        yield { type: 'text', content: `  The build123d sidecar crashed mid-job. This has been recorded in the trace.\n` };
        yield { type: 'text', content: `  The SidecarManager will spawn a fresh sidecar on the next request.\n` };
      }
      yield { type: 'error', content: err.message, meta: { code: 'SIDECAR_CRASH', recoverable: true, errorName: err.name } };
    }
  }

  // ── CAD only (Step 4 behavior) ──────────────────────────────────────────
  private async *runFabricate(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    const isFullPipeline = task.type === 'fabricate-print';

    yield { type: 'text', content: `[fabrication-agent] Starting CAD generation for: "${task.description}"\n\n` };

    const emitProgress = (stage: FabStage, attempt: number, message: string) => {
      broadcast(makeEvent('fabrication:progress' as any, {
        jobId: task.id,
        stage,
        attempt,
        message,
        progress: stage === 'stl-exported' ? (isFullPipeline ? 60 : 100) : Math.round((attempt / 3) * 50),
      }));
    };

    emitProgress('generating-script', 0, 'Starting CAD generation');

    const cadResult = await generateCad(task.description, task.id, emitProgress);

    if (signal.aborted) {
      yield { type: 'done', content: '(aborted)' };
      return;
    }

    if (!cadResult.success || !cadResult.stlPath) {
      yield { type: 'text', content: `\n✗ CAD generation failed after ${cadResult.attempts} attempt(s)\n` };
      yield { type: 'text', content: `  Last error: ${cadResult.lastError ?? 'unknown'}\n` };
      yield { type: 'error', content: cadResult.lastError ?? 'CAD generation failed', meta: { attempts: cadResult.attempts, recoverable: true } };
      return;
    }

    yield { type: 'text', content: `\n✓ CAD generation succeeded (attempt ${cadResult.attempts})\n` };
    yield { type: 'text', content: `  STL: ${cadResult.stlPath}\n` };
    yield { type: 'text', content: `  Size: ${cadResult.stlSize} bytes\n\n` };
    yield { type: 'file', content: cadResult.stlPath, meta: { fileType: 'stl', size: cadResult.stlSize } };

    await this.memorize(`Generated STL for "${task.description}": ${cadResult.stlPath} (${cadResult.stlSize} bytes, ${cadResult.attempts} attempt(s))`, {
      sourceType: 'agent',
      sourceRef: this.id,
      tags: ['fabrication', 'cad', 'stl', task.type],
    });

    if (!isFullPipeline) {
      yield { type: 'text', content: `\nThe STL file is ready. To slice and print, resubmit with type='fabricate-print'.\n` };
      yield { type: 'done', content: '' };
      return;
    }

    // ── Approval-gate fix: require approval BEFORE slice+print ─────────
    // The print submission is a real-world side effect (sends G-code to a
    // physical printer). Fail closed until the user approves via the real
    // /api/ghost-mode/findings/:id/approve endpoint.
    yield { type: 'text', content: `\n── Slice + Print pipeline ──\n` };
    yield { type: 'text', content: `[fabrication-agent] Print submission requires Ghost Mode approval.\n` };

    const approval = await this.waitForApproval(
      task,
      `Submit print job for: ${task.description.slice(0, 100)} (STL: ${cadResult.stlPath})`,
      signal,
    );

    if (approval !== 'approved') {
      yield { type: 'text', content: `\n  ✗ Print submission ${approval === 'rejected' ? 'REJECTED by user' : approval === 'timeout' ? 'timed out' : 'aborted'} — NOT submitted (fail closed)\n` };
      yield { type: 'text', content: `  The STL file is still available at: ${cadResult.stlPath}\n` };
      yield { type: 'text', content: `  You can resubmit with type='fabricate-print' to request approval again.\n` };
      addToolResult(task.id, {
        name: 'fabrication.sliceAndPrint',
        args: { stlPath: cadResult.stlPath },
        result: `refused: ${approval}`,
        success: false,
      });
      yield { type: 'done', content: '' };
      return;
    }

    yield { type: 'text', content: `  → Approved via real approval endpoint. Proceeding with slice + print.\n` };

    const slicePrintResult = await sliceAndPrint(cadResult.stlPath, task.id);

    if (signal.aborted) {
      yield { type: 'done', content: '(aborted)' };
      return;
    }

    if (slicePrintResult.success) {
      yield { type: 'text', content: `\n✓ Slice + Print succeeded\n` };
      yield { type: 'text', content: `  Printer: ${slicePrintResult.printer?.name} (${slicePrintResult.printer?.printerType})\n` };
      yield { type: 'text', content: `  G-code: ${slicePrintResult.sliceResult?.gcodePath} (${slicePrintResult.sliceResult?.gcodeSize} bytes)\n` };
      yield { type: 'text', content: `  Slicer profile: ${slicePrintResult.sliceResult?.slicerProfile}\n` };
      yield { type: 'text', content: `  Print job: ${slicePrintResult.printSubmission?.jobId}\n` };
      yield { type: 'text', content: `  Status: ${slicePrintResult.printStatus?.state} ${slicePrintResult.printStatus?.progressPercent}%\n\n` };
      yield { type: 'file', content: slicePrintResult.sliceResult?.gcodePath ?? '', meta: { fileType: 'gcode', size: slicePrintResult.sliceResult?.gcodeSize } };

      await this.memorize(`Sliced + printed "${task.description}": STL=${cadResult.stlPath}, G-code=${slicePrintResult.sliceResult?.gcodePath}, printer=${slicePrintResult.printer?.name}, job=${slicePrintResult.printSubmission?.jobId}`, {
        sourceType: 'agent',
        sourceRef: this.id,
        tags: ['fabrication', 'slice', 'print', task.type],
      });
      yield { type: 'done', content: '' };
    } else {
      yield { type: 'text', content: `\n✗ Slice + Print failed: ${slicePrintResult.error}\n` };
      yield { type: 'error', content: slicePrintResult.error ?? 'Slice+Print failed', meta: { recoverable: true } };
    }
  }

  // ── Discover printers only (Step 5) ─────────────────────────────────────
  private async *runDiscover(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    yield { type: 'text', content: `[fabrication-agent] Discovering printers...\n\n` };
    const printers = await discoverPrinters(task.id);
    if (signal.aborted) {
      yield { type: 'done', content: '(aborted)' };
      return;
    }
    yield { type: 'text', content: `Found ${printers.length} printer(s):\n` };
    for (const p of printers) {
      yield { type: 'text', content: `  - ${p.name} (${p.printerType}) at ${p.host}:${p.port}\n` };
    }
    yield { type: 'done', content: '' };
  }

  // ── Slice an existing STL (Step 5) ──────────────────────────────────────
  private async *runSlice(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    // task.description is the STL path for slice tasks
    const stlPath = task.description.trim();
    yield { type: 'text', content: `[fabrication-agent] Slicing STL: ${stlPath}\n\n` };

    // Use the first discovered printer for slicing profile
    const printers = await discoverPrinters(task.id);
    if (printers.length === 0) {
      yield { type: 'error', content: 'No printers discovered — cannot determine slice profile', meta: { recoverable: true } };
      return;
    }
    const printer = printers[0];
    yield { type: 'text', content: `Using printer: ${printer.name} (${printer.printerType})\n\n` };

    const sliceResult = await sliceStl(stlPath, printer.name, task.id);
    if (signal.aborted) {
      yield { type: 'done', content: '(aborted)' };
      return;
    }

    if (sliceResult.success) {
      yield { type: 'text', content: `\n✓ Slice succeeded\n` };
      yield { type: 'text', content: `  G-code: ${sliceResult.gcodePath}\n` };
      yield { type: 'text', content: `  Size: ${sliceResult.gcodeSize} bytes\n` };
      yield { type: 'text', content: `  Profile: ${sliceResult.slicerProfile}\n` };
      yield { type: 'file', content: sliceResult.gcodePath ?? '', meta: { fileType: 'gcode', size: sliceResult.gcodeSize } };
      yield { type: 'done', content: '' };
    } else {
      yield { type: 'error', content: sliceResult.error ?? 'Slice failed', meta: { recoverable: true } };
    }
  }
}

