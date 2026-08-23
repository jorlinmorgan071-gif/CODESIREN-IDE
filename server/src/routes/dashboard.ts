// server/src/routes/dashboard.ts
// Phase 4 — Control Center: read-only aggregation endpoints.
//
// This router is PURE read-only aggregation. It pulls from existing systems
// (AgentManager, MemoryEngine, traces ring buffer, security-log, rate-limiter,
// circuit-breaker, model-router, tool-registry, ghost-mode, sidecar-manager)
// and shapes the data for the dashboard UI. It does NOT mutate any state and
// does NOT modify any of the protected systems.
//
// Protected (DO NOT MODIFY) — this router only READS from them:
//   IAgent, AgentManager.send(), dispatchStrategy(), executionMode,
//   Memory Engine, Security Sandbox, Ghost Mode, ModelRouter,
//   Authentication, existing tool contracts, existing traces.

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { agentManager } from '../orchestration/agent-manager.js';
import { memoryEngine } from '../memory/engine.js';
import { toolRegistry } from '../agents/_shared/tool-registry.js';
import { listTraces, getTrace } from '../observability/traces.js';
import { getSecurityEvents } from '../monitoring/security-log.js';
import { getRateLimitStats } from '../middleware/rate-limiter.js';
import { isDbAvailable, query } from '../db/client.js';
import { config } from '../config.js';
import { ProjectAccessError, resolveTenantScope } from '../tenancy/scope.js';

export const dashboardRouter = Router();

function requestedProjectId(req: any): string | undefined {
  return typeof req.query.projectId === 'string' && req.query.projectId.length > 0
    ? req.query.projectId
    : undefined;
}

async function dashboardScope(req: any) {
  return resolveTenantScope(req.user!.id, requestedProjectId(req));
}

function sendDashboardScopeError(res: any, error: unknown): boolean {
  if (error instanceof ProjectAccessError) {
    res.status(403).json({ error: 'Project access denied' });
    return true;
  }
  return false;
}

// Server start time — used for uptime calculation. Captured at module load.
const SERVER_STARTED_AT = Date.now();

// ── Helpers ──────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

// ── STEP 1: System Overview ──────────────────────────────────────────────
// GET /api/dashboard/system

dashboardRouter.get('/system', requireAuth, (_req, res) => {
  const uptimeMs = Date.now() - SERVER_STARTED_AT;

  res.json({
    server: {
      name: 'Code Siren Server',
      version: '0.2.0-phase3',
      uptimeMs,
      uptimeHuman: formatDuration(uptimeMs),
    },
    database: {
      available: isDbAvailable(),
      mode: isDbAvailable() ? 'postgresql' : 'degraded-in-memory',
    },
  });
});

// ── STEP 2: Agent View ───────────────────────────────────────────────────
// GET /api/dashboard/agents
// Aggregates per-agent stats from the traces ring buffer + agent roster.
// No agent mutation — read-only.

