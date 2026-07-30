// server/src/agents/fabrication/printer.ts
// Slicing + printer discovery + print submission.
//
// Port of the donor's printer_agent.py, re-expressed in TypeScript as a native
// Code Siren module. The key difference from the donor: ALL printer operations
// go through the PrinterClient interface (printer-client.ts). The stub impl is
// injected by default; real Moonraker/OctoPrint/PrusaLink impls are drop-in
// replacements at deployment time.
//
// Per Step 5 user condition: "the trace evidence for this step should show the
// stub being invoked through that interface, not called directly." Every
// printer operation is recorded as a trace step with the PrinterClient
// implementation name in the meta — so the trace proves the call went through
// the interface, not directly to the stub.

import { getPrinterClient, type Printer, type SliceResult, type PrintSubmission, type PrintStatus } from './printer-client.js';
import { addStep, addToolResult } from '../../observability/traces.js';
import { broadcast, makeEvent } from '../../ws/events.js';

export interface SliceAndPrintResult {
  success: boolean;
  printer?: Printer;
  sliceResult?: SliceResult;
  printSubmission?: PrintSubmission;
  printStatus?: PrintStatus;
  error?: string;
}

/**
 * Discover printers on the local network.
 * Calls PrinterClient.discoverPrinters() — the active impl (stub or real)
 * handles the actual discovery. The trace records the impl name.
 */
export async function discoverPrinters(traceId: string): Promise<Printer[]> {
  const client = getPrinterClient();
  const stepStart = Date.now();

  addStep(traceId, {
    kind: 'tool-call',
    label: `printer.discoverPrinters() via PrinterClient (impl=${client.implementation})`,
    input: { implementation: client.implementation },
    meta: { viaInterface: true, implementation: client.implementation },
  });

  const printers = await client.discoverPrinters();

  addStep(traceId, {
    kind: 'tool-call',
    label: `printer.discoverPrinters() → ${printers.length} printer(s) found`,
    output: printers.map((p) => ({ name: p.name, host: p.host, type: p.printerType })),
    durationMs: Date.now() - stepStart,
    meta: { viaInterface: true, implementation: client.implementation, count: printers.length },
  });
  addToolResult(traceId, {
    name: 'printer.discoverPrinters',
    args: { implementation: client.implementation },
    result: `${printers.length} printer(s)`,
    success: true,
  });

  // Emit fabrication:progress for the discovery stage
  broadcast(makeEvent('fabrication:progress' as any, {
    jobId: traceId,
    stage: 'printer-discovered',
    attempt: 1,
    message: `Discovered ${printers.length} printer(s) via ${client.implementation} client`,
    progress: 70,
  }));

  return printers;
}

/**
 * Slice an STL file into G-code.
 * Calls PrinterClient.slice() — the active impl handles the actual slicing
 * (OrcaSlicer CLI in real impl, fake G-code in stub).
 */
export async function sliceStl(
  stlPath: string,
  printerName: string,
  traceId: string,
): Promise<SliceResult> {
  const client = getPrinterClient();
  const stepStart = Date.now();

  addStep(traceId, {
    kind: 'tool-call',
    label: `printer.slice() via PrinterClient (impl=${client.implementation}, printer="${printerName}")`,
    input: { stlPath, printerName, implementation: client.implementation },
    meta: { viaInterface: true, implementation: client.implementation },
  });

  // Emit fabrication:progress for the slicing stage
  broadcast(makeEvent('fabrication:progress' as any, {
    jobId: traceId,
    stage: 'slicing',
    attempt: 1,
    message: `Slicing ${stlPath} for ${printerName} via ${client.implementation} client`,
    progress: 80,
  }));

  const result = await client.slice(stlPath, printerName);

  addStep(traceId, {
    kind: 'tool-call',
    label: `printer.slice() → ${result.success ? 'ok' : 'failed'}${result.gcodePath ? ` (${result.gcodeSize} bytes G-code)` : ''}`,
    output: {
      success: result.success,
      gcodePath: result.gcodePath,
      gcodeSize: result.gcodeSize,
      slicerProfile: result.slicerProfile,
      duration: result.duration,
      error: result.error,
    },
    durationMs: Date.now() - stepStart,
    meta: { viaInterface: true, implementation: client.implementation, success: result.success },
  });
  addToolResult(traceId, {
    name: 'printer.slice',
    args: { stlPath, printerName, implementation: client.implementation },
    result: result.success ? `G-code ${result.gcodeSize} bytes` : `failed: ${result.error}`,
    success: result.success,
  });

  if (result.success) {
    broadcast(makeEvent('fabrication:progress' as any, {
      jobId: traceId,
      stage: 'sliced',
      attempt: 1,
      message: `Sliced → ${result.gcodePath} (${result.gcodeSize} bytes)`,
      progress: 90,
    }));
  }

  return result;
}

