// Shared memory engine. Every write is owned by an authenticated user, project,
// and durable session. Project-only historic rows are labelled legacy and are
// never selected by the normal exact-session retrieval policy.

import { modelRouter } from '../orchestration/model-router.js';
import { isDbAvailable, query } from '../db/client.js';
import type { MemoryChunk, MemoryMeta, MemoryProvenance, MemoryQuality } from '../types.js';
import { makeEvent, broadcast } from '../ws/events.js';
import { scopesMatch, type SessionScope, type TenantScope } from '../tenancy/scope.js';

export type MemoryReadScope = SessionScope & { includeLegacyProject?: boolean };

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: MemoryMeta;
  agentId?: string;
  scope: SessionScope;
  quality: MemoryQuality;
  storage: 'durable' | 'ephemeral';
  createdAt: number;
}

export interface MemoryWriteResult {
  id: string;
  quality: MemoryQuality;
  provenance: MemoryProvenance;
}

interface MemoryListEntry {
  id: string;
  content: string;
  agentId: string | null;
  sourceType: string | null;
  createdAt: number;
  quality: MemoryQuality;
  provenance: MemoryProvenance;
}

const inMemoryStore: MemoryEntry[] = [];

function exactSessionScopeMatches(entry: SessionScope, scope: MemoryReadScope): boolean {
  return scopesMatch(entry, scope) && entry.sessionId === scope.sessionId;
}

function readScope(scope: SessionScope | undefined): asserts scope is SessionScope {
  if (!scope?.userId || !scope.projectId || !scope.sessionId) {
    throw new Error('Memory access requires authenticated user, project, and session scope');
  }
}

function asQuality(value: unknown, fallback: MemoryQuality = 'derived'): MemoryQuality {
  return value === 'verified' || value === 'derived' || value === 'degraded' ? value : fallback;
}

function provenance(
  scope: SessionScope,
  metadata: MemoryMeta,
  quality: MemoryQuality,
  storage: 'durable' | 'ephemeral',
  policy: 'exact-session' | 'legacy-project' = 'exact-session',
  retrievedAt?: number,
): MemoryProvenance {
  return {
    organizationPolicy: 'single-owner',
    userId: scope.userId,
    projectId: scope.projectId,
    sessionId: policy === 'exact-session' ? scope.sessionId : null,
    policy,
    storage,
    sourceType: metadata.sourceType,
    sourceRef: metadata.sourceRef ?? null,
    ...(retrievedAt ? { retrievedAt } : {}),
  };
}

function toChunk(
  entry: Pick<MemoryEntry, 'id' | 'content' | 'metadata' | 'quality' | 'storage' | 'scope'>,
  score: number,
  policy: 'exact-session' | 'legacy-project' = 'exact-session',
): MemoryChunk {
  return {
    id: entry.id,
    content: entry.content,
    metadata: entry.metadata as unknown as Record<string, unknown>,
    score,
    quality: entry.quality,
    provenance: provenance(entry.scope, entry.metadata, entry.quality, entry.storage, policy, Date.now()),
  };
}

export class MemoryEngine {
  async embed(text: string): Promise<number[]> {
    return modelRouter.embed(text);
  }

