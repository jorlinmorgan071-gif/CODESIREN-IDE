// server/src/monitoring/security-log.ts
// Security telemetry — logs all security-relevant events.
// Read-only dashboard endpoint at /api/security/events.

import type { Response } from 'express';

export type SecurityEventType =
  | 'rate-limit-exceeded'
  | 'request-rejected'
  | 'tool-denied'
  | 'sandbox-violation'
  | 'auth-anomaly'
  | 'face-auth-failed'
  | 'ws-rejected'
  | 'circuit-breaker-open'
  | 'circuit-breaker-closed'
  | 'input-validation-failed';

export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SecurityEvent {
  id: string;
  timestamp: number;
  type: SecurityEventType;
  severity: SecuritySeverity;
  ip?: string;
  userId?: string;
  endpoint?: string;
  method?: string;
  description: string;
  meta?: Record<string, unknown>;
}

// Ring buffer — last 1000 events
const MAX_EVENTS = 1000;
const events: SecurityEvent[] = [];
let eventIdCounter = 0;

export function logSecurityEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): void {
  const full: SecurityEvent = {
    ...event,
    id: `sec-${++eventIdCounter}`,
    timestamp: Date.now(),
  };
  events.push(full);
  if (events.length > MAX_EVENTS) {
    events.shift();
  }

  // Log to console (structured)
  const level = event.severity === 'critical' ? 'ERROR' : event.severity === 'high' ? 'WARN' : 'INFO';
  console.log(`[security:${level}] ${event.type}: ${event.description} (ip=${event.ip ?? '-'}, user=${event.userId ?? '-'})`);
}

// ── Query API ────────────────────────────────────────────────────────────

export function getSecurityEvents(opts: { limit?: number; type?: SecurityEventType; severity?: SecuritySeverity } = {}): SecurityEvent[] {
  let result = [...events];
  if (opts.type) result = result.filter(e => e.type === opts.type);
  if (opts.severity) result = result.filter(e => e.severity === opts.severity);
  const limit = opts.limit ?? 100;
  return result.slice(-limit).reverse(); // newest first
}

export function getSecurityStats() {
  const now = Date.now();
  const last5min = events.filter(e => e.timestamp > now - 300_000);
  return {
    total: events.length,
    last5Minutes: last5min.length,
    byType: countBy(last5min, e => e.type),
    bySeverity: countBy(last5min, e => e.severity),
  };
}

function countBy<T>(arr: T[], fn: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of arr) {
    const key = fn(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}
