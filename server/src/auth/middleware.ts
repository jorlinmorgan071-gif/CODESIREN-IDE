// server/src/auth/middleware.ts

import type { Request, Response, NextFunction } from 'express';
import { verifyToken, claimsToUser } from './jwt.js';
import type { AuthUser } from '../types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Extract the JWT token from either an Authorization header OR an httpOnly
 * cookie named `code_siren_token`. This dual-extraction maintains backward
 * compatibility with existing API clients while allowing the frontend to
 * use the more secure httpOnly cookie approach.
 */
function extractToken(req: Request): string | null {
  // 1. Try Authorization header first (for API clients / programmatic access)
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  // 2. Fall back to httpOnly cookie (for browser frontend — XSS-safe)
  if (req.cookies?.code_siren_token) {
    return req.cookies.code_siren_token;
  }
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const claims = verifyToken(token);
  if (!claims) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  req.user = claimsToUser(claims);
  next();
}

export function requireAuthOptional(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    const claims = verifyToken(token);
    if (claims) req.user = claimsToUser(claims);
  }
  next();
}

/**
 * Require the authenticated user to have an admin role.
 * Must be used AFTER requireAuth in the middleware chain:
 *   router.post('/admin/...', requireAuth, requireAdmin, handler)
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  // The 'plan' field on AuthUser is used as the role indicator.
  // 'admin' plan = admin user. All other plans require explicit authorization.
  if (req.user.plan !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * Require the user to have a verified email.
 * Must be used AFTER requireAuth:
 *   router.post('/sensitive', requireAuth, requireVerifiedEmail, handler)
 */
export function requireVerifiedEmail(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  // If emailVerified is undefined (old tokens), allow through for backward compat
  if (req.user.emailVerified === false) {
    res.status(403).json({ error: 'Email verification required', code: 'EMAIL_NOT_VERIFIED' });
    return;
  }
  next();
}
