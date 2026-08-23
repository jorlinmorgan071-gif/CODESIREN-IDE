// server/src/index.ts
// Code Siren server bootstrap — single Express + single WS server on one port.
// PDF Section 12 + 13. Directive Section 7: there is exactly ONE of each.

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { avatarRouter } from './routes/avatar.js';
import { bubbleRouter } from './routes/bubble.js';
import { workflowRouter } from './routes/workflow.js';
import { memoryRouter } from './routes/memory.js';
import { voiceLiveRouter } from './routes/voice-live.js';
import { orchestratorRouter } from './routes/orchestrator.js';
import { workspaceRouter } from './routes/workspace.js';
import { changesRouter } from './routes/changes.js';
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
import { loadAgents } from './agents/loader.js';
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

  // 2. Register agents via auto-loader.
  //    Scans server/src/agents/ for subdirectories, dynamically imports each
  //    one's index.ts, finds the IAgent implementation, and registers it.
  //    To add a new agent: create server/src/agents/my-agent/index.ts that
  //    exports a class extending IAgent. No need to touch this file.
  const loadedAgents = await loadAgents();
  for (const { agent } of loadedAgents) {
    agentManager.register(agent);
  }

  // Phase D — Load built-in skill library (TOML files in src/skills/library/)
  const { loadLibrarySkills } = await import('./skills/library/index.js');
  loadLibrarySkills();

  // 3. Start Ghost Mode in approval-required mode (PDF Section 16 default)
  ghostMode.setLevel('approval-required');

  // 3b. Initialize TTS provider from saved voice settings (Phase E Build 2).
  //
  // Reads server/.runtime/voice-settings.json (or default 'zai' if missing),
  // validates the provider id, and instantiates the correct TTSProvider via
  // applyVoiceProvider(). Fixes the orchestrator-engine boot quirk (where the
  // saved engine setting is NOT applied at boot — only on later POST) by
  // applying the saved voice setting AT BOOT here.
  //
  // On any failure (missing file, invalid provider, instantiation error),
  // falls back to the module-load default (StubTTSProvider) with a visible
  // warning — no silent fallback, no crash.
  try {
    const { getVoiceSettings, applyVoiceProvider } = await import('./orchestrator/voice-settings.js');
    const settings = getVoiceSettings();
    await applyVoiceProvider(settings);
  } catch (err: any) {
    console.warn(`[server] voice settings init failed (${err.message}), using stub TTS`);
  }
  ghostMode.start();

  // 3c. Phase A Section 1: register real Ghost Mode scanners.
  //
  // Two scanners wired in:
  //   - performance-anti-patterns (30s cadence, runs from scanCycle heartbeat)
  //   - security-dependencies    (5min cadence, own interval)
  //
  // MUST come after ghostMode.start() (so the FSM is in 'scanning' state
  // when scanners register) AND after loadAgents() (so agentManager.get()
  // can find the Performance + Security agents).
  try {
    const { registerGhostScanners } = await import('./orchestration/ghost-scanners.js');
    registerGhostScanners();
  } catch (err: any) {
    console.warn(`[server] ghost scanner registration failed: ${err.message}`);
  }

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
  app.use('/api/avatar', avatarRouter);
  app.use('/api/bubble', bubbleRouter);
  app.use('/api/workflow', workflowRouter);
  app.use('/api/memory', memoryRouter);
  app.use('/api/voice', voiceLiveRouter);
  app.use('/api/orchestrator', orchestratorRouter);
  app.use('/api/workspace', workspaceRouter);
  app.use('/api/changes', changesRouter);

  // Phase B: Serve custom VRM avatar files directly from the server.
  // Vite dev server doesn't reliably serve newly-created files in nested
  // subdirectories of public/ at runtime (it caches the directory tree at
  // startup). By serving them from Express, the custom avatars are fetchable
  // immediately after upload, without a vite restart.
  // Path: app/public/models/avatars/custom/<id>/model.vrm
  // URL: /models/avatars/custom/<id>/model.vrm (served by the API server)
  //
  // For dev mode: the client fetches VRM files from the vite origin (localhost:3000).
  // Vite serves built-in avatars from app/public/ correctly, but custom avatars
  // in newly-created subdirectories may not be picked up. To work around this,
  // the client constructs the VRM URL using VITE_API_URL for custom avatars so
  // the fetch goes directly to the API server which serves them reliably.
  // For prod mode: the server serves everything from a single origin.
  // Path: server/src/index.ts → ../../app/public/models/avatars/custom
  // (server/src → server → project-root → app)
  // NOTE: import.meta.url resolves to the source file path. In dev (tsx), this
  // is server/src/index.ts. In prod (compiled), it would be server/dist/index.js
  // — but we run from server/ in both cases, so process.cwd() is reliable.
  // We use process.cwd() as the base for robustness.
  const customAvatarsDir = join(process.cwd(), '..', 'app', 'public', 'models', 'avatars', 'custom');
  app.use('/models/avatars/custom', (req, res) => {
    // req.path = /<id>/model.vrm or /<id>/thumbnail.png
    const segments = req.path.split('/').filter(Boolean);
    if (segments.length !== 2) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const [avatarId, fileName] = segments;
    // Prevent path traversal — avatarId must be 'custom-*' and fileName must be safe
    if (!avatarId.startsWith('custom-') || !/^[\w.-]+$/.test(fileName)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    const filePath = join(customAvatarsDir, avatarId, fileName);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'Avatar file not found' });
      return;
    }
    const buf = readFileSync(filePath);
    const ext = fileName.split('.').pop()?.toLowerCase();
    const contentType = ext === 'vrm' ? 'application/octet-stream'
                      : ext === 'png' ? 'image/png'
                      : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buf.length.toString());
    res.send(buf);
  });

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
