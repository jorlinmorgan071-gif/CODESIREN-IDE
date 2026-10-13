// server/src/config.ts
// Env config — zod-validated. All values come from process.env (PDF Section 20 rule).

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  PG_HOST: z.string().default('localhost'),
  PG_PORT: z.coerce.number().int().positive().default(5432),
  PG_DB: z.string().default('code_siren'),
  PG_USER: z.string().default('code_siren'),
  PG_PASSWORD: z.string().default('code_siren'),
  // Ollama (local LLM)
  OLLAMA_HOST: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_BIN: z.string().optional(),
  OLLAMA_DEFAULT_MODEL: z.string().default('llama3.2'),
  // Cloud LLM (fallback)
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  // Orchestrator engines (Agent Relay — directive Section 1.1)
  GEMINI_API_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173,http://localhost:4173'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] Invalid environment:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\n[config] Hint: copy .env.example to .env and fill in values.');
  process.exit(1);
}

// ── Production JWT secret guard ────────────────────────────────────────
// The .env.example ships with a known dev-only JWT_SECRET so the server
// boots out of the box for local development. If NODE_ENV=production and
// the secret is still the dev default (or any other known ≥32-char weak
// default that passes zod's min(32) check), refuse to start. A leaked dev
// secret means anyone who reads the public repo can forge JWTs — this guard
// turns that footgun into a hard crash.
//
// Note: only ≥32-char strings need to be listed here. Shorter weak strings
// like "change-me" are already rejected by zod's .min(32) above.
const KNOWN_DEV_SECRETS = new Set([
  'dev-only-change-me-in-production-32-chars-min',
  'test-secret-32-chars-minimum-padding',
  'dev-only-change-me-in-production-32-chars!',
]);
if (parsed.data.NODE_ENV === 'production' && KNOWN_DEV_SECRETS.has(parsed.data.JWT_SECRET)) {
  console.error('\n[config] FATAL: NODE_ENV=production but JWT_SECRET is a known dev default.');
  console.error('[config]   Anyone with repo access can forge JWTs with this secret.');
  console.error('[config]   Generate a strong secret: openssl rand -hex 32');
  console.error('[config]   Then set JWT_SECRET in your production .env / environment.\n');
  process.exit(1);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()),
  isProd: parsed.data.NODE_ENV === 'production',
};

export type Config = typeof config;
