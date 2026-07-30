// app/src/lib/auth.ts
// JWT storage helpers. Single auth token in localStorage.
// Face auth (Step 10) will layer on top of this same token — never a parallel path.

import type { AuthUser } from '@/types';

const TOKEN_KEY = 'code_siren_jwt';
const USER_KEY = 'code_siren_user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function setAuth(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
