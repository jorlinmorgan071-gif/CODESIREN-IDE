// server/src/routes/bubble.ts
// Phase B: Bubble accessibility settings routes.
//
//   GET  /api/bubble/settings  — current bubble settings
//   POST /api/bubble/settings  — update bubble settings
//   GET  /api/bubble/fonts     — available font options

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getBubbleSettings, setBubbleSettings, FONT_OPTIONS } from '../orchestrator/bubble-settings.js';

export const bubbleRouter = Router();

const settingsSchema = z.object({
  captionFont: z.enum(['inter', 'jetbrains', 'fira', 'space', 'outfit', 'dm', 'sora', 'manrope', 'jakarta', 'roboto-mono', 'source-code', 'bebas']).optional(),
  captionSize: z.enum(['xs', 'sm', 'md', 'lg']).optional(),
  captionShadow: z.enum(['none', 'soft', 'medium', 'strong', 'raised', 'glow']).optional(),
  captionBg: z.enum(['none', 'solid', 'blur', 'gradient', 'accent']).optional(),
  captionAnimation: z.enum(['none', 'fade', 'slide', 'scale', 'blur']).optional(),
  highContrast: z.boolean().optional(),
  bubbleShape: z.enum(['circle', 'rounded', 'squircle', 'hexagon']).optional(),
  bubbleVisual: z.enum(['ring', 'bars', 'pulse', 'orb', 'vrm']).optional(),
  bubbleAnimation: z.enum(['none', 'pulse', 'rotate', 'breathe']).optional(),
  showVRM: z.boolean().optional(),
  bubbleAvatarId: z.string().optional(),
  bubbleSize: z.enum(['sm', 'md', 'lg']).optional(),
});

bubbleRouter.get('/settings', requireAuth, (_req, res) => {
  res.json({ settings: getBubbleSettings() });
});

bubbleRouter.post('/settings', requireAuth, (req, res) => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const updated = setBubbleSettings(parsed.data);
  res.json({ settings: updated });
});

bubbleRouter.get('/fonts', requireAuth, (_req, res) => {
  res.json({ fonts: FONT_OPTIONS });
});