dashboardRouter.get('/agents', requireAuth, async (req, res) => {
  let scope;
  try {
    scope = await dashboardScope(req);
  } catch (error) {
    if (sendDashboardScopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to resolve dashboard scope' });
    return;
  }
  const agents = agentManager.list();
  const traces = listTraces({ limit: 1000, scope });
  const activeAgentIds = new Set(agentManager.getActiveTasksForScope(scope).map(task => task.agentId));

  // Aggregate trace stats per agent
  const statsByAgent = new Map<string, {
    lastExecAt: number | null;
    lastDurationMs: number | null;
    errorCount: number;
    totalRuns: number;
    successCount: number;
    avgDurationMs: number;
  }>();

  for (const t of traces) {
    const entry = statsByAgent.get(t.agentId) ?? {
      lastExecAt: null,
      lastDurationMs: null,
      errorCount: 0,
      totalRuns: 0,
      successCount: 0,
      avgDurationMs: 0,
    };
    if (entry.lastExecAt === null || t.startedAt > entry.lastExecAt) {
      entry.lastExecAt = t.startedAt;
      entry.lastDurationMs = t.totalDurationMs ?? null;
    }
    entry.totalRuns++;
    if (t.outcome === 'error') entry.errorCount++;
    if (t.outcome === 'success') entry.successCount++;
    statsByAgent.set(t.agentId, entry);
  }

  // Per-agent memory counts (DB only — falls back to null in degraded mode)
  let memoryByAgent: Record<string, number> = {};
  if (isDbAvailable()) {
    try {
      const rows = await query<{ agent_id: string; count: string }>(
        `SELECT m.agent_id, COUNT(*) as count
         FROM agent_memory m JOIN projects p ON p.id = m.project_id
         WHERE m.project_id = $1 AND p.user_id = $2
         GROUP BY m.agent_id`,
        [scope.projectId, scope.userId],
      );
      memoryByAgent = Object.fromEntries(
        rows.map((r) => [r.agent_id ?? '(unassigned)', parseInt(r.count, 10)]),
      );
    } catch (err) {
      // Fall back to empty — don't fail the whole dashboard
    }
  }

  res.json({
    totalAgents: agents.length,
    agents: agents.map((a) => {
      const stats = statsByAgent.get(a.id);
      return {
        id: a.id,
        name: a.name,
        domain: a.domain,
        icon: a.icon,
        color: a.color,
        trustScore: a.trustScore,
        status: activeAgentIds.has(a.id) ? 'RUNNING' : 'IDLE',
        acceptsSkills: a.acceptsSkills,
        skillsCount: a.skills.length,
        lastExecAt: stats?.lastExecAt ?? null,
        lastDurationMs: stats?.lastDurationMs ?? null,
        lastDurationHuman: stats?.lastDurationMs ? formatDuration(stats.lastDurationMs) : '—',
        errorCount: stats?.errorCount ?? 0,
        totalRuns: stats?.totalRuns ?? 0,
        successCount: stats?.successCount ?? 0,
        avgDurationMs: stats?.avgDurationMs ?? 0,
        memoryEntries: memoryByAgent[a.id] ?? 0,
      };
    }),
    memoryEntriesTotal: Object.values(memoryByAgent).reduce((a, b) => a + b, 0),
    tracesSampleSize: traces.length,
  });
});

// ── STEP 1 + 6: Execution View ───────────────────────────────────────────
// GET /api/dashboard/execution
// Aggregates execution mode distribution, outcomes, recent runs.

dashboardRouter.get('/execution', requireAuth, async (req, res) => {
  let scope;
  try {
    scope = await dashboardScope(req);
  } catch (error) {
    if (sendDashboardScopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to resolve dashboard scope' });
    return;
  }
  const traces = listTraces({ limit: 1000, scope });

  const byMode: Record<string, number> = { 'single-shot': 0, react: 0, codeact: 0 };
  const byOutcome: Record<string, number> = { success: 0, error: 0, 'loop-blocked': 0, 'max-turns': 0, aborted: 0 };
  const byDomain: Record<string, number> = {};
  const byAgent: Record<string, number> = {};

  let totalDurationMs = 0;
  let durationCount = 0;
  let maxDurationMs = 0;
  let minDurationMs = Infinity;

  for (const t of traces) {
    byMode[t.executionMode] = (byMode[t.executionMode] ?? 0) + 1;
    byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
    byDomain[t.domain] = (byDomain[t.domain] ?? 0) + 1;
    byAgent[t.agentId] = (byAgent[t.agentId] ?? 0) + 1;

    if (t.totalDurationMs !== undefined) {
      totalDurationMs += t.totalDurationMs;
      durationCount++;
      if (t.totalDurationMs > maxDurationMs) maxDurationMs = t.totalDurationMs;
      if (t.totalDurationMs < minDurationMs) minDurationMs = t.totalDurationMs;
    }
  }

  const recent = traces.slice(0, 20).map((t) => ({
    traceId: t.traceId,
    taskId: t.taskId,
    agentId: t.agentId,
    domain: t.domain,
    executionMode: t.executionMode,
    outcome: t.outcome,
    startedAt: t.startedAt,
    durationMs: t.totalDurationMs,
    durationHuman: t.totalDurationMs ? formatDuration(t.totalDurationMs) : '—',
    turns: t.turns,
    stepsCount: t.steps.length,
    toolCallsCount: t.toolResults.length,
    inputPreview: t.input.slice(0, 120),
  }));

  res.json({
    totalRuns: traces.length,
    sampleNote: traces.length === 1000 ? 'Based on last 1000 runs (ring buffer cap)' : `Based on ${traces.length} runs`,
    byMode,
    byOutcome,
    byDomain,
    byAgent,
    duration: {
      avgMs: durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0,
      avgHuman: durationCount > 0 ? formatDuration(totalDurationMs / durationCount) : '—',
      maxMs: maxDurationMs || 0,
      maxHuman: maxDurationMs ? formatDuration(maxDurationMs) : '—',
      minMs: minDurationMs === Infinity ? 0 : minDurationMs,
      minHuman: minDurationMs === Infinity ? '—' : formatDuration(minDurationMs),
      totalMs: totalDurationMs,
    },
    recent,
  });
});

// ── STEP 4: Memory Inspector ─────────────────────────────────────────────
// GET /api/dashboard/memory
// Aggregates stored entries, categories, cache stats. Read-only — no editing.

dashboardRouter.get('/memory', requireAuth, async (req, res) => {
  let scope;
  try {
    scope = await dashboardScope(req);
  } catch (error) {
    if (sendDashboardScopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to resolve dashboard scope' });
    return;
  }
  let entries: Array<{
    id: string;
    agentId: string | null;
    sourceType: string | null;
    contentPreview: string;
    createdAt: number;
    metadata: Record<string, unknown>;
  }> = [];
  let totalEntries = 0;
  let bySourceType: Record<string, number> = {};
  let byAgent: Record<string, number> = {};
  let byCategory: Record<string, number> = {};

  if (isDbAvailable()) {
    try {
      const rows = await query<{
        id: string;
        agent_id: string | null;
        source_type: string | null;
        content: string;
        created_at: string;
        metadata: string;
      }>(`SELECT m.id, m.agent_id, m.source_type, m.content, m.created_at, m.metadata
          FROM agent_memory m JOIN projects p ON p.id = m.project_id
          WHERE m.project_id = $1 AND p.user_id = $2
          ORDER BY m.created_at DESC
          LIMIT 100`, [scope.projectId, scope.userId]);

      entries = rows.map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        sourceType: r.source_type,
        contentPreview: r.content.slice(0, 200),
        createdAt: new Date(r.created_at).getTime(),
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
      }));

      // Aggregate categories
      const catRows = await query<{ source_type: string | null; count: string }>(
        `SELECT m.source_type, COUNT(*) as count
         FROM agent_memory m JOIN projects p ON p.id = m.project_id
         WHERE m.project_id = $1 AND p.user_id = $2
         GROUP BY m.source_type`,
        [scope.projectId, scope.userId],
      );
      bySourceType = Object.fromEntries(
        catRows.map((r) => [r.source_type ?? '(unset)', parseInt(r.count, 10)]),
      );

      const agentRows = await query<{ agent_id: string | null; count: string }>(
        `SELECT m.agent_id, COUNT(*) as count
         FROM agent_memory m JOIN projects p ON p.id = m.project_id
         WHERE m.project_id = $1 AND p.user_id = $2
         GROUP BY m.agent_id`,
        [scope.projectId, scope.userId],
      );
      byAgent = Object.fromEntries(
        agentRows.map((r) => [r.agent_id ?? '(unassigned)', parseInt(r.count, 10)]),
      );

      const totalRows = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM agent_memory m JOIN projects p ON p.id = m.project_id
         WHERE m.project_id = $1 AND p.user_id = $2`,
        [scope.projectId, scope.userId],
      );
      totalEntries = parseInt(totalRows[0]?.count ?? '0', 10);

      // By category — uses tags from metadata
      const tagRows = await query<{ tag: string; count: string }>(`
        SELECT tag.value as tag, COUNT(*) as count
        FROM agent_memory m
        JOIN projects p ON p.id = m.project_id,
        jsonb_array_elements_text(COALESCE(m.metadata->'tags', '[]'::jsonb)) as tag
        WHERE m.project_id = $1 AND p.user_id = $2
        GROUP BY tag.value
        ORDER BY count DESC
        LIMIT 20
      `, [scope.projectId, scope.userId]);
      byCategory = Object.fromEntries(tagRows.map((r) => [r.tag, parseInt(r.count, 10)]));
    } catch (err) {
      // Fall through to in-memory fallback
    }
  } else {
    // Degraded mode — in-memory count only (MemoryEngine stores privately)
    totalEntries = await memoryEngine.count(scope);
  }

  res.json({
    totalEntries,
    sampleNote: isDbAvailable()
      ? 'Showing last 100 entries (DB mode)'
      : `In-memory mode: ${totalEntries} entries (DB unavailable for full breakdown)`,
    entries,
    bySourceType,
    byAgent,
    byCategory,
    cacheStats: {
      inMemoryEntries: await memoryEngine.count(scope),
      dbAvailable: isDbAvailable(),
      ringBufferCapacity: 1000,
      embeddingModel: config.OLLAMA_DEFAULT_MODEL,
    },
    retrievalFrequency: {
      note: 'MemoryEngine.search() does not currently record retrieval metrics. Enable in a future phase.',
      instrumented: false,
    },
  });
});

// ── STEP 5: Security Panel ───────────────────────────────────────────────
// GET /api/dashboard/security
// Uses existing telemetry (security-log + rate-limiter + circuit-breaker).

dashboardRouter.get('/security', requireAuth, (req, res) => {
  const events = getSecurityEvents({ limit: 1000 }).filter(event => event.userId === req.user!.id);

  // By event type
  const byType: Record<string, number> = {};
  for (const e of events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
  }

  // Last 24h bucketed by hour (for the heat map time axis)
  const now = Date.now();
  const hourBuckets = new Array(24).fill(0).map((_, i) => ({
    hour: new Date(now - (23 - i) * 3600_000).toISOString().slice(0, 13),
    count: 0,
  }));
  for (const e of events) {
    const hoursAgo = Math.floor((now - e.timestamp) / 3600_000);
    if (hoursAgo >= 0 && hoursAgo < 24) {
      hourBuckets[23 - hoursAgo].count++;
    }
  }

  res.json({
    summary: {
      totalEvents: events.length,
      last5Minutes: events.filter(event => event.timestamp >= Date.now() - 5 * 60_000).length,
      byType,
      bySeverity: events.reduce<Record<string, number>>((summary, event) => {
        summary[event.severity] = (summary[event.severity] ?? 0) + 1;
        return summary;
      }, {}),
    },
    rateLimits: { requesterScoped: true },
    circuitBreakers: { requesterScoped: true },
    threatHeatMap: {
      byHour: hourBuckets,
    },
    byType,
    recentEvents: events.slice(0, 50).map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      severity: e.severity,
      endpoint: e.endpoint,
      method: e.method,
      description: e.description,
    })),
  });
});

// ── Models View ──────────────────────────────────────────────────────────
// GET /api/dashboard/models
// Wraps the existing /api/models endpoints as a single aggregation.

dashboardRouter.get('/models', requireAuth, async (_req, res) => {
  // Lazy import to avoid loading ollama engine at module init
  const {
    checkOllamaAvailable,
    getActiveOllamaModel,
    getAllAgentModels,
  } = await import('../orchestration/engines/ollama.js');

  const ollamaCheck = await checkOllamaAvailable();

  res.json({
    engines: {
      ollama: {
        available: ollamaCheck.available,
        defaultModel: getActiveOllamaModel(),
        models: ollamaCheck.models.map((m) => ({ name: m.name, size: m.size, modifiedAt: m.modified_at })),
      },
      openrouter: { available: !!config.OPENROUTER_API_KEY },
      openai: { available: !!config.OPENAI_API_KEY },
      anthropic: { available: !!config.ANTHROPIC_API_KEY },
      stub: { available: true },
    },
    preferredEngine: ollamaCheck.available
      ? 'ollama'
      : config.OPENROUTER_API_KEY
        ? 'openrouter'
        : 'stub',
    agentOverrides: getAllAgentModels(),
  });
});

// ── Tools View ───────────────────────────────────────────────────────────
// GET /api/dashboard/tools
// Lists registered tools from the existing toolRegistry.

dashboardRouter.get('/tools', requireAuth, (_req, res) => {
  const tools = toolRegistry.list();
  res.json({
    totalTools: tools.length,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  });
});

// ── STEP 3: Trace Explorer ───────────────────────────────────────────────
// GET /api/dashboard/traces
// Wraps listTraces with optional search + filter.
// GET /api/dashboard/traces/:taskId
// Wraps getTrace for a single trace detail.

dashboardRouter.get('/traces', requireAuth, async (req, res) => {
  let scope;
  try {
    scope = await dashboardScope(req);
  } catch (error) {
    if (sendDashboardScopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to resolve dashboard scope' });
    return;
  }
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  const executionMode = typeof req.query.executionMode === 'string'
    ? (req.query.executionMode as 'single-shot' | 'react' | 'codeact')
    : undefined;
  const outcome = typeof req.query.outcome === 'string' ? req.query.outcome : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : undefined;
  const limit = typeof req.query.limit === 'string' ? Math.min(parseInt(req.query.limit, 10) || 100, 1000) : 100;

  let traces = listTraces({ agentId, executionMode, limit: 1000, scope });

  if (outcome) {
    traces = traces.filter((t) => t.outcome === outcome);
  }
  if (search) {
    traces = traces.filter((t) =>
      t.input.toLowerCase().includes(search) ||
      t.agentId.toLowerCase().includes(search) ||
      t.domain.toLowerCase().includes(search) ||
      t.taskId.toLowerCase().includes(search) ||
      t.steps.some((s) => s.label.toLowerCase().includes(search)),
    );
  }

  const total = traces.length;
  traces = traces.slice(0, limit);

  res.json({
    total,
    showing: traces.length,
    filters: { agentId, executionMode, outcome, search, limit },
    traces: traces.map((t) => ({
      traceId: t.traceId,
      taskId: t.taskId,
      agentId: t.agentId,
      domain: t.domain,
      executionMode: t.executionMode,
      input: t.input,
      output: t.output,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      totalDurationMs: t.totalDurationMs,
      totalDurationHuman: t.totalDurationMs ? formatDuration(t.totalDurationMs) : '—',
      turns: t.turns,
      outcome: t.outcome,
      errorMessage: t.errorMessage,
      stepsCount: t.steps.length,
      toolResultsCount: t.toolResults.length,
      steps: t.steps,
      toolResults: t.toolResults,
    })),
  });
});

dashboardRouter.get('/traces/:taskId', requireAuth, async (req, res) => {
  let scope;
  try {
    scope = await dashboardScope(req);
  } catch (error) {
    if (sendDashboardScopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to resolve dashboard scope' });
    return;
  }
  const trace = getTrace(req.params.taskId, scope);
  if (!trace) {
    res.status(404).json({ error: `No trace for taskId ${req.params.taskId}` });
    return;
  }
  res.json({
    trace: {
      ...trace,
      totalDurationHuman: trace.totalDurationMs ? formatDuration(trace.totalDurationMs) : '—',
    },
  });
});

dashboardRouter.get('/traces-file/info', requireAuth, async (req, res) => {
  try {
    const scope = await dashboardScope(req);
    res.json({ projectId: scope.projectId, persistentTraceStore: true });
  } catch (error) {
    if (sendDashboardScopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to inspect trace store' });
  }
});

// ── STEP 6: Performance ──────────────────────────────────────────────────
// GET /api/dashboard/performance
// Latency, build time (static), requests (active rate-limit buckets),
// cache hit (in-memory entries), agent runtime. No optimization.

dashboardRouter.get('/performance', requireAuth, async (req, res) => {
  let scope;
  try {
    scope = await dashboardScope(req);
  } catch (error) {
    if (sendDashboardScopeError(res, error)) return;
    res.status(500).json({ error: 'Failed to resolve dashboard scope' });
    return;
  }
  const traces = listTraces({ limit: 1000, scope });
  const rateLimitStats = getRateLimitStats();
  const memUsage = process.memoryUsage();

  // Latency distribution from traces
  const durations = traces
    .filter((t) => t.totalDurationMs !== undefined)
    .map((t) => t.totalDurationMs as number)
    .sort((a, b) => a - b);

  const count = durations.length;
  const sum = durations.reduce((a, b) => a + b, 0);
  const avg = count > 0 ? Math.round(sum / count) : 0;
  const p50 = count > 0 ? durations[Math.floor(count * 0.5)] : 0;
  const p95 = count > 0 ? durations[Math.floor(count * 0.95)] : 0;
  const p99 = count > 0 ? durations[Math.floor(count * 0.99)] : 0;

  // Per-agent runtime
  const perAgent = new Map<string, { runs: number; totalMs: number; maxMs: number; errors: number }>();
  for (const t of traces) {
    const entry = perAgent.get(t.agentId) ?? { runs: 0, totalMs: 0, maxMs: 0, errors: 0 };
    entry.runs++;
    if (t.totalDurationMs) {
      entry.totalMs += t.totalDurationMs;
      if (t.totalDurationMs > entry.maxMs) entry.maxMs = t.totalDurationMs;
    }
    if (t.outcome === 'error') entry.errors++;
    perAgent.set(t.agentId, entry);
  }

  res.json({
    latency: {
      sampleSize: count,
      avgMs: avg,
      avgHuman: avg ? formatDuration(avg) : '—',
      p50Ms: p50,
      p50Human: p50 ? formatDuration(p50) : '—',
      p95Ms: p95,
      p95Human: p95 ? formatDuration(p95) : '—',
      p99Ms: p99,
      p99Human: p99 ? formatDuration(p99) : '—',
      maxMs: count > 0 ? durations[count - 1] : 0,
    },
    buildTime: {
      note: 'Build time is captured at CI build phase, not at runtime. See PHASE4_REPORT.md.',
      capturedAt: null,
    },
    requests: {
      activeIpBuckets: rateLimitStats.active.ipBuckets,
      activeUserBuckets: rateLimitStats.active.userBuckets,
      activeWsBuckets: rateLimitStats.active.wsBuckets,
      config: rateLimitStats.config,
      note: 'Total request counter is not currently instrumented. Active bucket counts shown.',
    },
    cacheHit: {
      inMemoryEntries: await memoryEngine.count(scope),
      dbAvailable: isDbAvailable(),
      note: 'Cache hit ratio is not currently instrumented. In-memory entry count shown as proxy.',
    },
    agentRuntime: Array.from(perAgent.entries())
      .map(([agentId, s]) => ({
        agentId,
        runs: s.runs,
        avgMs: s.runs > 0 ? Math.round(s.totalMs / s.runs) : 0,
        avgHuman: s.runs > 0 ? formatDuration(s.totalMs / s.runs) : '—',
        maxMs: s.maxMs,
        maxHuman: s.maxMs ? formatDuration(s.maxMs) : '—',
        errors: s.errors,
        errorRate: s.runs > 0 ? (s.errors / s.runs) : 0,
      }))
      .sort((a, b) => b.runs - a.runs),
    processMemory: {
      rss: memUsage.rss,
      rssHuman: formatBytes(memUsage.rss),
      heapUsed: memUsage.heapUsed,
      heapUsedHuman: formatBytes(memUsage.heapUsed),
      heapTotal: memUsage.heapTotal,
      heapTotalHuman: formatBytes(memUsage.heapTotal),
    },
  });
});
