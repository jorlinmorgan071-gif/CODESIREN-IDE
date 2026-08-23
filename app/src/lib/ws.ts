// app/src/lib/ws.ts
// WebSocket client — single connection per session, single source of agent:* events.
// PDF Section 13: ws://host/ws?token=JWT&projectId=UUID

import type { AgentEvent, AgentEventName } from '@/types';
import { getToken } from './auth';

const WS_BASE = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001/ws';

type Handler = (event: AgentEvent) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<AgentEventName, Set<Handler>>();
  private wildcardHandlers = new Set<Handler>();
  private reconnectAttempts = 0;
  private projectId: string | undefined;
  private intentionallyClosed = false;

  connect(projectId?: string): void {
    if (projectId) this.projectId = projectId;
    const token = getToken();
    if (!token) {
      console.warn('[ws] no token — connect after login');
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.intentionallyClosed = false;
    const projectParam = this.projectId ? `&projectId=${encodeURIComponent(this.projectId)}` : '';
    const url = `${WS_BASE}?token=${encodeURIComponent(token)}${projectParam}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      console.log('[ws] connected');
    };

    this.ws.onmessage = (ev) => {
      try {
        const evt = JSON.parse(ev.data) as AgentEvent;
        // Specific handlers
        const specific = this.handlers.get(evt.event);
        if (specific) for (const h of specific) h(evt);
        // Wildcard handlers
        for (const h of this.wildcardHandlers) h(evt);
      } catch (err) {
        console.warn('[ws] non-JSON message:', err);
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.intentionallyClosed) return;
      // Backoff reconnect
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15_000);
      this.reconnectAttempts++;
      console.log(`[ws] closed, reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connect(), delay);
    };

    this.ws.onerror = (err) => {
      console.error('[ws] error:', err);
    };
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.ws?.close();
    this.ws = null;
  }

  on(event: AgentEventName, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  onAny(handler: Handler): () => void {
    this.wildcardHandlers.add(handler);
    return () => this.wildcardHandlers.delete(handler);
  }

  send(event: string, payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Live voice audio is intentionally a raw binary frame. The backend
      // resolves the active authenticated session from this socket's JWT.
      if (payload instanceof ArrayBuffer) {
        this.ws.send(payload);
        return;
      }
      this.ws.send(JSON.stringify({ event, payload, ts: Date.now() }));
    }
  }
}

export const wsClient = new WsClient();
