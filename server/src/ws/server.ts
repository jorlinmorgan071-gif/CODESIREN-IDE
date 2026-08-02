// server/src/ws/server.ts
// Single WebSocket server, attached to the Express HTTP server (PDF Section 13).
// Connection URL: ws://localhost:3001/ws?token=JWT&projectId=UUID
//
// This is the ONE ws server Code Siren has. Voice (Step 8), Sentinel (Step 9),
// Presence (Step 10), and every absorbed capability route through here — never
// a second WS server.

import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config.js';
import { verifyToken } from '../auth/jwt.js';
import type { JwtClaims } from '../types.js';
import { registerSink, broadcast, makeEvent } from './events.js';
import { wsRateLimit } from '../middleware/rate-limiter.js';
import { logSecurityEvent } from '../monitoring/security-log.js';
import { voiceProxy } from '../systems/voice/voice-proxy.js';

interface SessionState {
  ws: WebSocket;
  claims: JwtClaims;
  projectId?: string;
}

const sessions = new Set<SessionState>();

export function attachWsServer(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const claims = verifyToken(token);
    if (!claims) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const state: SessionState = { ws, claims, projectId };
      sessions.add(state);
      wss.emit('connection', ws, state);
    });
  });

  wss.on('connection', (ws, state: SessionState) => {
    console.log(`[ws] Connected: user=${state.claims.email} project=${state.projectId ?? '-'}`);

    // Welcome event — confirms auth + connection
    ws.send(JSON.stringify(makeEvent('collab:join', {
      userId: state.claims.sub,
      name: state.claims.name,
      color: '#EE1C1C',
    })));

    ws.on('message', (raw, isBinary) => {
      // ── Binary messages = voice audio chunks ──────────────────────────
      // The browser sends raw audio data as binary WS frames. We route these
      // to the voice proxy for ASR processing.
      //
      // Option C fix (Phase E final proof): the binary frame is now PURE audio
      // data — no sessionId header. We look up the user's active voice session
      // via their WS auth state (state.claims.sub). This fixes the bug where
      // the old 16-byte sessionId header truncated the 42-char session IDs
      // (voice-${uuid} format), causing all binary audio to be silently dropped.
      //
      // If the user has multiple active sessions (e.g., two browser tabs), the
      // most recently started one wins (see voiceProxy.getSessionByUserId).
      if (isBinary && raw instanceof Buffer) {
        if (raw.length === 0) return;
        const session = voiceProxy.getSessionByUserId(state.claims.sub);
        if (session) {
          voiceProxy.receiveAudioChunk(session.id, raw.buffer as ArrayBuffer);
        }
        return;
      }

      // ── Text messages = JSON control events ───────────────────────────
      // Phase 3: WS rate limiting + input validation
      const wsId = `${state.claims.sub}-${state.ws.readyState}`;
      const rateCheck = wsRateLimit(wsId);
      if (!rateCheck.allowed) {
        logSecurityEvent({
          type: 'ws-rejected',
          severity: 'medium',
          ip: state.claims.sub,
          userId: state.claims.sub,
          description: rateCheck.reason ?? 'WS rate limit exceeded',
        });
        ws.send(JSON.stringify({
          event: 'error',
          payload: { code: 'WS_RATE_LIMIT', message: rateCheck.reason },
          ts: Date.now(),
          id: `err-${Date.now()}`,
        }));
        return;
      }

      // Validate message is valid JSON with required fields
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg.event || typeof msg.event !== 'string') {
          ws.send(JSON.stringify({
            event: 'error',
            payload: { code: 'WS_INVALID_FORMAT', message: 'Message must have an "event" string field' },
            ts: Date.now(),
            id: `err-${Date.now()}`,
          }));
          return;
        }
        // Limit message size to 64KB
        if (raw.toString().length > 65536) {
          ws.send(JSON.stringify({
            event: 'error',
            payload: { code: 'WS_TOO_LARGE', message: 'Message exceeds 64KB limit' },
            ts: Date.now(),
            id: `err-${Date.now()}`,
          }));
          return;
        }
        console.log(`[ws] client→server ${msg.event}`);

        // ── Voice control events ────────────────────────────────────────
        if (msg.event === 'voice:turn-end') {
          // Client detected silence — process the accumulated audio
          const sessionId = msg.payload?.sessionId;
          if (typeof sessionId === 'string') {
            const session = voiceProxy.getSession(sessionId);
            if (session && session.userId === state.claims.sub) {
              voiceProxy.processTurn(sessionId).catch((err) => {
                console.error(`[voice] processTurn failed for ${sessionId}:`, err);
              });
            }
          }
          return;
        }
      } catch {
        console.warn('[ws] non-JSON message from client');
        ws.send(JSON.stringify({
          event: 'error',
          payload: { code: 'WS_INVALID_JSON', message: 'Message must be valid JSON' },
          ts: Date.now(),
          id: `err-${Date.now()}`,
        }));
      }
    });

    ws.on('close', () => {
      sessions.delete(state);
      console.log(`[ws] Disconnected: user=${state.claims.email}`);
    });

    ws.on('error', (err) => {
      console.error(`[ws] error user=${state.claims.email}:`, err);
      sessions.delete(state);
    });
  });

  // Register the broadcast sink — anything that calls broadcast() from
  // orchestration/ reaches every connected client here.
  registerSink((event) => {
    const data = JSON.stringify(event);
    for (const s of sessions) {
      if (s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(data);
      }
    }
  });

  console.log(`[ws] WebSocket server attached at /ws (CORS: ${config.corsOrigins.join(', ')})`);
}

export { broadcast };
