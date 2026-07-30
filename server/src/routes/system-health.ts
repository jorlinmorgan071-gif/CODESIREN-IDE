// server/src/routes/system-health.ts
// Phase 6 — Self diagnostics endpoint.
// GET /api/system/health — deep health snapshot for operators.
//
// Read-only. Auth-required. Aggregates from existing systems:
//   - services: which subsystems are reachable (db, ollama, sidecars, ws)
//   - agents: count + status breakdown
//   - memory: process.memoryUsage()
//   - models: engine availability + preferred engine
//   - storage: trace file + biometric templates + STL outputs
//   - uptime: server start time + duration
//   - version: package.json version + node version + phase
//
// Does NOT mutate any state. Does NOT modify any protected system.
// Reads from existing singletons (agentManager, ghostMode, sidecarManager,
// memoryEngine, config) — no new dependencies.

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { agentManager } from '../orchestration/agent-manager.js';
import { ghostMode } from '../orchestration/ghost-mode.js';
import { sidecarManager } from '../sidecars/manager.js';
import { memoryEngine } from '../memory/engine.js';
import { isDbAvailable } from '../db/client.js';
import { config } from '../config.js';
import { getCacheStats } from '../middleware/cache.js';
import { getPerformanceMetrics } from '../monitoring/performance-metrics.js';
import { getSecurityStats } from '../monitoring/security-log.js';
import { getRateLimitStats } from '../middleware/rate-limiter.js';
import { getBreakerStats } from '../middleware/circuit-breaker.js';
import { checkOllamaAvailable, getActiveOllamaModel } from '../orchestration/engines/ollama.js';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, '..', '..');
const SERVER_STARTED_AT = Date.now();

export const systemHealthRouter = Router();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

interface ServiceStatus {
  name: string;
  status: 'online' | 'degraded' | 'offline';
  detail: string;
}

