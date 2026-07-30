// server/src/agents/operative/device-client.ts
// DeviceClient interface + StubDeviceClient impl + KasaSidecarDeviceClient impl.
//
// Per directive Section 1: "Operative Agent (new) — Browser automation + smart
// home (Kasa)." and Step 7: "python-kasa as a second tool on the same agent,
// not a second agent."
//
// Per Step 7 user condition: the kasa sidecar gets its OWN lifecycle proof
// (no orphan on Node death, crash → clean agent:error not hang) — not just a
// design-doc reference to Step 4's build123d proof.

import { v4 as uuid } from 'uuid';
import { sidecarManager, ensureBuild123dSidecar, SidecarCrashedError } from '../../sidecars/manager.js';
import { addStep, addToolResult } from '../../observability/traces.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KASA_SIDECAR_DIR = join(__dirname, '..', '..', '..', 'sidecars', 'kasa');
const KASA_SIDECAR_SCRIPT = join(KASA_SIDECAR_DIR, 'sidecar.py');

// ── Types ────────────────────────────────────────────────────────────────

export interface SmartDevice {
  ip: string;
  alias: string;
  model: string;
  type: 'bulb' | 'plug' | 'strip' | 'dimmer' | 'unknown';
  isOn: boolean;
  brightness?: number;
  hsv?: [number, number, number];
  hasColor: boolean;
  hasBrightness: boolean;
}

export interface DeviceCommandResult {
  success: boolean;
  device?: SmartDevice;
  action?: string;
  error?: string;
  source: string;  // 'stub' | 'kasa-sidecar'
}

// ── DeviceClient interface ───────────────────────────────────────────────

export interface DeviceClient {
  readonly implementation: string;  // 'stub' | 'kasa-sidecar'

  discoverDevices(traceId?: string): Promise<{ devices: SmartDevice[]; source: string }>;
  turnOn(target: string, traceId?: string): Promise<DeviceCommandResult>;
  turnOff(target: string, traceId?: string): Promise<DeviceCommandResult>;
  setBrightness(target: string, brightness: number, traceId?: string): Promise<DeviceCommandResult>;
  setColor(target: string, color: string | [number, number, number], traceId?: string): Promise<DeviceCommandResult>;
}

// ── StubDeviceClient ─────────────────────────────────────────────────────
// Pure TypeScript stub — no sidecar. Returns canned devices + mutates in-memory state.

export class StubDeviceClient implements DeviceClient {
  readonly implementation = 'stub';

  private devices: Map<string, SmartDevice> = new Map([
    ['192.168.1.100', { ip: '192.168.1.100', alias: 'Living Room Light', model: 'KL125(US)', type: 'bulb', isOn: false, brightness: 0, hasColor: true, hasBrightness: true }],
    ['192.168.1.101', { ip: '192.168.1.101', alias: 'Desk Lamp', model: 'KL110(US)', type: 'dimmer', isOn: true, brightness: 75, hasColor: false, hasBrightness: true }],
    ['192.168.1.102', { ip: '192.168.1.102', alias: 'Coffee Maker Plug', model: 'HS100(US)', type: 'plug', isOn: false, hasColor: false, hasBrightness: false }],
  ]);

  private resolve(target: string): SmartDevice | undefined {
    for (const dev of this.devices.values()) {
      if (dev.ip === target || dev.alias.toLowerCase() === target.toLowerCase()) return dev;
    }
    return undefined;
  }

  async discoverDevices(_traceId?: string): Promise<{ devices: SmartDevice[]; source: string }> {
    return { devices: [...this.devices.values()], source: 'stub' };
  }

  async turnOn(target: string, _traceId?: string): Promise<DeviceCommandResult> {
    const dev = this.resolve(target);
    if (!dev) return { success: false, error: `device not found: ${target}`, source: 'stub' };
    dev.isOn = true;
    if ((dev.type === 'bulb' || dev.type === 'dimmer') && dev.brightness === 0) dev.brightness = 100;
    return { success: true, device: dev, action: 'turn_on', source: 'stub' };
  }

  async turnOff(target: string, _traceId?: string): Promise<DeviceCommandResult> {
    const dev = this.resolve(target);
    if (!dev) return { success: false, error: `device not found: ${target}`, source: 'stub' };
    dev.isOn = false;
    return { success: true, device: dev, action: 'turn_off', source: 'stub' };
  }

  async setBrightness(target: string, brightness: number, _traceId?: string): Promise<DeviceCommandResult> {
    const dev = this.resolve(target);
    if (!dev) return { success: false, error: `device not found: ${target}`, source: 'stub' };
    if (!dev.hasBrightness) return { success: false, error: `${target} does not support brightness`, source: 'stub' };
    dev.brightness = Math.max(0, Math.min(100, brightness));
    dev.isOn = dev.brightness > 0;
    return { success: true, device: dev, action: 'set_brightness', source: 'stub' };
  }

  async setColor(target: string, color: string | [number, number, number], _traceId?: string): Promise<DeviceCommandResult> {
    const dev = this.resolve(target);
    if (!dev) return { success: false, error: `device not found: ${target}`, source: 'stub' };
    if (!dev.hasColor) return { success: false, error: `${target} does not support color`, source: 'stub' };
    // Accept string or [h,s,v]
    if (typeof color === 'string') {
      const COLOR_MAP: Record<string, [number, number, number]> = {
        red: [0, 100, 100], orange: [30, 100, 100], yellow: [60, 100, 100],
        green: [120, 100, 100], cyan: [180, 100, 100], blue: [240, 100, 100],
        purple: [300, 100, 100], pink: [300, 50, 100], white: [0, 0, 100],
      };
      const hsv = COLOR_MAP[color.toLowerCase()];
      if (!hsv) return { success: false, error: `unknown color: ${color}`, source: 'stub' };
      dev.hsv = hsv;
    } else {
      dev.hsv = color;
    }
    dev.isOn = true;
    return { success: true, device: dev, action: 'set_color', source: 'stub' };
  }
}

