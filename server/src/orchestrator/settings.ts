// server/src/orchestrator/settings.ts
// Orchestrator settings — directive Section 1.1.
//
// Persists the user's engine preference + approval mode to a JSON file
// at server/.runtime/orchestrator-settings.json. Same pattern the
// directive references: "Persisted the same way engine-settings.json
// persists the model preference — a simple JSON file, not a new DB table."
//
// Per directive Section 6: no new DB table for settings (the relay_plans
// table holds plan data, not engine preference).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestratorEngineId } from './engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(__dirname, '..', '..', '.runtime', 'orchestrator-settings.json');

export type ApprovalMode = 'auto' | 'default';

export interface Tier1ModelOption {
  id: string;          // OpenRouter model id
  label: string;       // display label (short name)
  desc?: string;       // optional description shown in the Settings UI
}

// Per directive Section 3.1: small list of genuinely free OpenRouter models.
//
// Last verified 2026-07-25 via GET https://openrouter.ai/api/v1/models
// filtered for pricing.prompt === '0'. The free model lineup changes
// frequently — if a model id stops working, re-run the verification
// (curl 'https://openrouter.ai/api/v1/models' | jq '.data[] | select(.pricing.prompt == "0") | .id')
// and update this list. The rest of the chat routing is model-agnostic.
//
// Note: the originally-requested IDs (qwen/qwen3-coder:free,
// meta-llama/llama-3.3-70b-instruct:free, meta-llama/llama-4-maverick:free,
// openai/gpt-4o-mini-search-preview:free) were NOT available as free
// models at verification time — none of those exact IDs exist in the
// current OpenRouter catalog. We use the closest confirmed-available
// equivalents below.
export const TIER1_MODELS: Tier1ModelOption[] = [
  { id: 'openai/gpt-oss-20b:free', label: 'GPT-OSS 20B', desc: 'OpenAI open-source 20B — best free general model' },
  { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', desc: 'Strong general-purpose model — 1M context' },
  { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B', desc: 'Lighter Gemma variant — faster responses' },
  { id: 'cohere/north-mini-code:free', label: 'North Mini Code', desc: 'Cohere coding-focused model' },
];

export interface OrchestratorSettings {
  engine: OrchestratorEngineId;
  approvalMode: ApprovalMode;
  tier1Model: string;       // OpenRouter model id (one of TIER1_MODELS[].id)
}

const DEFAULT_SETTINGS: OrchestratorSettings = {
  engine: 'nvidia-nemotron',
  approvalMode: 'default',
  // Default to the best free general-purpose model currently available.
  // Per directive: was previously set to a Qwen model that no longer
  // exists as free on OpenRouter. Updated 2026-07-25 to
  // openai/gpt-oss-20b:free (confirmed available + free).
  tier1Model: 'openai/gpt-oss-20b:free',
};

let cachedSettings: OrchestratorSettings | null = null;

export function getOrchestratorSettings(): OrchestratorSettings {
  if (cachedSettings) return cachedSettings;
  try {
    if (!existsSync(SETTINGS_PATH)) {
      cachedSettings = { ...DEFAULT_SETTINGS };
      return cachedSettings;
    }
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<OrchestratorSettings>;
    cachedSettings = {
      engine: parsed.engine ?? DEFAULT_SETTINGS.engine,
      approvalMode: parsed.approvalMode ?? DEFAULT_SETTINGS.approvalMode,
      tier1Model: parsed.tier1Model ?? DEFAULT_SETTINGS.tier1Model,
    };
    return cachedSettings;
  } catch (err) {
    console.warn(`[orchestrator:settings] failed to read ${SETTINGS_PATH}: ${err instanceof Error ? err.message : err}. Using defaults.`);
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }
}

export function setOrchestratorSettings(patch: Partial<OrchestratorSettings>): OrchestratorSettings {
  const current = getOrchestratorSettings();
  const next: OrchestratorSettings = {
    engine: patch.engine ?? current.engine,
    approvalMode: patch.approvalMode ?? current.approvalMode,
    tier1Model: patch.tier1Model ?? current.tier1Model,
  };
  try {
    const dir = dirname(SETTINGS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
    cachedSettings = next;
    console.log(`[orchestrator:settings] saved — engine=${next.engine} approvalMode=${next.approvalMode} tier1Model=${next.tier1Model}`);
    return next;
  } catch (err) {
    console.warn(`[orchestrator:settings] failed to write ${SETTINGS_PATH}: ${err instanceof Error ? err.message : err}. Settings live in memory only.`);
    cachedSettings = next;
    return next;
  }
}
