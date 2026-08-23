// Shared memory engine. P0 requires every entry and notification to be bound
// to an authenticated user/project scope before it can be stored, queried, or sent.

import { modelRouter } from '../orchestration/model-router.js';
import { isDbAvailable, query } from '../db/client.js';
import type { MemoryChunk, MemoryMeta } from '../types.js';
import { makeEvent, broadcast } from '../ws/events.js';
import { scopesMatch, type TenantScope } from '../tenancy/scope.js';

export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: MemoryMeta;
  agentId?: string;
  scope: TenantScope;
  createdAt: number;
}

const inMemoryStore: MemoryEntry[] = [];

export class MemoryEngine {
  async embed(text: string): Promise<number[]> {
    return modelRouter.embed(text);
  }

  async memorize(content: string, metadata: MemoryMeta, agentId?: string, scope?: TenantScope): Promise<void> {
    if (!content || content.length < 5) return;
    if (!scope) {
      console.warn('[memory] refusing unscoped write');
      return;
    }

    const embedding = await this.embed(content);
    const id = crypto.randomUUID();

    if (isDbAvailable()) {
      try {
        const inserted = await query<{ id: string }>(
          `INSERT INTO agent_memory (id, project_id, agent_id, source_type, source_ref, content, embedding, metadata)
           SELECT $1, p.id, $3, $4, $5, $6, $7::vector, $8
           FROM projects p WHERE p.id = $2 AND p.user_id = $9
           RETURNING id`,
          [
            id,
            scope.projectId,
            agentId ?? null,
            metadata.sourceType ?? 'agent',
            metadata.sourceRef ?? agentId ?? null,
            content,
            `[${embedding.join(',')}]`,
            JSON.stringify({ ...metadata, tags: metadata.tags ?? [] }),
            scope.userId,
          ],
        );
        if (inserted.length === 0) {
          console.warn('[memory] scoped DB write rejected: project ownership no longer exists');
          return;
        }
      } catch (err: any) {
        console.warn(`[memory] scoped DB write failed (${err.message}), using in-memory`);
        inMemoryStore.push({ id, content, embedding, metadata, agentId, scope, createdAt: Date.now() });
      }
    } else {
      inMemoryStore.push({ id, content, embedding, metadata, agentId, scope, createdAt: Date.now() });
    }

    broadcast(makeEvent('memory:created' as any, {
      id,
      agentId: agentId ?? null,
      sourceType: metadata.sourceType ?? 'agent',
      contentPreview: content.slice(0, 200),
      createdAt: Date.now(),
    }, scope));
  }

