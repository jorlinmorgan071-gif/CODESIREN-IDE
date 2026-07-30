// server/src/agents/fabrication/printer-client.ts
// PrinterClient interface + StubPrinterClient impl.
//
// Per Step 5 user condition: "make the stub boundary explicit in code (e.g. an
// interface like PrinterClient with a StubPrinterClient impl), not just a flag
// inside printer.ts. That way swapping in real Moonraker/OctoPrint/PrusaLink
// clients at deployment time is a drop-in implementation of the same interface,
// not a rewrite — and the trace evidence for this step should show the stub
// being invoked through that interface, not called directly."
//
// The interface abstracts the four operations the Fabrication Agent needs:
//   1. discoverPrinters() — mDNS scan (donor uses zeroconf) or manual config
//   2. slice(stlPath, printerName) — OrcaSlicer/PrusaSlicer CLI invocation
//   3. submitPrint(gcodePath, printerId) — upload + start print via printer API
//   4. getPrintStatus(printerId) — poll print progress
//
// Deployment-time swap: implement this interface with MoonrakerPrinterClient,
// OctoPrintPrinterClient, or PrusaLinkPrinterClient. The Fabrication Agent and
// printer.ts never import StubPrinterClient directly — they receive a
// PrinterClient via dependency injection.

// ── Types (mirror donor's PrinterType + Printer + PrintStatus) ───────────

export type PrinterType = 'octoprint' | 'moonraker' | 'prusalink' | 'unknown';

export interface Printer {
  id: string;                  // uuid — our internal ID
  name: string;
  host: string;
  port: number;
  printerType: PrinterType;
  apiKey?: string;
  cameraUrl?: string;
}

export interface SliceResult {
  success: boolean;
  gcodePath?: string;
  gcodeSize?: number;
  slicerProfile?: string;
  duration?: number;          // seconds
  error?: string;
}

export interface PrintSubmission {
  success: boolean;
  jobId?: string;             // printer-side job ID
  message?: string;
  error?: string;
}

export interface PrintStatus {
  printerId: string;
  state: 'idle' | 'printing' | 'paused' | 'error' | 'completed';
  progressPercent: number;
  timeRemaining?: string;
  timeElapsed?: string;
  filename?: string;
  temperatures?: Record<string, { actual: number; target: number }>;
}

// ── PrinterClient interface ──────────────────────────────────────────────

export interface PrinterClient {
  /** Identifies which implementation is active — appears in trace meta. */
  readonly implementation: string;  // 'stub' | 'moonraker' | 'octoprint' | 'prusalink'

  /**
   * Discover printers on the local network via mDNS.
   * Donor uses zeroconf ServiceBrowser for _octoprint._tcp, _moonraker._tcp,
   * _klipper._tcp, _http._tcp. Real implementations probe unknown hosts to
   * identify their type.
   */
  discoverPrinters(): Promise<Printer[]>;

  /**
   * Slice an STL file into G-code using OrcaSlicer or PrusaSlicer.
   * Donor detects the slicer path + profiles dir, auto-matches a profile
   * based on the printer name, then runs the slicer CLI.
   */
  slice(stlPath: string, printerName: string): Promise<SliceResult>;

  /**
   * Upload G-code to a printer and start a print job.
   * Moonraker: POST /server/files/upload + POST /printer/print/start
   * OctoPrint: POST /api/files/local + POST /api/job
   * PrusaLink: POST /api/files + POST /api/job
   */
  submitPrint(gcodePath: string, printerId: string): Promise<PrintSubmission>;

  /**
   * Poll the current print status.
   * Moonraker: GET /printer_objects/query
   * OctoPrint: GET /api/job
   * PrusaLink: GET /api/job
   */
  getPrintStatus(printerId: string): Promise<PrintStatus>;
}

// ── StubPrinterClient ────────────────────────────────────────────────────
// Drop-in stub for development and testing. Returns canned data — no real
// mDNS, no real slicer, no real printer. The trace shows this impl being
// invoked THROUGH the PrinterClient interface, so swapping in a real client
// at deployment time is a drop-in change (inject a different impl).

import { v4 as uuid } from 'uuid';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { STL_OUTPUT_DIR } from '../../sidecars/manager.js';

const GCODE_OUTPUT_DIR = join(STL_OUTPUT_DIR, '..', 'gcode-out');

export class StubPrinterClient implements PrinterClient {
  readonly implementation = 'stub';