  async memorize(content: string, metadata: MemoryMeta, agentId: string | undefined, scope?: SessionScope): Promise<MemoryWriteResult | null> {
    if (!content || content.length < 5) return null;
    readScope(scope);
    const embedding = await this.embed(content);
    const id = crypto.randomUUID();
    const requestedQuality = metadata.quality ?? 'derived';
    let quality: MemoryQuality = requestedQuality;
    let storage: 'durable' | 'ephemeral' = 'durable';

    if (isDbAvailable()) {
      try {
        const inserted = await query<{ id: string }>(
          `INSERT INTO agent_memory (id, project_id, session_id, agent_id, source_type, source_ref, content, embedding, metadata, quality, provenance)
           SELECT $1, p.id, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11
           FROM projects p
           JOIN sessions s ON s.id = $3 AND s.project_id = p.id
           WHERE p.id = $2 AND p.user_id = $12
           RETURNING id`,
          [
            id, scope.projectId, scope.sessionId, agentId ?? null,
            metadata.sourceType, metadata.sourceRef ?? agentId ?? null, content,
            `[${embedding.join(',')}]`, JSON.stringify({ ...metadata, tags: metadata.tags ?? [] }), quality,
            JSON.stringify(provenance(scope, metadata, quality, 'durable')),
            scope.userId,
          ],
        );
        if (inserted.length === 0) throw new Error('Scoped session ownership could not be proved for memory write');
      } catch (error) {
        // Persisting in process is an explicit degraded outcome, never a durable success.
        storage = 'ephemeral';
        quality = 'degraded';
        console.warn(`[memory] durable write unavailable; retaining only ephemeral scoped memory (${error instanceof Error ? error.message : String(error)})`);
        inMemoryStore.push({ id, content, embedding, metadata, agentId, scope, quality, storage, createdAt: Date.now() });
      }
    } else {
      storage = 'ephemeral';
      quality = 'degraded';
      inMemoryStore.push({ id, content, embedding, metadata, agentId, scope, quality, storage, createdAt: Date.now() });
    }

    const result = { id, quality, provenance: provenance(scope, metadata, quality, storage) };
    broadcast(makeEvent('memory:created' as any, {
      id, agentId: agentId ?? null, sourceType: metadata.sourceType, quality, storage, sessionId: scope.sessionId, createdAt: Date.now(),
    }, scope));
    return result;
  }

