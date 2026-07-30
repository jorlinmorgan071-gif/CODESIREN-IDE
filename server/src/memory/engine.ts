// server/src/memory/engine.ts
// MemoryEngine — singleton that all 20 agents share for recall()/memorize().
//
// Per Fix 1: the fix is NOT "give Memory Agent real RAG for its own chat persona."
// The fix is a shared MemoryEngine that the BASE CLASS delegates to, so all 20
// agents get real memory automatically. Memory Agent additionally exposes
// recall() as a user-facing capability.
//
// Uses the existing agent_memory table (migration 002, already has vector(768)
// + ivfflat index). Embeddings via ModelRouter.embed() — same engine selection
// as chat (Ollama/OpenAI/stub), NOT a third routing system.

import { modelRouter } from '../orchestration/model-router.js';
import { isDbAvailable, query } from '../db/client.js';
import type { MemoryChunk, MemoryMeta } from '../types.js';
import { makeEvent, broadcast } from '../ws/events.js';

// ── In-memory store (used when DB is unavailable — degraded mode) ────────
export interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: MemoryMeta;
  agentId?: string;
  createdAt: number;
}

const inMemoryStore: MemoryEntry[] = [];

// ── MemoryEngine singleton ───────────────────────────────────────────────

class MemoryEngine {
  /**
   * Embed text using ModelRouter.embed() (Ollama/OpenAI/stub).
   */
  async embed(text: string): Promise<number[]> {
    return modelRouter.embed(text);
  }

