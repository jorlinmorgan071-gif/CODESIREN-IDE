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

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  const claims = verifyToken(token);
  if (!claims) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  req.user = claimsToUser(claims);
  next();
}

export function requireAuthOptional(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    const claims = verifyToken(token);
    if (claims) req.user = claimsToUser(claims);
  }
  next();
}
