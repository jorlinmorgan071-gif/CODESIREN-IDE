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

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()),
  isProd: parsed.data.NODE_ENV === 'production',
};

export type Config = typeof config;