/**
 * Submit a print job to a printer.
 * Calls PrinterClient.submitPrint() — the active impl handles the actual
 * upload + print start (HTTP to Moonraker/OctoPrint/PrusaLink in real impl,
 * canned response in stub).
 */
export async function submitPrint(
  gcodePath: string,
  printerId: string,
  traceId: string,
): Promise<PrintSubmission> {
  const client = getPrinterClient();
  const stepStart = Date.now();

  addStep(traceId, {
    kind: 'tool-call',
    label: `printer.submitPrint() via PrinterClient (impl=${client.implementation}, printerId="${printerId}")`,
    input: { gcodePath, printerId, implementation: client.implementation },
    meta: { viaInterface: true, implementation: client.implementation },
  });

  broadcast(makeEvent('fabrication:progress' as any, {
    jobId: traceId,
    stage: 'submitting-print',
    attempt: 1,
    message: `Submitting ${gcodePath} to printer ${printerId} via ${client.implementation} client`,
    progress: 95,
  }));

  const result = await client.submitPrint(gcodePath, printerId);

  addStep(traceId, {
    kind: 'tool-call',
    label: `printer.submitPrint() → ${result.success ? 'ok' : 'failed'}${result.jobId ? ` (job=${result.jobId})` : ''}`,
    output: {
      success: result.success,
      jobId: result.jobId,
      message: result.message,
      error: result.error,
    },
    durationMs: Date.now() - stepStart,
    meta: { viaInterface: true, implementation: client.implementation, success: result.success },
  });
  addToolResult(traceId, {
    name: 'printer.submitPrint',
    args: { gcodePath, printerId, implementation: client.implementation },
    result: result.success ? `job ${result.jobId}` : `failed: ${result.error}`,
    success: result.success,
  });

  if (result.success) {
    broadcast(makeEvent('fabrication:progress' as any, {
      jobId: traceId,
      stage: 'print-submitted',
      attempt: 1,
      message: `Print submitted: ${result.message}`,
      progress: 100,
    }));
  }

  return result;
}

/**
 * Get the current status of a print job.
 * Calls PrinterClient.getPrintStatus() — the active impl handles the actual
 * polling (HTTP to printer API in real impl, canned status in stub).
 */
export async function getPrintStatus(printerId: string, traceId: string): Promise<PrintStatus> {
  const client = getPrinterClient();
  const stepStart = Date.now();

  addStep(traceId, {
    kind: 'tool-call',
    label: `printer.getPrintStatus() via PrinterClient (impl=${client.implementation}, printerId="${printerId}")`,
    input: { printerId, implementation: client.implementation },
    meta: { viaInterface: true, implementation: client.implementation },
  });

  const status = await client.getPrintStatus(printerId);

  addStep(traceId, {
    kind: 'tool-call',
    label: `printer.getPrintStatus() → state=${status.state} progress=${status.progressPercent}%`,
    output: status,
    durationMs: Date.now() - stepStart,
    meta: { viaInterface: true, implementation: client.implementation },
  });
  addToolResult(traceId, {
    name: 'printer.getPrintStatus',
    args: { printerId, implementation: client.implementation },
    result: `${status.state} ${status.progressPercent}%`,
    success: true,
  });

  return status;
}

/**
 * Full slice + print pipeline. Convenience function that chains:
 *   1. discoverPrinters (optional — can pass a printerId directly)
 *   2. slice (STL → G-code)
 *   3. submitPrint (G-code → printer)
 *   4. getPrintStatus (poll once for confirmation)
 *
 * All steps go through the PrinterClient interface and are traced.
 */
export async function sliceAndPrint(
  stlPath: string,
  traceId: string,
  printerId?: string,
): Promise<SliceAndPrintResult> {
  // 1. Discover printers if no printerId provided
  let printer: Printer | undefined;
  if (!printerId) {
    const printers = await discoverPrinters(traceId);
    if (printers.length === 0) {
      return { success: false, error: 'No printers discovered' };
    }
    printer = printers[0];  // pick first available
    printerId = printer.id;
  } else {
    // Look up the printer by ID via discover (stub returns all, real impl may cache)
    const printers = await discoverPrinters(traceId);
    printer = printers.find((p) => p.id === printerId);
    if (!printer) {
      return { success: false, error: `Printer not found: ${printerId}` };
    }
  }

  // 2. Slice
  const sliceResult = await sliceStl(stlPath, printer.name, traceId);
  if (!sliceResult.success || !sliceResult.gcodePath) {
    return { success: false, printer, sliceResult, error: sliceResult.error ?? 'Slice failed' };
  }

  // 3. Submit print
  const printSubmission = await submitPrint(sliceResult.gcodePath, printerId!, traceId);
  if (!printSubmission.success) {
    return { success: false, printer, sliceResult, printSubmission, error: printSubmission.error ?? 'Print submission failed' };
  }

  // 4. Poll status once
  const printStatus = await getPrintStatus(printerId!, traceId);

  return { success: true, printer, sliceResult, printSubmission, printStatus };
}
