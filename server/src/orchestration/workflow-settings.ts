// server/src/orchestration/workflow-settings.ts
// Phase B: Workflow Automation — workflow definition + persistence.
//
// Persists to server/.runtime/workflows.json (same pattern as voice-settings.ts,
// avatar-settings.ts, bubble-settings.ts).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);
const SETTINGS_PATH = join(__dirname_esm, '..', '..', '.runtime', 'workflows.json');

export type WorkflowStepType =
  | 'typecheck'
  | 'test'
  | 'lint'
  | 'grep-audit'
  | 'npm-audit'
  | 'ghost-scan'
  | 'custom';

export type WorkflowTrigger = 'manual' | 'scheduled';

// Step types that involve writing to disk (need warning on every run)
export const WRITE_CAPABLE_STEPS = new Set<string>([
  'generate-route',
  'design-migration',
  'generate-component',
  'npm-audit-fix',
]);

export interface WorkflowStep {
  name: string;
  type: WorkflowStepType;
  command?: string;          // for 'custom' type — shell command (goes through classifyCommand gate)
  stopOnFailure: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  trigger: WorkflowTrigger;
  scheduleIntervalMs?: number;  // for 'scheduled' trigger
  createdAt: string;
  lastRunAt?: string;
  lastResult?: 'success' | 'failed' | 'partial';
  enabled: boolean;
}

interface WorkflowRegistry {
  workflows: Workflow[];
}

const VALID_STEP_TYPES = new Set(['typecheck', 'test', 'lint', 'grep-audit', 'npm-audit', 'ghost-scan', 'custom']);
const VALID_TRIGGERS = new Set(['manual', 'scheduled']);

export function getWorkflows(): Workflow[] {
  try {
    if (!existsSync(SETTINGS_PATH)) return [];
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as WorkflowRegistry;
    return Array.isArray(parsed.workflows) ? parsed.workflows : [];
  } catch {
    return [];
  }
}

export function getWorkflow(id: string): Workflow | null {
  return getWorkflows().find(w => w.id === id) ?? null;
}

export function saveWorkflow(workflow: Workflow): Workflow[] {
  const workflows = getWorkflows();
  const idx = workflows.findIndex(w => w.id === workflow.id);
  if (idx >= 0) {
    workflows[idx] = workflow;
  } else {
    workflows.push(workflow);
  }
  persist(workflows);
  return workflows;
}

export function deleteWorkflow(id: string): Workflow[] {
  const workflows = getWorkflows().filter(w => w.id !== id);
  persist(workflows);
  return workflows;
}

export function updateWorkflowRun(id: string, result: 'success' | 'failed' | 'partial'): void {
  const workflows = getWorkflows();
  const wf = workflows.find(w => w.id === id);
  if (wf) {
    wf.lastRunAt = new Date().toISOString();
    wf.lastResult = result;
    persist(workflows);
  }
}

function persist(workflows: Workflow[]): void {
  try {
    const dir = dirname(SETTINGS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ workflows }, null, 2), 'utf8');
  } catch (err: any) {
    console.warn(`[workflow-settings] failed to persist: ${err.message}`);
  }
}

export function validateWorkflow(data: any): { valid: boolean; error?: string; workflow?: Workflow } {
  if (!data || typeof data !== 'object') return { valid: false, error: 'Invalid input' };
  if (!data.name || typeof data.name !== 'string') return { valid: false, error: 'name is required' };
  if (!Array.isArray(data.steps) || data.steps.length === 0) return { valid: false, error: 'steps array is required' };

  for (const step of data.steps) {
    if (!step.name || typeof step.name !== 'string') return { valid: false, error: 'step.name is required' };
    if (!VALID_STEP_TYPES.has(step.type)) return { valid: false, error: `Invalid step type: ${step.type}` };
    if (typeof step.stopOnFailure !== 'boolean') return { valid: false, error: 'step.stopOnFailure must be boolean' };
    if (step.type === 'custom' && (!step.command || typeof step.command !== 'string')) {
      return { valid: false, error: 'custom step requires command field' };
    }
  }

  if (!VALID_TRIGGERS.has(data.trigger)) return { valid: false, error: `Invalid trigger: ${data.trigger}` };
  if (data.trigger === 'scheduled' && (!data.scheduleIntervalMs || data.scheduleIntervalMs < 5000)) {
    return { valid: false, error: 'scheduled trigger requires scheduleIntervalMs >= 5000' };
  }

  const workflow: Workflow = {
    id: data.id || `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: data.name,
    description: data.description || '',
    steps: data.steps,
    trigger: data.trigger,
    scheduleIntervalMs: data.scheduleIntervalMs,
    createdAt: data.createdAt || new Date().toISOString(),
    enabled: data.enabled !== false,
  };

  return { valid: true, workflow };
}

/**
 * Check if a workflow contains any write-capable steps.
 */
export function hasWriteSteps(workflow: Workflow): boolean {
  return workflow.steps.some(step =>
    WRITE_CAPABLE_STEPS.has(step.type) ||
    (step.type === 'custom' && step.command && /npm\s+audit\s+fix|generateRoute|designMigration|generateComponent/i.test(step.command))
  );
}
