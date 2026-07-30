// server/src/db/client.ts
// pg Pool with graceful in-memory fallback.
// Step 0 proof works without Postgres — the server starts in degraded mode and
// logs a warning. Migrations are ready to run when Postgres is available.

import { Pool, type PoolClient } from 'pg';
import { config } from '../config.js';

let pool: Pool | null = null;
let pgAvailable = false;
const inMemoryStore = new Map<string, any>();

export async function initDb(): Promise<void> {
  try {
    pool = new Pool({
      host: config.PG_HOST,
      port: config.PG_PORT,
      database: config.PG_DB,
      user: config.PG_USER,
      password: config.PG_PASSWORD,
      connectionTimeoutMillis: 2000,
    });
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    pgAvailable = true;
    console.log(`[db] Connected to PostgreSQL at ${config.PG_HOST}:${config.PG_PORT}/${config.PG_DB}`);
  } catch (err: any) {
    pgAvailable = false;
    pool = null;
    console.warn(`[db] PostgreSQL unavailable (${err.message}). Starting in degraded in-memory mode.`);
    console.warn('[db] Step 0 proof will work; persistence is not guaranteed across restarts.');
    console.warn('[db] Run `docker run -e POSTGRES_PASSWORD=code_siren -p 5432:5432 postgres:16` and `npm run migrate` to enable.');
  }
}

export function isDbAvailable(): boolean {
  return pgAvailable;
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  if (!pgAvailable || !pool) {
    // Degraded mode — return empty for SELECTs, no-op for writes.
    // Step 0 proof only needs agent_states (read once at startup) and agent_tasks
    // (insert + update). Both are also held in the AgentManager's in-memory map.
    return [];
  }
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pgAvailable || !pool) {
    throw new Error('[db] PostgreSQL unavailable — withClient cannot be used in degraded mode');
  }
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
}

// In-memory store helpers for degraded mode
export function memGet<T>(key: string): T | undefined {
  return inMemoryStore.get(key);
}
export function memSet<T>(key: string, value: T): void {
  inMemoryStore.set(key, value);
}
export function memHas(key: string): boolean {
  return inMemoryStore.has(key);
}
