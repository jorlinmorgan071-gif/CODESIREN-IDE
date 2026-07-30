// server/src/auth/routes.ts
// /api/auth/register, /api/auth/login, /api/auth/me — the one and only auth flow.
// Face auth (Step 10) is added as a SECOND FACTOR on the EXISTING /login endpoint,
// never as a parallel /auth/face-login endpoint. Per directive Section 4.2:
// "Face auth is a second factor on the existing JWT auth flow, never a parallel
// login system."

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { query, isDbAvailable, memSet, memGet } from '../db/client.js';
import { signToken } from './jwt.js';
import { requireAuth } from './middleware.js';
import { verifyFace, enableFaceAuth, disableFaceAuth, getProfile, isFaceAuthEnabled } from './face-factor.js';
import type { AuthUser } from '../types.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(100),
});

// Step 10: login schema now accepts an OPTIONAL faceTemplate field.
// If faceTemplate is provided AND the user has face auth enabled, the face
// is verified as a SECOND FACTOR. If face auth is NOT enabled for the user,
// the faceTemplate is ignored and login proceeds with password alone.
// This is the SAME /api/auth/login endpoint from Step 0 — NOT a new endpoint.
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  faceTemplate: z.string().optional(),  // Step 10: optional second factor
});

async function findUserByEmail(email: string): Promise<(AuthUser & { passwordHash: string }) | null> {
  if (isDbAvailable()) {
    const rows = await query<any>(
      'SELECT id, email, name, password_hash AS "passwordHash", avatar_url AS "avatarUrl", plan FROM users WHERE email = $1',
      [email]
    );
    return rows[0] ?? null;
  }
  // Degraded in-memory mode
  return memGet<(AuthUser & { passwordHash: string })>(`user:${email}`) ?? null;
}

async function createUser(input: { email: string; name: string; passwordHash: string }): Promise<AuthUser> {
  const user: AuthUser = {
    id: uuid(),
    email: input.email,
    name: input.name,
    plan: 'free',
  };
  if (isDbAvailable()) {
    await query(
      `INSERT INTO users (id, email, name, password_hash, plan) VALUES ($1, $2, $3, $4, 'free')`,
      [user.id, user.email, user.name, input.passwordHash]
    );
  } else {
    memSet(`user:${user.email}`, { ...user, passwordHash: input.passwordHash });
    memSet(`userById:${user.id}`, user);
  }
  return user;
}

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const { email, password, name } = parsed.data;
  const existing = await findUserByEmail(email);
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await createUser({ email, name, passwordHash });
  const token = signToken(user);
  res.status(201).json({ token, user });
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const { email, password, faceTemplate } = parsed.data;
  const user = await findUserByEmail(email);
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // ── Step 10: Face auth as SECOND FACTOR on the SAME /login endpoint ──
  // This is NOT a separate /auth/face-login endpoint. It's one more check
  // inside the existing login flow. The JWT is issued by the SAME signToken()
  // call from Step 0 — face verification just gates whether that call happens.
  //
  // Per Step 10 condition 2:
  //   (a) If face auth is NOT enabled for the user → login proceeds (password-only OK)
  //   (b) If face auth IS enabled AND faceTemplate is provided → verify it
  //   (c) If face auth IS enabled AND faceTemplate is WRONG → REJECT even with correct password
  //   (d) If face auth IS enabled AND faceTemplate is NOT provided → REJECT (second factor required)
  if (isFaceAuthEnabled(user.id)) {
    if (!faceTemplate) {
      // Face auth is enabled but no face template provided — second factor required
      res.status(401).json({ error: 'Face authentication required (second factor enabled)', code: 'FACE_REQUIRED' });
      return;
    }
    const faceResult = verifyFace(user.id, faceTemplate);
    if (!faceResult.verified) {
      // Face doesn't match — REJECT even though password was correct
      // BIOMETRIC SAFETY: only the hash is in the response, never the template
      res.status(401).json({
        error: 'Face authentication failed',
        code: 'FACE_MISMATCH',
        templateHash: faceResult.templateHash,  // hash only — never the template
      });
      return;
    }
    // Face verified — proceed to JWT issuance
    console.log(`[auth] Login: password + face verified for ${email} (hash: ${faceResult.templateHash})`);
  } else {
    // Face auth not enabled — password-only login proceeds (face is optional/additive)
    console.log(`[auth] Login: password-only for ${email} (face auth not enabled)`);
  }

  const { passwordHash, ...safe } = user;
  const token = signToken(safe);
  res.json({ token, user: safe });
});

// ── Step 10: Face auth management endpoints ──
// These are NOT login endpoints — they manage the biometric profile.
// The ONLY login endpoint is /api/auth/login above.

authRouter.post('/face/enroll', requireAuth, (req, res) => {
  const schema = z.object({ template: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  // BIOMETRIC SAFETY: the template is stored as a LOCAL FILE via enableFaceAuth().
  // The response returns only the hash and the file PATH — never the template data.
  const profile = enableFaceAuth(req.user!.id, parsed.data.template);
  res.json({
    enabled: true,
    templateHash: profile.templateHash,       // hash only — safe to log
    localTemplatePath: profile.localTemplatePath,  // path only — never the data
  });
});

authRouter.post('/face/disable', requireAuth, (req, res) => {
  const ok = disableFaceAuth(req.user!.id);
  res.json({ disabled: ok });
});

authRouter.get('/face/status', requireAuth, (req, res) => {
  const profile = getProfile(req.user!.id);
  res.json({
    enabled: profile?.enabled ?? false,
    templateHash: profile?.templateHash,  // hash only — never the template
    localTemplatePath: profile?.localTemplatePath,  // path only
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
