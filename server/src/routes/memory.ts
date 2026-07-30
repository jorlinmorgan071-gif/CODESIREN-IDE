// server/src/routes/memory.ts
// Brain Visualizer — memory management API.
//   GET    /api/memory           — list all memories (paginated, for initial Brain load)
//   DELETE /api/memory/:id       — delete a memory by ID (real DELETE FROM agent_memory)
//
// Both require auth. Delete verifies the memory exists before deleting (404 if not found).
// Same fail-closed pattern as the approval gate and writeProjectFile.

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { memoryEngine } from '../memory/engine.js';
import { isDbAvailable, query } from '../db/client.js';

export const memoryRouter = Router();

// ── List all memories (paginated) ────────────────────────────────────────

memoryRouter.get('/', requireAuth, async (req, res) => {
  const limit = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '500', 10);
  const offset = parseInt(typeof req.query.offset === 'string' ? req.query.offset : '0', 10);

  try {
    const entries = await memoryEngine.list(Math.min(limit, 1000), offset);
    const total = await memoryEngine.count();
    res.json({
      entries,
      total,
      limit,
      offset,
      hasMore: offset + entries.length < total,
    });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to list memories: ${err.message}` });
  }
});

// ── Delete a memory by ID ────────────────────────────────────────────────

memoryRouter.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  // Verify the memory exists before deleting
  // (fail closed — 404 if not found, same pattern as ghost-mode approval)
  if (isDbAvailable()) {
    try {
      const rows = await query<any>(
        `SELECT id FROM agent_memory WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'Memory not found', id });
        return;
      }
    } catch {
      // DB check failed — proceed anyway, the delete will handle it
    }
  }

  try {
    const deleted = await memoryEngine.delete(id);
    if (!deleted) {
      res.status(404).json({ error: 'Memory not found', id });
      return;
    }
    res.json({ deleted: true, id });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to delete memory: ${err.message}` });
  }
});

// ── Get a single memory by ID (for detail panel) ─────────────────────────

memoryRouter.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  if (isDbAvailable()) {
    try {
      const rows = await query<any>(
        `SELECT id, content, agent_id, source_type, source_ref, metadata, created_at
         FROM agent_memory WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'Memory not found', id });
        return;
      }
      const row = rows[0];
      res.json({
        id: row.id,
        content: row.content,
        agentId: row.agent_id,
        sourceType: row.source_type,
        sourceRef: row.source_ref,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        createdAt: new Date(row.created_at).getTime(),
      });
      return;
    } catch (err: any) {
      res.status(500).json({ error: `Failed to get memory: ${err.message}` });
      return;
    }
  }

  // In-memory fallback — search the store
  res.status(404).json({ error: 'Memory not found (in-memory mode does not support single lookup)', id });
});