  async search(queryText: string, limit = 5, scope?: TenantScope): Promise<MemoryChunk[]> {
    if (!queryText || queryText.length < 2 || !scope) return [];
    const queryEmbedding = await this.embed(queryText);

    broadcast(makeEvent('memory:searched' as any, { query: queryText.slice(0, 100), ts: Date.now() }, scope));

    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `SELECT m.id, m.content, m.metadata, m.agent_id, 1 - (m.embedding <=> $1::vector) AS score
           FROM agent_memory m JOIN projects p ON p.id = m.project_id
           WHERE m.project_id = $2 AND p.user_id = $3
           ORDER BY m.embedding <=> $1::vector LIMIT $4`,
          [`[${queryEmbedding.join(',')}]`, scope.projectId, scope.userId, limit],
        );
        return rows.map(row => ({
          id: row.id,
          content: row.content,
          metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>,
          score: parseFloat(row.score),
        }));
      } catch (err: any) {
        console.warn(`[memory] scoped DB search failed (${err.message}), using in-memory`);
      }
    }

    return inMemoryStore
      .filter(entry => scopesMatch(entry.scope, scope))
      .map(entry => ({
        id: entry.id,
        content: entry.content,
        metadata: entry.metadata as unknown as Record<string, unknown>,
        score: cosineSimilarity(queryEmbedding, entry.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async list(limit = 500, offset = 0, scope?: TenantScope): Promise<Array<{ id: string; content: string; agentId: string | null; sourceType: string | null; createdAt: number }>> {
    if (!scope) return [];
    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `SELECT m.id, m.content, m.agent_id, m.source_type, m.created_at
           FROM agent_memory m JOIN projects p ON p.id = m.project_id
           WHERE m.project_id = $1 AND p.user_id = $2
           ORDER BY m.created_at DESC LIMIT $3 OFFSET $4`,
          [scope.projectId, scope.userId, limit, offset],
        );
        return rows.map(row => ({ id: row.id, content: row.content, agentId: row.agent_id, sourceType: row.source_type, createdAt: new Date(row.created_at).getTime() }));
      } catch (err: any) {
        console.warn(`[memory] scoped DB list failed (${err.message}), using in-memory`);
      }
    }
    return inMemoryStore
      .filter(entry => scopesMatch(entry.scope, scope))
      .slice(offset, offset + limit)
      .map(entry => ({ id: entry.id, content: entry.content, agentId: entry.agentId ?? null, sourceType: entry.metadata.sourceType ?? 'agent', createdAt: entry.createdAt }));
  }

  async get(id: string, scope?: TenantScope): Promise<{ id: string; content: string; agentId: string | null; sourceType: string | null; sourceRef: string | null; metadata: Record<string, unknown>; createdAt: number } | null> {
    if (!scope) return null;
    if (isDbAvailable()) {
      const rows = await query<any>(
        `SELECT m.id, m.content, m.agent_id, m.source_type, m.source_ref, m.metadata, m.created_at
         FROM agent_memory m JOIN projects p ON p.id = m.project_id
         WHERE m.id = $1 AND m.project_id = $2 AND p.user_id = $3 LIMIT 1`,
        [id, scope.projectId, scope.userId],
      );
      const row = rows[0];
      if (row) return { id: row.id, content: row.content, agentId: row.agent_id, sourceType: row.source_type, sourceRef: row.source_ref, metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata, createdAt: new Date(row.created_at).getTime() };
    }
    const entry = inMemoryStore.find(item => item.id === id && scopesMatch(item.scope, scope));
    return entry ? { id: entry.id, content: entry.content, agentId: entry.agentId ?? null, sourceType: entry.metadata.sourceType ?? null, sourceRef: entry.metadata.sourceRef ?? null, metadata: entry.metadata as unknown as Record<string, unknown>, createdAt: entry.createdAt } : null;
  }

  async delete(id: string, scope?: TenantScope): Promise<boolean> {
    if (!scope) return false;
    let deleted = false;
    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `DELETE FROM agent_memory m USING projects p
           WHERE m.id = $1 AND m.project_id = $2 AND p.id = m.project_id AND p.user_id = $3
           RETURNING m.id`,
          [id, scope.projectId, scope.userId],
        );
        deleted = rows.length > 0;
      } catch (err: any) {
        console.warn(`[memory] scoped DB delete failed (${err.message}), using in-memory`);
      }
    }
    if (!deleted) {
      const index = inMemoryStore.findIndex(entry => entry.id === id && scopesMatch(entry.scope, scope));
      if (index >= 0) {
        inMemoryStore.splice(index, 1);
        deleted = true;
      }
    }
    if (deleted) broadcast(makeEvent('memory:deleted' as any, { id, ts: Date.now() }, scope));
    return deleted;
  }

  async count(scope?: TenantScope): Promise<number> {
    if (!scope) return 0;
    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `SELECT COUNT(*) AS count FROM agent_memory m JOIN projects p ON p.id = m.project_id
           WHERE m.project_id = $1 AND p.user_id = $2`,
          [scope.projectId, scope.userId],
        );
        return parseInt(rows[0]?.count ?? '0', 10);
      } catch {
        // Fall through to scoped in-memory data.
      }
    }
    return inMemoryStore.filter(entry => scopesMatch(entry.scope, scope)).length;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export const memoryEngine = new MemoryEngine();
