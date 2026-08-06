// server/src/routes/voice-live.ts
// Face Avatar + Live Voice Pipeline — REST routes for session lifecycle.
//   POST /api/voice/live/start   — start a live voice session
//   POST /api/voice/live/:id/end — end a session (fully closes everything)
//   POST /api/voice/live/:id/mute — toggle mute (keeps session alive)
//   GET  /api/voice/live/:id/status — get session status
//
// Audio data flows through the EXISTING WebSocket server (not a new one).
// The WS handler for voice audio is in ws/server.ts.

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { voiceProxy } from '../systems/voice/voice-proxy.js';

export const voiceLiveRouter = Router();

// ── Start a live voice session ───────────────────────────────────────────

voiceLiveRouter.post('/live/start', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const projectId = (typeof req.body?.projectId === 'string' ? req.body.projectId : '00000000-0000-0000-0000-000000000000');
  // Pass the user's display name (from JWT claims) for greeting personalization
  const userDisplayName = req.user?.name ?? '';

  try {
    const sessionId = await voiceProxy.startSession(userId, projectId, userDisplayName);
    res.json({
      sessionId,
      status: 'active',
      silenceTimeoutMs: voiceProxy.silenceTimeoutMs,
    });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to start voice session: ${err.message}` });
  }
});

// ── End a session ────────────────────────────────────────────────────────

voiceLiveRouter.post('/live/:id/end', requireAuth, (req, res) => {
  const { id } = req.params;
  const session = voiceProxy.getSession(id);

  if (!session) {
    res.status(404).json({ error: 'Voice session not found', id });
    return;
  }

  // Verify ownership
  if (session.userId !== req.user?.id) {
    res.status(403).json({ error: 'Session belongs to another user', id });
    return;
  }

  voiceProxy.endSession(id);
  res.json({ ended: true, id });
});

// ── Toggle mute ──────────────────────────────────────────────────────────

voiceLiveRouter.post('/live/:id/mute', requireAuth, (req, res) => {
  const { id } = req.params;
  const session = voiceProxy.getSession(id);

  if (!session) {
    res.status(404).json({ error: 'Voice session not found', id });
    return;
  }

  if (session.userId !== req.user?.id) {
    res.status(403).json({ error: 'Session belongs to another user', id });
    return;
  }

  const muted = typeof req.body?.muted === 'boolean' ? req.body.muted : !session.muted;
  voiceProxy.setMuted(id, muted);
  res.json({ sessionId: id, muted });
});

// ── Get session status ───────────────────────────────────────────────────

voiceLiveRouter.get('/live/:id/status', requireAuth, (req, res) => {
  const { id } = req.params;
  const session = voiceProxy.getSession(id);

  if (!session) {
    res.status(404).json({ error: 'Voice session not found', id });
    return;
  }

  if (session.userId !== req.user?.id) {
    res.status(403).json({ error: 'Session belongs to another user', id });
    return;
  }

  res.json({
    sessionId: id,
    active: true,
    muted: session.muted,
    startedAt: session.startedAt,
    lastAudioAt: session.lastAudioAt,
    silenceTimeoutMs: voiceProxy.silenceTimeoutMs,
  });
});