systemHealthRouter.get('/health', requireAuth, async (_req, res) => {
  const uptimeMs = Date.now() - SERVER_STARTED_AT;
  const memUsage = process.memoryUsage();
  const agents = agentManager.list();

  // ── Services ─────────────────────────────────────────────────────────
  const services: ServiceStatus[] = [];

  // Database
  services.push({
    name: 'database',
    status: isDbAvailable() ? 'online' : 'degraded',
    detail: isDbAvailable() ? 'postgresql' : 'in-memory (degraded)',
  });

  // Ollama — async check
  let ollamaStatus: ServiceStatus = {
    name: 'ollama',
    status: 'offline',
    detail: 'unreachable',
  };
  try {
    const ollamaCheck = await checkOllamaAvailable();
    ollamaStatus = {
      name: 'ollama',
      status: ollamaCheck.available ? 'online' : 'offline',
      detail: ollamaCheck.available
        ? `${ollamaCheck.models.length} models, default=${getActiveOllamaModel()}`
        : (ollamaCheck.error ?? 'unreachable'),
    };
  } catch (err: any) {
    ollamaStatus = {
      name: 'ollama',
      status: 'offline',
      detail: err.message ?? 'check failed',
    };
  }
  services.push(ollamaStatus);

  // Cloud LLMs
  services.push({
    name: 'openrouter',
    status: config.OPENROUTER_API_KEY ? 'online' : 'offline',
    detail: config.OPENROUTER_API_KEY ? 'API key set' : 'no API key',
  });
  services.push({
    name: 'openai',
    status: config.OPENAI_API_KEY ? 'online' : 'offline',
    detail: config.OPENAI_API_KEY ? 'API key set' : 'no API key',
  });
  services.push({
    name: 'anthropic',
    status: config.ANTHROPIC_API_KEY ? 'online' : 'offline',
    detail: config.ANTHROPIC_API_KEY ? 'API key set' : 'no API key',
  });

  // Sidecars
  const sidecars = sidecarManager.list();
  services.push({
    name: 'sidecars',
    status: sidecars.length > 0 ? 'online' : 'online',  // 'online' = ready (spawned on demand)
    detail: sidecars.length > 0 ? `running: ${sidecars.join(', ')}` : 'none running (spawned on demand)',
  });

  // WebSocket
  services.push({
    name: 'websocket',
    status: 'online',  // if HTTP is up, WS is up (same port)
    detail: `attached at /ws on port ${config.PORT}`,
  });

  // Ghost Mode
  services.push({
    name: 'ghost-mode',
    status: ghostMode.currentState === 'inactive' ? 'offline' : 'online',
    detail: `state=${ghostMode.currentState} level=${ghostMode.currentLevel}`,
  });

  // Cache
  const cacheStats = getCacheStats();
  services.push({
    name: 'cache',
    status: 'online',
    detail: `${cacheStats.activeEntries} entries, hit rate=${(cacheStats.hitRate * 100).toFixed(1)}%`,
  });

  // ── Agents ───────────────────────────────────────────────────────────
  const agentStatusBreakdown = {
    total: agents.length,
    idle: agents.filter((a) => a.status === 'IDLE').length,
    running: agents.filter((a) => a.status === 'RUNNING').length,
    reviewing: agents.filter((a) => a.status === 'REVIEWING').length,
    error: agents.filter((a) => a.status === 'ERROR').length,
    paused: agents.filter((a) => a.status === 'PAUSED').length,
  };

  // ── Memory ───────────────────────────────────────────────────────────
  const memory = {
    rss: memUsage.rss,
    rssHuman: formatBytes(memUsage.rss),
    heapUsed: memUsage.heapUsed,
    heapUsedHuman: formatBytes(memUsage.heapUsed),
    heapTotal: memUsage.heapTotal,
    heapTotalHuman: formatBytes(memUsage.heapTotal),
    external: memUsage.external,
    externalHuman: formatBytes(memUsage.external),
    memoryEntries: await memoryEngine.count(),
  };

  // ── Models ───────────────────────────────────────────────────────────
  const ollamaCheck = await checkOllamaAvailable().catch(() => ({ available: false, models: [], error: 'unreachable' }));
  const models = {
    preferredEngine: ollamaCheck.available
      ? 'ollama'
      : config.OPENROUTER_API_KEY
        ? 'openrouter'
        : 'stub',
    engines: {
      ollama: { available: ollamaCheck.available, defaultModel: getActiveOllamaModel(), modelCount: ollamaCheck.models.length },
      openrouter: { available: !!config.OPENROUTER_API_KEY },
      openai: { available: !!config.OPENAI_API_KEY },
      anthropic: { available: !!config.ANTHROPIC_API_KEY },
      stub: { available: true },
    },
  };

  // ── Storage ──────────────────────────────────────────────────────────
  const storage: Array<{ name: string; path: string; exists: boolean; sizeBytes: number; sizeHuman: string; entries?: number }> = [];

  // Traces file
  const tracesFile = join(SERVER_ROOT, '.traces', 'runs.jsonl');
  if (existsSync(tracesFile)) {
    const stat = statSync(tracesFile);
    storage.push({
      name: 'traces',
      path: '.traces/runs.jsonl',
      exists: true,
      sizeBytes: stat.size,
      sizeHuman: formatBytes(stat.size),
    });
  } else {
    storage.push({ name: 'traces', path: '.traces/runs.jsonl', exists: false, sizeBytes: 0, sizeHuman: '0B' });
  }

  // Biometric templates
  const bioDir = join(SERVER_ROOT, '.biometric-templates');
  if (existsSync(bioDir)) {
    const files = readdirSync(bioDir);
    let totalSize = 0;
    for (const f of files) {
      try { totalSize += statSync(join(bioDir, f)).size; } catch { /* */ }
    }
    storage.push({
      name: 'biometric-templates',
      path: '.biometric-templates/',
      exists: true,
      sizeBytes: totalSize,
      sizeHuman: formatBytes(totalSize),
      entries: files.length,
    });
  } else {
    storage.push({ name: 'biometric-templates', path: '.biometric-templates/', exists: false, sizeBytes: 0, sizeHuman: '0B', entries: 0 });
  }

  // STL outputs
  const stlDir = join(SERVER_ROOT, '.stl-out');
  if (existsSync(stlDir)) {
    let totalSize = 0;
    let count = 0;
    try {
      const files = readdirSync(stlDir, { recursive: true });
      for (const f of files) {
        try { totalSize += statSync(join(stlDir, String(f))).size; count++; } catch { /* */ }
      }
    } catch { /* */ }
    storage.push({
      name: 'stl-outputs',
      path: '.stl-out/',
      exists: true,
      sizeBytes: totalSize,
      sizeHuman: formatBytes(totalSize),
      entries: count,
    });
  } else {
    storage.push({ name: 'stl-outputs', path: '.stl-out/', exists: false, sizeBytes: 0, sizeHuman: '0B', entries: 0 });
  }

  // G-code outputs
  const gcodeDir = join(SERVER_ROOT, '..', 'gcode-out');
  if (existsSync(gcodeDir)) {
    let totalSize = 0;
    let count = 0;
    try {
      const files = readdirSync(gcodeDir);
      for (const f of files) {
        try { totalSize += statSync(join(gcodeDir, f)).size; count++; } catch { /* */ }
      }
    } catch { /* */ }
    storage.push({
      name: 'gcode-outputs',
      path: 'gcode-out/',
      exists: true,
      sizeBytes: totalSize,
      sizeHuman: formatBytes(totalSize),
      entries: count,
    });
  } else {
    storage.push({ name: 'gcode-outputs', path: 'gcode-out/', exists: false, sizeBytes: 0, sizeHuman: '0B', entries: 0 });
  }

  // ── Uptime ───────────────────────────────────────────────────────────
  const uptime = {
    startedAt: SERVER_STARTED_AT,
    startedAtIso: new Date(SERVER_STARTED_AT).toISOString(),
    uptimeMs,
    uptimeHuman: formatDuration(uptimeMs),
  };

  // ── Version ──────────────────────────────────────────────────────────
  let pkgVersion = 'unknown';
  try {
    const pkg = await import(join(SERVER_ROOT, 'package.json'), { with: { type: 'json' } });
    pkgVersion = (pkg.default ?? pkg).version ?? 'unknown';
  } catch {
    // Fall back to reading file directly
    try {
      const pkgText = await import('node:fs/promises').then((fs) => fs.readFile(join(SERVER_ROOT, 'package.json'), 'utf8'));
      pkgVersion = JSON.parse(pkgText).version ?? 'unknown';
    } catch { /* */ }
  }

  const version = {
    server: pkgVersion,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    phase: 'phase-6',
  };

  // ── Telemetry summary (read-only) ────────────────────────────────────
  const perfMetrics = getPerformanceMetrics();
  const securityStats = getSecurityStats();
  const rateLimitStats = getRateLimitStats();
  const breakerStats = getBreakerStats();

  const telemetry = {
    performance: {
      totalRequests: perfMetrics.total,
      avgMs: perfMetrics.avgMs,
      p50Ms: perfMetrics.p50Ms,
      p95Ms: perfMetrics.p95Ms,
      p99Ms: perfMetrics.p99Ms,
      slowRequests: perfMetrics.slowCount,
    },
    security: {
      totalEvents: securityStats.total,
      last5Minutes: securityStats.last5Minutes,
    },
    rateLimits: rateLimitStats,
    circuitBreakers: breakerStats,
    cache: cacheStats,
  };

  // ── Readonly flag ────────────────────────────────────────────────────
  // The endpoint itself is always readonly, but we surface whether the
  // system is in a state where writes would succeed.
  const readonly = !isDbAvailable();

  // ── Response ─────────────────────────────────────────────────────────
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    readonly,
    uptime,
    version,
    services,
    agents: agentStatusBreakdown,
    memory,
    models,
    storage,
    telemetry,
  });
});