  /**
   * Store a memory entry: embed the content, insert into agent_memory
   * (or in-memory store if DB unavailable).
   */
  async memorize(
    content: string,
    metadata: MemoryMeta,
    agentId?: string,
    projectId?: string,
  ): Promise<void> {
    if (!content || content.length < 5) return; // don't store trivially short content

    const embedding = await this.embed(content);
    const id = crypto.randomUUID();
    const pid = projectId ?? '00000000-0000-0000-0000-000000000000';

    if (isDbAvailable()) {
      // Store in PostgreSQL with pgvector
      try {
        const embeddingStr = `[${embedding.join(',')}]`;
        await query(
          `INSERT INTO agent_memory (id, project_id, agent_id, source_type, source_ref, content, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
          [
            id,
            pid,
            agentId ?? null,
            metadata.sourceType ?? 'agent',
            metadata.sourceRef ?? agentId ?? null,
            content,
            embeddingStr,
            JSON.stringify({ ...metadata, tags: metadata.tags ?? [] }),
          ],
        );
        console.log(`[memory] stored ${content.length} chars from ${agentId ?? 'unknown'} (pgvector)`);
      } catch (err: any) {
        // DB write failed — fall back to in-memory
        console.warn(`[memory] DB write failed (${err.message}), using in-memory`);
        inMemoryStore.push({ id, content, embedding, metadata, agentId, createdAt: Date.now() });
      }
    } else {
      // Degraded mode — in-memory store
      inMemoryStore.push({ id, content, embedding, metadata, agentId, createdAt: Date.now() });
      console.log(`[memory] stored ${content.length} chars from ${agentId ?? 'unknown'} (in-memory, ${inMemoryStore.length} entries)`);
    }

    // Brain Visualizer: broadcast memory:created so the 3D scene can add a node live
    broadcast(makeEvent('memory:created' as any, {
      id,
      agentId: agentId ?? null,
      sourceType: metadata.sourceType ?? 'agent',
      contentPreview: content.slice(0, 200),
      createdAt: Date.now(),
    }));
  }

  /**
   * Semantic search: embed the query, find the closest entries by cosine similarity.
   * Works with both pgvector (DB mode) and in-memory store (degraded mode).
   */
  async search(
    queryText: string,
    limit: number = 5,
    projectId?: string,
  ): Promise<MemoryChunk[]> {
    if (!queryText || queryText.length < 2) return [];

    const queryEmbedding = await this.embed(queryText);
    const pid = projectId ?? '00000000-0000-0000-0000-000000000000';

    // Brain Visualizer: broadcast memory:searched so the core sphere can pulse
    broadcast(makeEvent('memory:searched' as any, {
      query: queryText.slice(0, 100),
      ts: Date.now(),
    }));

    if (isDbAvailable()) {
      // Use pgvector cosine similarity search
      try {
        const embeddingStr = `[${queryEmbedding.join(',')}]`;
        const rows = await query<any>(
          `SELECT id, content, metadata, agent_id,
                  1 - (embedding <=> $1::vector) as score
           FROM agent_memory
           WHERE project_id = $2
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          [embeddingStr, pid, limit],
        );
        return rows.map(row => ({
          id: row.id,
          content: row.content,
          metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>,
          score: parseFloat(row.score),
        }));
      } catch (err: any) {
        console.warn(`[memory] DB search failed (${err.message}), using in-memory`);
        // Fall through to in-memory search
      }
    }

    // In-memory cosine similarity search
    const results = inMemoryStore
      .map(entry => ({
        id: entry.id,
        content: entry.content,
        metadata: entry.metadata as unknown as Record<string, unknown>,
        score: cosineSimilarity(queryEmbedding, entry.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return results;
  }

  /**
   * List all memory entries (for Brain Visualizer initial load).
   * Paginated — does not load the entire table at once.
   */
  async list(limit: number = 500, offset: number = 0): Promise<Array<{
    id: string;
    content: string;
    agentId: string | null;
    sourceType: string | null;
    createdAt: number;
  }>> {
    if (isDbAvailable()) {
      try {
        const rows = await query<any>(
          `SELECT id, content, agent_id, source_type, created_at
           FROM agent_memory
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        return rows.map(row => ({
          id: row.id,
          content: row.content,
          agentId: row.agent_id,
          sourceType: row.source_type,
          createdAt: new Date(row.created_at).getTime(),
        }));
      } catch (err: any) {
        console.warn(`[memory] DB list failed (${err.message}), using in-memory`);
      }
    }

    // In-memory fallback
    return inMemoryStore
      .slice(offset, offset + limit)
      .map(entry => ({
        id: entry.id,
        content: entry.content,
        agentId: entry.agentId ?? null,
        sourceType: entry.metadata.sourceType ?? 'agent',
        createdAt: entry.createdAt,
      }));
  }

  /**
   * Delete a memory entry by ID. Returns true if deleted, false if not found.
   * Brain Visualizer: broadcasts memory:deleted on success.
   */
  async delete(id: string): Promise<boolean> {
    let deleted = false;

    if (isDbAvailable()) {
      try {
        const result = await query<any>(
          `DELETE FROM agent_memory WHERE id = $1 RETURNING id`,
          [id],
        );
        deleted = result.length > 0;
      } catch (err: any) {
        console.warn(`[memory] DB delete failed (${err.message}), using in-memory`);
        // Fall through to in-memory
      }
    }

    if (!deleted) {
      // In-memory fallback — check if the entry exists before deleting
      const idx = inMemoryStore.findIndex(e => e.id === id);
      if (idx >= 0) {
        inMemoryStore.splice(idx, 1);
        deleted = true;
      }
    }

    if (deleted) {
      // Brain Visualizer: broadcast memory:deleted so the 3D scene can animate the node out
      broadcast(makeEvent('memory:deleted' as any, { id, ts: Date.now() }));
    }

    return deleted;
  }

  /**
   * Get the count of stored memories.
   */
  async count(): Promise<number> {
    if (isDbAvailable()) {
      try {
        const rows = await query<any>(`SELECT COUNT(*) as count FROM agent_memory`);
        return parseInt(rows[0]?.count ?? '0', 10);
      } catch {
        // Fall through to in-memory
      }
    }
    return inMemoryStore.length;
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
