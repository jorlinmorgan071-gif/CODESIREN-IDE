// app/src/lib/dashboardApi.ts
// Typed fetch wrapper for the Phase 4 dashboard aggregation endpoints.
// All endpoints are read-only.

import { getToken } from './auth';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

async function dashboardGet<T>(path: string): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/dashboard${path}`, { headers });
  if (!res.ok) {
    let body: Record<string, unknown> | null = null;
    try { body = await res.json(); } catch { /* ignore */ }
    const errMsg = (body as Record<string, unknown>)?.error;
    throw new Error(typeof errMsg === 'string' ? errMsg : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Types mirror server/src/routes/dashboard.ts ──────────────────────────

export interface SystemOverview {
  server: {
    name: string;
    version: string;
    nodeVersion: string;
    platform: string;
    pid: number;
    startedAt: number;
    uptimeMs: number;
    uptimeHuman: string;
  };
  database: { available: boolean; mode: string };
  agents: {
    total: number;
    idle: number;
    running: number;
    reviewing: number;
    error: number;
    paused: number;
  };
  ghost: { state: string; level: string };
  sidecars: { registered: string[]; count: number };
  memory: {
    rss: number;
    rssHuman: string;
    heapUsed: number;
    heapUsedHuman: string;
    heapTotal: number;
    heapTotalHuman: string;
    external: number;
    externalHuman: string;
  };
  config: {
    port: number;
    corsOrigins: string[];
    nodeEnv: string;
    ollamaHost: string;
    ollamaDefaultModel: string;
  };
}

export interface AgentStat {
  id: string;
  name: string;
  domain: string;
  icon: string;
  color: string;
  trustScore: number;
  status: string;
  acceptsSkills: boolean;
  skillsCount: number;
  lastExecAt: number | null;
  lastDurationMs: number | null;
  lastDurationHuman: string;
  errorCount: number;
  totalRuns: number;
  successCount: number;
  avgDurationMs: number;
  memoryEntries: number;
}

export interface AgentsOverview {
  totalAgents: number;
  agents: AgentStat[];
  memoryEntriesTotal: number;
  tracesSampleSize: number;
}

export interface ExecutionOverview {
  totalRuns: number;
  sampleNote: string;
  byMode: Record<string, number>;
  byOutcome: Record<string, number>;
  byDomain: Record<string, number>;
  byAgent: Record<string, number>;
  duration: {
    avgMs: number;
    avgHuman: string;
    maxMs: number;
    maxHuman: string;
    minMs: number;
    minHuman: string;
    totalMs: number;
  };
  recent: Array<{
    traceId: string;
    taskId: string;
    agentId: string;
    domain: string;
    executionMode: string;
    outcome: string;
    startedAt: number;
    durationMs: number | null;
    durationHuman: string;
    turns: number;
    stepsCount: number;
    toolCallsCount: number;
    inputPreview: string;
  }>;
}

export interface MemoryOverview {
  totalEntries: number;
  sampleNote: string;
  entries: Array<{
    id: string;
    agentId: string | null;
    sourceType: string | null;
    contentPreview: string;
    createdAt: number;
    metadata: Record<string, unknown>;
  }>;
  bySourceType: Record<string, number>;
  byAgent: Record<string, number>;
  byCategory: Record<string, number>;
  cacheStats: {
    inMemoryEntries: number;
    dbAvailable: boolean;
    ringBufferCapacity: number;
    embeddingModel: string;
  };
  retrievalFrequency: {
    note: string;
    instrumented: boolean;
  };
}

export interface SecurityOverview {
  summary: {
    total: number;
    last5Minutes: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  rateLimits: {
    config: Record<string, number>;
    active: { ipBuckets: number; userBuckets: number; wsBuckets: number };
  };
  circuitBreakers: Record<string, { state: string; failures: number; successes: number }>;
  threatHeatMap: {
    byIp: Array<{ ip: string; count: number; critical: number; high: number; medium: number; low: number }>;
    byHour: Array<{ hour: string; count: number }>;
  };
  byType: Record<string, number>;
  recentEvents: Array<{
    id: string;
    timestamp: number;
    type: string;
    severity: string;
    ip?: string;
    userId?: string;
    endpoint?: string;
    method?: string;
    description: string;
  }>;
}

export interface ModelsOverview {
  engines: {
    ollama: {
      available: boolean;
      host: string;
      defaultModel: string;
      models: Array<{ name: string; size?: number; modifiedAt?: string }>;
      error?: string;
    };
    openrouter: { available: boolean };
    openai: { available: boolean };
    anthropic: { available: boolean };
    stub: { available: boolean };
  };
  preferredEngine: string;
  agentOverrides: Record<string, { model: string; source: string }>;
}

export interface ToolsOverview {
  totalTools: number;
  tools: Array<{ name: string; description: string }>;
}

export interface TraceStep {
  ts: number;
  kind: string;
  label: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface TraceListItem {
  traceId: string;
  taskId: string;
  agentId: string;
  domain: string;
  executionMode: string;
  input: string;
  output?: string;
  startedAt: number;
  completedAt?: number;
  totalDurationMs?: number;
  totalDurationHuman: string;
  turns: number;
  outcome: string;
  errorMessage?: string;
  stepsCount: number;
  toolResultsCount: number;
  steps: TraceStep[];
  toolResults: Array<{ name: string; args: unknown; result: unknown; success: boolean }>;
}

export interface TracesOverview {
  total: number;
  showing: number;
  filters: {
    agentId?: string;
    executionMode?: string;
    outcome?: string;
    search?: string;
    limit: number;
  };
  traces: TraceListItem[];
}

export interface PerformanceOverview {
  latency: {
    sampleSize: number;
    avgMs: number;
    avgHuman: string;
    p50Ms: number;
    p50Human: string;
    p95Ms: number;
    p95Human: string;
    p99Ms: number;
    p99Human: string;
    maxMs: number;
  };
  buildTime: { note: string; capturedAt: string | null };
  requests: {
    activeIpBuckets: number;
    activeUserBuckets: number;
    activeWsBuckets: number;
    config: Record<string, number>;
    note: string;
  };
  cacheHit: {
    inMemoryEntries: number;
    dbAvailable: boolean;
    note: string;
  };
  agentRuntime: Array<{
    agentId: string;
    runs: number;
    avgMs: number;
    avgHuman: string;
    maxMs: number;
    maxHuman: string;
    errors: number;
    errorRate: number;
  }>;
  processMemory: {
    rss: number;
    rssHuman: string;
    heapUsed: number;
    heapUsedHuman: string;
    heapTotal: number;
    heapTotalHuman: string;
  };
}

// ── API methods ──────────────────────────────────────────────────────────

export const dashboardApi = {
  system: () => dashboardGet<SystemOverview>('/system'),
  agents: () => dashboardGet<AgentsOverview>('/agents'),
  execution: () => dashboardGet<ExecutionOverview>('/execution'),
  memory: () => dashboardGet<MemoryOverview>('/memory'),
  security: () => dashboardGet<SecurityOverview>('/security'),
  models: () => dashboardGet<ModelsOverview>('/models'),
  tools: () => dashboardGet<ToolsOverview>('/tools'),
  traces: (filters: {
    agentId?: string;
    executionMode?: string;
    outcome?: string;
    search?: string;
    limit?: number;
  } = {}) => {
    const params = new URLSearchParams();
    if (filters.agentId) params.set('agentId', filters.agentId);
    if (filters.executionMode) params.set('executionMode', filters.executionMode);
    if (filters.outcome) params.set('outcome', filters.outcome);
    if (filters.search) params.set('search', filters.search);
    if (filters.limit) params.set('limit', String(filters.limit));
    const qs = params.toString();
    return dashboardGet<TracesOverview>(`/traces${qs ? `?${qs}` : ''}`);
  },
  trace: (taskId: string) => dashboardGet<{ trace: TraceListItem }>(`/traces/${taskId}`),
  performance: () => dashboardGet<PerformanceOverview>('/performance'),
};