// ── KasaSidecarDeviceClient ──────────────────────────────────────────────
// Routes all device operations through the python-kasa sidecar under SidecarManager.
// This is the impl that proves the Step 7 lifecycle contract (crash → agent:error,
// no orphan on Node death) — same as build123d in Step 4, but re-proven for kasa.

export class KasaSidecarDeviceClient implements DeviceClient {
  readonly implementation = 'kasa-sidecar';

  constructor() {
    // Don't spawn in constructor — spawn lazily on first request.
    // This avoids race conditions at module load time.
  }

  private ensureSidecar(): void {
    if (sidecarManager.isRunning('kasa')) return;
    sidecarManager.removeDead('kasa');
    if (!existsSync(KASA_SIDECAR_SCRIPT)) {
      throw new Error(`kasa sidecar script not found at ${KASA_SIDECAR_SCRIPT}`);
    }
    sidecarManager.spawn('kasa', process.env.PYTHON3 ?? 'python3', [KASA_SIDECAR_SCRIPT], {
      cwd: KASA_SIDECAR_DIR,
    });
  }

  private async request(req: Record<string, unknown>, traceId?: string): Promise<any> {
    this.ensureSidecar();  // re-spawn if crashed
    // Don't pass 'id' — sidecarManager.request() generates its own id and
    // matches the response by that id. If we pass our own id, the spread
    // { id, ...req } in the manager would overwrite the manager's id with ours,
    // causing a mismatch.
    const reqCopy = { ...req };
    delete reqCopy.id;
    if (traceId) {
      addStep(traceId, {
        kind: 'tool-call',
        label: `kasa-sidecar.request(${req.type}) via DeviceClient (impl=kasa-sidecar)`,
        input: { ...reqCopy, viaInterface: true },
        meta: { viaInterface: true, implementation: 'kasa-sidecar', sidecar: 'kasa' },
      });
    }
    try {
      const resp = await sidecarManager.request('kasa', reqCopy, 30_000);
      if (traceId) {
        addStep(traceId, {
          kind: 'tool-call',
          label: `kasa-sidecar.response ok=${resp.ok}`,
          output: resp,
          meta: { viaInterface: true, implementation: 'kasa-sidecar', ok: resp.ok },
        });
        addToolResult(traceId, {
          name: `device.${req.type}`,
          args: { ...req, implementation: 'kasa-sidecar', viaInterface: true },
          result: resp.ok ? 'ok' : `failed: ${resp.error}`,
          success: resp.ok,
        });
      }
      return resp;
    } catch (err: any) {
      if (traceId) {
        addStep(traceId, {
          kind: 'error',
          label: `kasa-sidecar crashed: ${err.message}`,
          meta: { sidecarCrash: true, errorName: err.name },
        });
      }
      throw err;  // re-throw — Operative Agent catches SidecarCrashedError
    }
  }

  async discoverDevices(traceId?: string): Promise<{ devices: SmartDevice[]; source: string }> {
    const resp = await this.request({ type: 'discover' }, traceId);
    if (!resp.ok) return { devices: [], source: 'kasa-sidecar' };
    const devices: SmartDevice[] = (resp.devices ?? []).map((d: any) => ({
      ip: d.ip,
      alias: d.alias,
      model: d.model,
      type: d.type,
      isOn: d.is_on,
      brightness: d.brightness,
      hasColor: d.has_color,
      hasBrightness: d.has_brightness,
    }));
    return { devices, source: resp.source ?? 'kasa-sidecar' };
  }

  async turnOn(target: string, traceId?: string): Promise<DeviceCommandResult> {
    const resp = await this.request({ type: 'turn_on', target }, traceId);
    return this.toResult(resp, 'turn_on');
  }

  async turnOff(target: string, traceId?: string): Promise<DeviceCommandResult> {
    const resp = await this.request({ type: 'turn_off', target }, traceId);
    return this.toResult(resp, 'turn_off');
  }

  async setBrightness(target: string, brightness: number, traceId?: string): Promise<DeviceCommandResult> {
    const resp = await this.request({ type: 'set_brightness', target, brightness }, traceId);
    return this.toResult(resp, 'set_brightness');
  }

  async setColor(target: string, color: string | [number, number, number], traceId?: string): Promise<DeviceCommandResult> {
    const resp = await this.request({ type: 'set_color', target, color }, traceId);
    return this.toResult(resp, 'set_color');
  }

  private toResult(resp: any, action: string): DeviceCommandResult {
    if (!resp.ok) return { success: false, error: resp.error, action, source: 'kasa-sidecar' };
    const d = resp.device;
    return {
      success: true,
      action,
      source: 'kasa-sidecar',
      device: d ? {
        ip: d.ip, alias: d.alias, model: d.model, type: d.type,
        isOn: d.is_on, brightness: d.brightness, hsv: d.hsv,
        hasColor: d.has_color, hasBrightness: d.has_brightness,
      } : undefined,
    };
  }
}

// ── Dependency injection ─────────────────────────────────────────────────

let activeDeviceClient: DeviceClient = new KasaSidecarDeviceClient();

export function getDeviceClient(): DeviceClient {
  return activeDeviceClient;
}

export function setDeviceClient(client: DeviceClient): void {
  activeDeviceClient = client;
  console.log(`[device-client] active implementation: ${client.implementation}`);
}
