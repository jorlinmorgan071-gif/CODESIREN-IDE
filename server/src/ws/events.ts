// server/src/ws/events.ts
// Typed event registry — single source of truth for every WS event Code Siren emits.
// PDF Section 13 + directive Section 6 addendum (fabrication:*, presence:*, sentinel:*).
//
// Every event carries `ts` (epoch ms) and `id` (uuid) — per PDF Section 20 rule.
// No event is exempt — including the new Personal-Pillar events.

import { v4 as uuid } from 'uuid';
import type { AgentEvent, AgentEventName } from '../types.js';
import type { TenantScope } from '../tenancy/scope.js';

export function makeEvent<P>(event: AgentEventName, payload: P, scope?: TenantScope): AgentEvent<P> {
  return {
    event,
    payload,
    ts: Date.now(),
    id: uuid(),
    scope,
  };
}

// Broadcast helper — called by AgentManager / Ghost Mode / etc.
// Subscribers are registered via WS server.ts.
export type WsSink = (event: AgentEvent) => void;

const sinks = new Set<WsSink>();

export function registerSink(sink: WsSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function broadcast(event: AgentEvent): void {
  for (const sink of sinks) {
    try {
      sink(event);
    } catch (err) {
      console.error('[ws] sink threw:', err);
    }
  }
}