  private stubPrinters: Printer[] = [
    {
      id: 'stub-printer-1',
      name: 'Creality K1 (stub)',
      host: '192.168.1.50',
      port: 80,
      printerType: 'moonraker',
    },
    {
      id: 'stub-printer-2',
      name: 'Prusa MK4 (stub)',
      host: '192.168.1.51',
      port: 80,
      printerType: 'prusalink',
    },
  ];

  async discoverPrinters(): Promise<Printer[]> {
    // Simulate mDNS discovery delay
    await new Promise((r) => setTimeout(r, 100));
    return [...this.stubPrinters];
  }

  async slice(stlPath: string, printerName: string): Promise<SliceResult> {
    // Simulate slicer invocation — produce a fake G-code file
    if (!existsSync(GCODE_OUTPUT_DIR)) {
      mkdirSync(GCODE_OUTPUT_DIR, { recursive: true });
    }
    if (!existsSync(stlPath)) {
      return { success: false, error: `STL not found: ${stlPath}` };
    }

    await new Promise((r) => setTimeout(r, 200));  // simulate slice time

    const stlBase = basename(stlPath, '.stl');
    const gcodePath = join(GCODE_OUTPUT_DIR, `${stlBase}.gcode`);
    // Write a minimal G-code file — real slicers produce megabytes, this is enough to prove the pipeline
    const fakeGcode = [
      `; Generated by StubPrinterClient for ${printerName}`,
      `; Source STL: ${stlPath}`,
      `; Slicer profile: auto-matched-stub-profile`,
      `; Estimated time: 00:15:00`,
      `; Filament used: 1.2m`,
      '',
      'G28 ; home all axes',
      'G1 Z5 F3000 ; lift nozzle',
      'G1 X0 Y0 F3000 ; move to start',
      'M104 S200 ; set hotend temp',
      'M140 S60 ; set bed temp',
      'M109 S200 ; wait for hotend',
      'M190 S60 ; wait for bed',
      '',
      '; --- print layers ---',
      'G1 Z0.2 F3000',
      'G1 X10 Y10 E1 F600 ; layer 1',
      'G1 X20 Y10 E2 F600',
      'G1 X20 Y20 E3 F600',
      'G1 X10 Y20 E4 F600',
      'G1 X10 Y10 E5 F600',
      '',
      '; --- finalize ---',
      'M104 S0 ; hotend off',
      'M140 S0 ; bed off',
      'G28 X Y ; home XY',
      'M84 ; disable motors',
      '',
    ].join('\n');
    writeFileSync(gcodePath, fakeGcode, 'utf8');
    const gcodeSize = Buffer.byteLength(fakeGcode, 'utf8');

    return {
      success: true,
      gcodePath,
      gcodeSize,
      slicerProfile: `stub-profile-for-${printerName.toLowerCase().replace(/\s+/g, '-')}`,
      duration: 900,  // 15 minutes
    };
  }

  async submitPrint(gcodePath: string, printerId: string): Promise<PrintSubmission> {
    await new Promise((r) => setTimeout(r, 150));  // simulate upload time
    const printer = this.stubPrinters.find((p) => p.id === printerId);
    if (!printer) {
      return { success: false, error: `Unknown printer: ${printerId}` };
    }
    if (!existsSync(gcodePath)) {
      return { success: false, error: `G-code not found: ${gcodePath}` };
    }
    return {
      success: true,
      jobId: `stub-job-${uuid().slice(0, 8)}`,
      message: `Print submitted to ${printer.name} (${gcodePath})`,
    };
  }

  async getPrintStatus(printerId: string): Promise<PrintStatus> {
    await new Promise((r) => setTimeout(r, 50));
    const printer = this.stubPrinters.find((p) => p.id === printerId);
    if (!printer) {
      return {
        printerId,
        state: 'error',
        progressPercent: 0,
      };
    }
    // Return a deterministic "printing at 42%" status
    return {
      printerId,
      state: 'printing',
      progressPercent: 42,
      timeRemaining: '00:08:42',
      timeElapsed: '00:06:18',
      filename: 'cad-stub.gcode',
      temperatures: {
        hotend: { actual: 199, target: 200 },
        bed: { actual: 59, target: 60 },
      },
    };
  }
}

// ── Dependency injection ─────────────────────────────────────────────────
// The active PrinterClient. Defaults to StubPrinterClient. At deployment time,
// swap this for a real implementation (MoonrakerPrinterClient etc.) — the
// Fabrication Agent and printer.ts call through the interface, never directly.

let activePrinterClient: PrinterClient = new StubPrinterClient();

export function getPrinterClient(): PrinterClient {
  return activePrinterClient;
}

export function setPrinterClient(client: PrinterClient): void {
  activePrinterClient = client;
  console.log(`[printer-client] active implementation: ${client.implementation}`);
}
