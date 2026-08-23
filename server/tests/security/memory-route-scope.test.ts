import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { memoryRouter } from '../../src/routes/memory.js';
import { signToken } from '../../src/auth/jwt.js';
import { memoryEngine } from '../../src/memory/engine.js';
import { ensureOwnedSession, resolveTenantScope } from '../../src/tenancy/scope.js';

const PORT = 3106;
const BASE = `http://localhost:${PORT}/api/memory`;
let server: http.Server;
let token: string;
let ownerScope: Awaited<ReturnType<typeof ensureOwnedSession>>;
let otherSessionId: string;
let memoryId: string;

beforeAll(async () => {
  const userId = `memory-route-owner-${Date.now()}`;
  token = signToken({ id: userId, email: 'memory-route@test.local', name: 'Memory Route', plan: 'free' });
  const tenantScope = await resolveTenantScope(userId);
  ownerScope = await ensureOwnedSession(tenantScope, crypto.randomUUID());
  otherSessionId = crypto.randomUUID();
  const stored = await memoryEngine.memorize(
    'P1 scoped memory route evidence record',
    { sourceType: 'agent', sourceRef: 'security-agent', quality: 'verified' },
    'security-agent',
    ownerScope,
  );
  if (!stored) throw new Error('Focused memory route fixture was not stored');
  memoryId = stored.id;

  const app = express();
  app.use('/api/memory', memoryRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('P1 memory route exact-session policy', () => {
  it('requires a session ID rather than falling back to project-wide memory access', async () => {
    const response = await fetch(`${BASE}?limit=10`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(403);
  });

  it('lists only exact-session entries with quality and provenance evidence', async () => {
    const response = await fetch(`${BASE}?limit=10&sessionId=${ownerScope.sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const entry = body.entries.find((item: any) => item.id === memoryId);
    expect(entry).toMatchObject({
      quality: 'degraded',
      provenance: {
        organizationPolicy: 'single-owner', userId: ownerScope.userId, projectId: ownerScope.projectId,
        sessionId: ownerScope.sessionId, policy: 'exact-session', storage: 'ephemeral',
      },
    });
  });

  it('does not reveal a memory detail through another owned session in the same project', async () => {
    const response = await fetch(`${BASE}/${memoryId}?sessionId=${otherSessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });
});
