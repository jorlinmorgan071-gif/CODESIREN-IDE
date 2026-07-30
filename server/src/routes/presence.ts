// server/src/routes/presence.ts
// Presence Layer API — directive Section 6.
//   POST /api/presence/gesture    emit a gesture event (presence:gesture WS event)
//   GET  /api/presence/health     presence layer status
//
// Per directive Section 4: "add the System Presence Layer as an input modality
// registered the same way keyboard/mouse are — not a separate floating app window."

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { makeEvent, broadcast } from '../ws/events.js';

export const presenceRouter = Router();

const gestureSchema = z.object({
  gesture: z.enum(['pinch', 'open-palm', 'close-fist']),
  target: z.string().optional(),
});

presenceRouter.post('/gesture', requireAuth, (req, res) => {
  const parsed = gestureSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  // Emit presence:gesture WS event — the UI's gesture handler (registered on
  // window, same as keyboard/mouse) receives this and dispatches a UI action.
  broadcast(makeEvent('presence:gesture' as any, {
    gesture: parsed.data.gesture,
    target: parsed.data.target ?? 'global',
  }));
  res.json({ emitted: true, gesture: parsed.data.gesture, target: parsed.data.target });
});

presenceRouter.get('/health', requireAuth, (_req, res) => {
  res.json({
    gesture: { registered: true, modality: 'window-event-listener' },
    faceAuth: { available: true, secondFactor: true },
  });
});
