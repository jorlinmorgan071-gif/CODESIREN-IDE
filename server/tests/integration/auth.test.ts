// tests/integration/auth.test.ts
// P0: Authentication — register, login, me, JWT verification, face auth.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { authRouter } from '../../src/auth/routes.js';
import { initDb, closeDb } from '../../src/db/client.js';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';

let server: http.Server;
const BASE = 'http://localhost:3099';

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(cors());
    app.use('/api/auth', authRouter);
    server = app.listen(3099, () => resolve());
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

describe('Authentication Integration', () => {
  let token: string;
  let userId: string;
  const email = `test-${Date.now()}@code-siren.test`;
  const password = 'test-password-123';

  beforeAll(async () => {
    await initDb();
    ghostMode.setLevel('approval-required');
    ghostMode.start();
    await startTestServer();
  });

  afterAll(async () => {
    ghostMode.stop();
    await stopTestServer();
    await closeDb();
  });

  it('POST /api/auth/register → 201 + JWT', async () => {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Test User' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.token).toBeDefined();
    expect(body.user.email).toBe(email);
    token = body.token;
    userId = body.user.id;
  });

  it('POST /api/auth/register → 409 for duplicate email', async () => {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Test User' }),
    });
    expect(res.status).toBe(409);
  });

  it('POST /api/auth/login → 200 + JWT', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.token).toBeDefined();
  });

  it('POST /api/auth/login → 401 for wrong password', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong' }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me → 200 with JWT', async () => {
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.user.email).toBe(email);
  });

  it('GET /api/auth/me → 401 without JWT', async () => {
    const res = await fetch(`${BASE}/api/auth/me`);
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me → 401 with invalid JWT', async () => {
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: 'Bearer invalid-token' },
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/face/enroll → 200 (enroll face)', async () => {
    const res = await fetch(`${BASE}/api/auth/face/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template: 'test-face-template-data' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enabled).toBe(true);
    expect(body.templateHash).toBeDefined();
    expect(body.localTemplatePath).toBeDefined();
    // Biometric isolation: raw template NOT in response
    expect(JSON.stringify(body)).not.toContain('test-face-template-data');
  });

  it('POST /api/auth/login → 401 FACE_REQUIRED (no face provided when enabled)', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.code).toBe('FACE_REQUIRED');
  });

  it('POST /api/auth/login → 401 FACE_MISMATCH (wrong face)', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, faceTemplate: 'wrong-face' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.code).toBe('FACE_MISMATCH');
  });

  it('POST /api/auth/login → 200 (correct face)', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, faceTemplate: 'test-face-template-data' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.token).toBeDefined();
  });

  it('POST /api/auth/face/disable → 200', async () => {
    const res = await fetch(`${BASE}/api/auth/face/disable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.disabled).toBe(true);
  });

  it('POST /api/auth/login → 200 (password-only after disable)', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
  });
});
