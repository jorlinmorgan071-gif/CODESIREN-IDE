// server/src/orchestration/engines/ollama.ts
// Real Ollama engine — talks to http://localhost:11434 (Ollama's native API).
//
// Features:
//   1. Lists available models via GET /api/tags
//   2. Streams chat completions via POST /api/chat (stream: true)
//   3. Auto-starts `ollama serve` if the connection is refused
//   4. Falls back gracefully if Ollama is unavailable
//
// The user can select which Ollama model to use per-agent via the model picker.

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { config } from '../../config.js';
import type { EngineId, ModelRouterRequest, ModelRouterChunk, RouterMessage } from '../../types.js';
import type { InferenceEngine } from '../model-router.js';
import { withRetry } from './_retry.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_TIMEOUT = 5000; // 5s connection timeout

let ollamaServeProcess: ChildProcess | null = null;
let ollamaAvailable: boolean | null = null; // null = not checked yet

// ── Ollama availability + auto-start ─────────────────────────────────────

/**
 * Check if Ollama is running by hitting /api/tags.
 * Returns the list of models if available, empty array if not.
 */
export async function checkOllamaAvailable(): Promise<{ available: boolean; models: OllamaModel[]; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return { available: false, models: [], error: `Ollama responded ${res.status}` };
    }

    const data = await res.json() as { models?: Array<any> };
    ollamaAvailable = true;
    return {
      available: true,
      models: (data.models ?? []).map((m: any) => ({
        name: m.name,
        size: m.size,
        parameter_size: m.details?.parameter_size ?? m.parameter_size,
        quantization_level: m.details?.quantization_level ?? m.quantization_level,
        modified_at: m.modified_at,
      })),
    };
  } catch (err: any) {
    ollamaAvailable = false;
    return { available: false, models: [], error: err.message };
  }
}

/**
 * Try to start `ollama serve` if it's not running.
 * Looks for the ollama binary in common locations.
 */
export async function startOllamaServe(): Promise<{ started: boolean; error?: string }> {
  // Find the ollama binary
  let ollamaBin = process.env.OLLAMA_BIN ?? 'ollama';

  try {
    // Check if the binary exists
    execSync(`${ollamaBin} --version`, { stdio: 'pipe', timeout: 3000 });
  } catch {
    // Try common locations (Windows, macOS, Linux)
    const locations = [
      // Windows
      'C:\\Users\\Jorlin\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
      // Generic Windows pattern
      `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Ollama\\ollama.exe`,
      `${process.env.USERPROFILE ?? ''}\\AppData\\Local\\Programs\\Ollama\\ollama.exe`,
      // macOS
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      // Linux
      '/usr/bin/ollama',
      '/snap/bin/ollama',
    ];
    let found = false;
    for (const loc of locations) {
      try {
        execSync(`${loc} --version`, { stdio: 'pipe', timeout: 3000 });
        ollamaBin = loc;
        found = true;
        break;
      } catch { /* try next */ }
    }
    if (!found) {
      return { started: false, error: 'ollama binary not found. Install from https://ollama.com or set OLLAMA_BIN env var.' };
    }
  }

  // Start `ollama serve` as a background process
  try {
    ollamaServeProcess = spawn(ollamaBin, ['serve'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env, OLLAMA_HOST: '0.0.0.0:11434' },
    });

    ollamaServeProcess.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.log(`[ollama:serve] ${msg}`);
    });

    // Wait for Ollama to be ready (poll /api/tags for up to 10 seconds)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const check = await checkOllamaAvailable();
      if (check.available) {
        console.log(`[ollama] serve started successfully, ${check.models.length} model(s) available`);
        return { started: true };
      }
    }

    return { started: false, error: 'ollama serve started but did not become ready within 10s' };
  } catch (err: any) {
    return { started: false, error: `Failed to start ollama serve: ${err.message}` };
  }
}

/**
 * Stop the ollama serve process if we started it.
 */
export function stopOllamaServe(): void {
  if (ollamaServeProcess) {
    ollamaServeProcess.kill('SIGTERM');
    ollamaServeProcess = null;
    console.log('[ollama] serve stopped');
  }
}

// ── OllamaModel type ─────────────────────────────────────────────────────

export interface OllamaModel {
  name: string;
  size?: number;
  parameter_size?: string;
  quantization_level?: string;
  modified_at?: string;
}

