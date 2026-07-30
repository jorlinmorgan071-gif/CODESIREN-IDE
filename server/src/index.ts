// server/src/index.ts
// Code Siren server bootstrap — single Express + single WS server on one port.
// PDF Section 12 + 13. Directive Section 7: there is exactly ONE of each.

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb, closeDb } from './db/client.js';
import { authRouter } from './auth/routes.js';
import { agentsRouter } from './routes/agents.js';
import { healthRouter } from './routes/health.js';
import { tracesRouter } from './routes/traces.js';
import { skillsRouter } from './routes/skills.js';
import { fabricationRouter } from './routes/fabrication.js';
import { sandboxRouter } from './routes/sandbox.js';
import { operativeRouter } from './routes/operative.js';
import { voiceRouter } from './routes/voice.js';
import { sentinelRouter } from './routes/sentinel.js';
import { presenceRouter } from './routes/presence.js';
import { modelsRouter } from './routes/models.js';
import { projectFilesRouter } from './routes/project-files.js';
import { dashboardRouter } from './routes/dashboard.js';
import { systemHealthRouter } from './routes/system-health.js';
import { ghostModeRouter } from './routes/ghost-mode.js';
import { memoryRouter } from './routes/memory.js';
import { voiceLiveRouter } from './routes/voice-live.js';
import { orchestratorRouter } from './routes/orchestrator.js';
import { rateLimitApi } from './middleware/rate-limiter.js';
import { requestTimeout, errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { cacheMiddleware, getCacheStats } from './middleware/cache.js';
import { performanceMiddleware, getPerformanceMetrics, getSlowRequests, getRecentRequests } from './monitoring/performance-metrics.js';
import { getSecurityEvents, getSecurityStats } from './monitoring/security-log.js';
import { getRateLimitStats } from './middleware/rate-limiter.js';
import { getBreakerStats } from './middleware/circuit-breaker.js';
import { requireAuth } from './auth/middleware.js';
import { attachWsServer } from './ws/server.js';
import { agentManager } from './orchestration/agent-manager.js';
import { ghostMode } from './orchestration/ghost-mode.js';
import { sidecarManager } from './sidecars/manager.js';
import { stopOllamaServe } from './orchestration/engines/ollama.js';
import { ArchitectAgent } from './agents/architect/index.js';
import { QaTesterAgent } from './agents/qa-tester/index.js';
import { ExtensionAgent } from './agents/extension/index.js';
import { FrontendAgent } from './agents/frontend/index.js';
import { FabricationAgent } from './agents/fabrication/index.js';
import { OperativeAgent } from './agents/operative/index.js';
import { SentinelAgent } from './agents/sentinel/index.js';
// Engineering-Pillar agents (remaining 13 — converted from static demoData)
import { BackendAgent } from './agents/backend/index.js';
import { DatabaseAgent } from './agents/database/index.js';
import { SecurityAgent } from './agents/security/index.js';
import { DevOpsAgent } from './agents/devops/index.js';
import { DocumentationAgent } from './agents/documentation/index.js';
import { PerformanceAgent } from './agents/performance/index.js';
import { TerminalAgent } from './agents/terminal/index.js';
import { MemoryAgent } from './agents/memory/index.js';
import { UIDesignerAgent } from './agents/ui-designer/index.js';
import { ResearchAgent } from './agents/research/index.js';
import { DeploymentAgent } from './agents/deployment/index.js';
import { PromptEngineerAgent } from './agents/prompt-engineer/index.js';
import { CodeReviewAgent } from './agents/code-review/index.js';
import { getPrinterClient } from './agents/fabrication/printer-client.js';
import { getBrowserClient } from './agents/operative/browser-client.js';

async function main() {
  console.log('─'.repeat(60));
  console.log('  Zero Two: Code Siren — server (Step 7: Operative Agent + smart home)');
  console.log('  One Express server. One WS server. One JWT auth. One router.');
  console.log('  Strategies: single-shot | react | codeact (any agent, any mode).');
  console.log('  Skills Vault: install / list / invoke / discover — via Extension Agent.');
  console.log('  Fabrication: build123d sidecar + PrinterClient (impl=' + getPrinterClient().implementation + ').');
  console.log('  Operative: BrowserClient (impl=' + getBrowserClient().implementation + ') + DeviceClient (impl=' + (await import('./agents/operative/device-client.js')).getDeviceClient().implementation + ') + Security Sandbox.');
  console.log('─'.repeat(60));

  // 1. Database (graceful fallback)
  await initDb();

  // 2. Register agents — Architect, QA Tester, Extension, Frontend, Fabrication.
  //    Fabrication is the FIRST Personal-Pillar agent. Its sidecar (build123d)
  //    is spawned on first use, not at startup — keeps cold-start fast.
  agentManager.register(new ArchitectAgent());
  agentManager.register(new QaTesterAgent());
  agentManager.register(new ExtensionAgent());
  agentManager.register(new FrontendAgent());
  agentManager.register(new FabricationAgent());
  agentManager.register(new OperativeAgent());
  agentManager.register(new SentinelAgent());
  // Engineering-Pillar agents (remaining 13)
  agentManager.register(new BackendAgent());
  agentManager.register(new DatabaseAgent());
  agentManager.register(new SecurityAgent());
  agentManager.register(new DevOpsAgent());
  agentManager.register(new DocumentationAgent());
  agentManager.register(new PerformanceAgent());
  agentManager.register(new TerminalAgent());
  agentManager.register(new MemoryAgent());
  agentManager.register(new UIDesignerAgent());
  agentManager.register(new ResearchAgent());
  agentManager.register(new DeploymentAgent());
  agentManager.register(new PromptEngineerAgent());
  agentManager.register(new CodeReviewAgent());

  // Phase D — Load built-in skill library (TOML files in src/skills/library/)
  const { loadLibrarySkills } = await import('./skills/library/index.js');
  loadLibrarySkills();

  // 3. Start Ghost Mode in approval-required mode (PDF Section 16 default)
  ghostMode.setLevel('approval-required');

  // 3b. Initialize TTS provider — ZaiTTSProvider for this phase.
  // KokoroTTSProvider will replace it in a later phase (same interface).
  try {
    const { ZaiTTSProvider, setTTSProvider } = await import('./systems/voice/tts-provider.js');
    setTTSProvider(new ZaiTTSProvider());
    console.log('[server] TTS provider: zai (Kokoro will replace in a later phase)');
  } catch (err: any) {
    console.warn(`[server] ZaiTTSProvider init failed (${err.message}), using stub TTS`);
  }
  ghostMode.start();

  // 4. Express app
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
  }));

  // Phase 3: Rate limiting + request timeout on all API routes
  // Phase 5: Response timing + slow-request logging (no mutation, just observe)
  app.use('/api', rateLimitApi, requestTimeout, performanceMiddleware);
  // Phase 5: GET response cache (short TTL, per-user, never caches auth)
  // Placed AFTER performanceMiddleware so cache hits are still timed, but BEFORE
  // route handlers so cache hits skip the handler entirely.
  app.use('/api', cacheMiddleware);

  app.use('/api/auth', authRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/traces', tracesRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/fabrication', fabricationRouter);
  app.use('/api/sandbox', sandboxRouter);
  app.use('/api/operative', operativeRouter);
  app.use('/api/voice', voiceRouter);
  app.use('/api/sentinel', sentinelRouter);
  app.use('/api/presence', presenceRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/project-files', projectFilesRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/system', systemHealthRouter);
  app.use('/api/ghost-mode', ghostModeRouter);
  app.use('/api/memory', memoryRouter);
  app.use('/api/voice', voiceLiveRouter);
  app.use('/api/orchestrator', orchestratorRouter);

  // Phase 3: Security dashboard (read-only)
  app.get('/api/security/events', requireAuth, (_req, res) => {
    const limit = parseInt(_req.query.limit as string ?? '100', 10);
    res.json({ events: getSecurityEvents({ limit }) });
  });
  app.get('/api/security/stats', requireAuth, (_req, res) => {
    res.json({
      security: getSecurityStats(),
      rateLimits: getRateLimitStats(),
      circuitBreakers: getBreakerStats(),
    });
  });

  // Phase 5: Runtime performance metrics (read-only, auth-required)
  // These are NEW endpoints that do not modify any existing behavior.
  app.get('/api/performance/metrics', requireAuth, (_req, res) => {
    res.json(getPerformanceMetrics());
  });
  app.get('/api/performance/slow-requests', requireAuth, (req, res) => {
    const limit = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '50', 10);
    res.json({ requests: getSlowRequests(limit) });
  });
  app.get('/api/performance/recent', requireAuth, (req, res) => {
    const limit = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '100', 10);
    res.json({ requests: getRecentRequests(limit) });
  });
  app.get('/api/performance/cache', requireAuth, (_req, res) => {
    res.json(getCacheStats());
  });

  // Phase 3: Error handlers (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  app.get('/', (_req, res) => {
    res.json({
      name: 'Code Siren Server',
      step: 4,
      endpoints: [
        '/api/auth/register', '/api/auth/login', '/api/auth/me',
        '/api/agents', '/api/agents/:agentId/send',
        '/api/traces', '/api/traces/:taskId', '/api/traces/file/preview',
        '/api/skills', '/api/skills/install', '/api/skills/:name/invoke', '/api/skills/:name', '/api/skills/discover',
        '/api/fabrication/generate', '/api/fabrication/health', '/api/fabrication/crash-test',
        '/api/health',
        '/api/dashboard/system', '/api/dashboard/agents', '/api/dashboard/execution',
        '/api/dashboard/memory', '/api/dashboard/security', '/api/dashboard/models',
        '/api/dashboard/tools', '/api/dashboard/traces', '/api/dashboard/traces/:taskId',
        '/api/dashboard/performance',
        '/api/performance/metrics', '/api/performance/slow-requests',
        '/api/performance/recent', '/api/performance/cache',
        '/api/system/health',
      ],
      ws: '/ws?token=JWT&projectId=UUID',
      executionModes: ['single-shot', 'react', 'codeact'],
      agents: agentManager.list().map((a) => ({ id: a.id, domain: a.domain, acceptsSkills: a.acceptsSkills })),
      sidecars: sidecarManager.list(),
    });
  });

  // 5. HTTP server + WS server on the SAME port (PDF Section 12 + 13)
  const server = http.createServer(app);
  attachWsServer(server);

  server.listen(config.PORT, () => {
    console.log(`[server] HTTP  http://localhost:${config.PORT}`);
    console.log(`[server] WS    ws://localhost:${config.PORT}/ws?token=JWT&projectId=UUID`);
    console.log(`[server] Agents: ${agentManager.list().map((a) => `${a.id}${a.acceptsSkills ? '*' : ''}`).join(', ')}  (* = accepts skills)`);
    console.log(`[server] Ghost: state=${ghostMode.currentState} level=${ghostMode.currentLevel}`);
    console.log(`[server] Sidecars: ${sidecarManager.list().length > 0 ? sidecarManager.list().join(', ') : '(none — spawned on first use)'}`);
    console.log('─'.repeat(60));
  });

  // 6. Graceful shutdown — kill sidecars FIRST so they don't outlive Node
  const shutdown = async () => {
    console.log('\n[server] shutting down...');
    sidecarManager.killAll();  // kill sidecars synchronously before Node exits
    stopOllamaServe();         // stop ollama serve if we started it
    ghostMode.stop();
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
