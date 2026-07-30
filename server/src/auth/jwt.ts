// server/src/auth/jwt.ts

import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { AuthUser, JwtClaims } from '../types.js';

export function signToken(user: AuthUser): string {
  const claims: JwtClaims = {
    sub: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
  };
  return jwt.sign(claims, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtClaims | null {
  try {
    return jwt.verify(token, config.JWT_SECRET) as JwtClaims;
  } catch {
    return null;
  }
}

export function claimsToUser(claims: JwtClaims): AuthUser {
  return {
    id: claims.sub,
    email: claims.email,
    name: claims.name,
    plan: claims.plan,
  };
}