// ── Active model selection ───────────────────────────────────────────────

// The user-selected Ollama model. Falls back to a default if not set.
let activeOllamaModel = process.env.OLLAMA_DEFAULT_MODEL ?? 'llama3.2';

// Per-agent model overrides
const agentModelOverrides = new Map<string, string>();

export function getActiveOllamaModel(): string {
  return activeOllamaModel;
}

export function setActiveOllamaModel(model: string): void {
  activeOllamaModel = model;
  console.log(`[ollama] active model set to: ${model}`);
}

export function getAgentModel(agentId: string): string {
  return agentModelOverrides.get(agentId) ?? activeOllamaModel;
}

export function setAgentModel(agentId: string, model: string): void {
  agentModelOverrides.set(agentId, model);
  console.log(`[ollama] model for ${agentId} set to: ${model}`);
}

export function clearAgentModel(agentId: string): void {
  agentModelOverrides.delete(agentId);
}

export function getAllAgentModels(): Record<string, string> {
  const result: Record<string, string> = { _default: activeOllamaModel };
  for (const [agentId, model] of agentModelOverrides) {
    result[agentId] = model;
  }
  return result;
}

// ── OllamaEngine ─────────────────────────────────────────────────────────

export class OllamaEngine implements InferenceEngine {
  id: EngineId = 'ollama';

  async *stream(req: ModelRouterRequest): AsyncGenerator<ModelRouterChunk> {
    const model = getAgentModel(req.agentId);

    // Convert RouterMessage[] to Ollama message format
    const messages = req.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const body = {
      model,
      messages,
      stream: true,
      options: {
        temperature: req.temperature ?? 0.7,
        num_predict: req.maxTokens ?? 1024,
      },
    };

    console.log(`[ollama] streaming model=${model} agent=${req.agentId} mode=${req.executionMode} messages=${messages.length}`);

    // UPR Phase 1 Step 2a — wrap fetch with withRetry for 5xx retry.
    // The existing auto-start-on-connection-failure behavior is preserved
    // (the operation below catches connection errors and auto-starts Ollama
    // before retrying the fetch).
    let lastErrText = '';
    const retryResult = await withRetry(
      async () => {
        let r: Response;
        try {
          r = await fetch(`${OLLAMA_HOST}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch (err: any) {
          // Connection failed — try auto-start (existing behavior preserved)
          console.log(`[ollama] connection failed (${err.message}), attempting auto-start...`);
          const startResult = await startOllamaServe();
          if (!startResult.started) {
            // Auto-start failed — this is a non-retryable connection failure
            // (not a transient HTTP error). Return as a 503-equivalent so
            // withRetry treats it as retryable but bounded.
            lastErrText = `unavailable: ${startResult.error}`;
            return { ok: false as const, status: 503 };
          }
          try {
            r = await fetch(`${OLLAMA_HOST}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          } catch (err2: any) {
            lastErrText = `still unavailable after auto-start: ${err2.message}`;
            return { ok: false as const, status: 503 };
          }
        }

        if (!r.ok) {
          lastErrText = await r.text().catch(() => '(no response body)');
          return { ok: false as const, status: r.status };
        }
        return { ok: true as const, value: r };
      },
      { engineLabel: 'ollama', signal: req.signal },
    );

    if (!retryResult.ok) {
      // Distinguish between connection-failure (auto-start didn't help) and
      // genuine HTTP errors. For connection failures, the message is the
      // auto-start error string; for HTTP errors, it's the response body.
      const isConnectionFailure = lastErrText.startsWith('unavailable') || lastErrText.startsWith('still unavailable');
      if (isConnectionFailure) {
        yield { delta: `[ollama] ${lastErrText}`, done: false };
      } else {
        yield { delta: `[ollama] error ${retryResult.status}: ${lastErrText.slice(0, 200)}`, done: false };
      }
      yield { delta: '', done: true };
      return;
    }

    const response = retryResult.value;

    // Parse the NDJSON stream — Ollama sends one JSON object per line
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message?.content) {
            yield { delta: chunk.message.content, done: false };
          }
          if (chunk.done) {
            yield { delta: '', done: true };
            return;
          }
        } catch {
          // skip malformed line
        }
      }
    }

    yield { delta: '', done: true };
  }
}
