// tests/fixtures/ws-terminal-server.ts
//
// Minimal HTTP+WS server used by tests/integration/ws-terminal-gates.test.ts.
//
// The fixture inherits TERMINAL_ENABLED, NODE_ENV, JWT_SECRET, and
// WS_TEST_USER_PLAN from its environment, starts a fresh HTTP server with
// attachWsServer attached, signs a JWT for a synthetic test user, and prints
// `READY:<port>:<token>` to stdout. The test reads that line and connects.
//
// The fixture keeps running until the test kills it (SIGTERM). It uses the
// same code path the production server uses — config.ts → ptyManager →
// ws/server.ts — so it exercises the real gates.
//
// Run with:
//   npx tsx tests/fixtures/ws-terminal-server.ts
// (the parent test spawns this with the desired env vars).

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { attachWsServer } from '../../src/ws/server.js';
import { initDb, closeDb } from '../../src/db/client.js';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import { signToken } from '../../src/auth/jwt.js';

const userPlan = (process.env.WS_TEST_USER_PLAN as 'free' | 'pro' | 'team' | 'enterprise' | 'admin') || 'free';

async function main(): Promise<void> {
  await initDb();
  ghostMode.setLevel('approval-required');
  ghostMode.start();

  const app = express();
  app.use(express.json());
  app.use(cors());

  const server = http.createServer(app);
  attachWsServer(server);

  server.listen(0, () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      console.error('failed to listen');
      process.exit(1);
    }
    const port = addr.port;
    const token = signToken({
      id: 'ws-test-user',
      email: 'ws-test@code-siren.test',
      name: 'WS Test',
      plan: userPlan,
    });
    // The test parses this line — keep the format stable.
    console.log(`READY:${port}:${token}`);
  });

  // Graceful shutdown so the test can SIGTERM cleanly.
  const shutdown = async () => {
    ghostMode.stop();
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