  async search(queryText: string, limit = 5, scope?: MemoryReadScope): Promise<MemoryChunk[]> {
    if (!queryText || queryText.length < 2) return [];
    readScope(scope);
    const queryEmbedding = await this.embed(queryText);
    broadcast(makeEvent('memory:searched' as any, { query: queryText.slice(0, 100), sessionId: scope.sessionId, ts: Date.now() }, scope));

    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `SELECT m.id, m.content, m.metadata, m.agent_id, m.quality, m.provenance,
                  m.session_id, 1 - (m.embedding <=> $1::vector) AS score
           FROM agent_memory m JOIN projects p ON p.id = m.project_id
           WHERE m.project_id = $2 AND p.user_id = $3
             AND (m.session_id = $4 OR ($5::boolean AND m.session_id IS NULL))
           ORDER BY m.embedding <=> $1::vector LIMIT $6`,
          [`[${queryEmbedding.join(',')}]`, scope.projectId, scope.userId, scope.sessionId, scope.includeLegacyProject === true, limit],
        );
        return rows.map((row) => {
          const metadata = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as MemoryMeta;
          const policy = row.session_id ? 'exact-session' as const : 'legacy-project' as const;
          return {
            id: row.id,
            content: row.content,
            metadata: metadata as unknown as Record<string, unknown>,
            score: parseFloat(row.score),
            quality: asQuality(row.quality),
            provenance: {
              ...provenance(scope, metadata, asQuality(row.quality), 'durable', policy, Date.now()),
              sessionId: row.session_id ?? null,
            },
          };
        });
      } catch (error) {
        console.warn(`[memory] durable search unavailable; checking only ephemeral exact-session memory (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    return inMemoryStore
      .filter((entry) => exactSessionScopeMatches(entry.scope, scope))
      .map((entry) => toChunk(entry, cosineSimilarity(queryEmbedding, entry.embedding)))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async list(limit = 500, offset = 0, scope?: MemoryReadScope): Promise<MemoryListEntry[]> {
    if (!scope) return [];
    readScope(scope);
    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `SELECT m.id, m.content, m.agent_id, m.source_type, m.source_ref, m.metadata, m.quality, m.session_id, m.created_at
           FROM agent_memory m JOIN projects p ON p.id = m.project_id
           WHERE m.project_id = $1 AND p.user_id = $2 AND m.session_id = $3
           ORDER BY m.created_at DESC LIMIT $4 OFFSET $5`,
          [scope.projectId, scope.userId, scope.sessionId, limit, offset],
        );
        return rows.map((row) => {
          const metadata = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as MemoryMeta;
          return {
            id: row.id, content: row.content, agentId: row.agent_id, sourceType: row.source_type,
            createdAt: new Date(row.created_at).getTime(), quality: asQuality(row.quality),
            provenance: provenance(scope, metadata, asQuality(row.quality), 'durable'),
          };
        });
      } catch (error) {
        console.warn(`[memory] durable list unavailable; listing only ephemeral scoped memory (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return inMemoryStore
      .filter((entry) => exactSessionScopeMatches(entry.scope, scope))
      .slice(offset, offset + limit)
      .map((entry) => ({
        id: entry.id, content: entry.content, agentId: entry.agentId ?? null, sourceType: entry.metadata.sourceType,
        createdAt: entry.createdAt, quality: entry.quality, provenance: provenance(entry.scope, entry.metadata, entry.quality, entry.storage),
      }));
  }

  async get(id: string, scope?: MemoryReadScope): Promise<(MemoryListEntry & { sourceRef: string | null; metadata: Record<string, unknown> }) | null> {
    if (!scope) return null;
    readScope(scope);
    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `SELECT m.id, m.content, m.agent_id, m.source_type, m.source_ref, m.metadata, m.quality, m.session_id, m.created_at
           FROM agent_memory m JOIN projects p ON p.id = m.project_id
           WHERE m.id = $1 AND m.project_id = $2 AND p.user_id = $3 AND m.session_id = $4 LIMIT 1`,
          [id, scope.projectId, scope.userId, scope.sessionId],
        );
        const row = rows[0];
        if (row) {
          const metadata = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as MemoryMeta;
          return {
            id: row.id, content: row.content, agentId: row.agent_id, sourceType: row.source_type, sourceRef: row.source_ref,
            metadata: metadata as unknown as Record<string, unknown>, createdAt: new Date(row.created_at).getTime(), quality: asQuality(row.quality),
            provenance: provenance(scope, metadata, asQuality(row.quality), 'durable'),
          };
        }
      } catch (error) {
        console.warn(`[memory] durable get unavailable; checking only ephemeral scoped memory (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const entry = inMemoryStore.find((item) => item.id === id && exactSessionScopeMatches(item.scope, scope));
    return entry ? {
      id: entry.id, content: entry.content, agentId: entry.agentId ?? null, sourceType: entry.metadata.sourceType,
      sourceRef: entry.metadata.sourceRef ?? null, metadata: entry.metadata as unknown as Record<string, unknown>, createdAt: entry.createdAt,
      quality: entry.quality, provenance: provenance(entry.scope, entry.metadata, entry.quality, entry.storage),
    } : null;
  }

  async delete(id: string, scope?: MemoryReadScope): Promise<boolean> {
    if (!scope) return false;
    readScope(scope);
    let deleted = false;
    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `DELETE FROM agent_memory m USING projects p
           WHERE m.id = $1 AND m.project_id = $2 AND p.id = m.project_id AND p.user_id = $3 AND m.session_id = $4
           RETURNING m.id`,
          [id, scope.projectId, scope.userId, scope.sessionId],
        );
        deleted = rows.length > 0;
      } catch (error) {
        console.warn(`[memory] durable delete unavailable; checking only ephemeral scoped memory (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    if (!deleted) {
      const index = inMemoryStore.findIndex((entry) => entry.id === id && exactSessionScopeMatches(entry.scope, scope));
      if (index >= 0) { inMemoryStore.splice(index, 1); deleted = true; }
    }
    if (deleted) broadcast(makeEvent('memory:deleted' as any, { id, ts: Date.now() }, scope));
    return deleted;
  }

  async count(scope?: TenantScope | MemoryReadScope): Promise<number> {
    if (!scope) return 0;
    const sessionId = 'sessionId' in scope ? scope.sessionId : null;
    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `SELECT COUNT(*) AS count FROM agent_memory m JOIN projects p ON p.id = m.project_id
           WHERE m.project_id = $1 AND p.user_id = $2 AND ($3::uuid IS NULL OR m.session_id = $3)`,
          [scope.projectId, scope.userId, sessionId],
        );
        return parseInt(rows[0]?.count ?? '0', 10);
      } catch { /* fall through to explicit ephemeral count */ }
    }
    return inMemoryStore.filter((entry) => sessionId
      ? exactSessionScopeMatches(entry.scope, scope as MemoryReadScope)
      : scopesMatch(entry.scope, scope)).length;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dot / denominator : 0;
}

export const memoryEngine = new MemoryEngine();
