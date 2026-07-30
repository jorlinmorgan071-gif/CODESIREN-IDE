// server/src/orchestration/loop-guard.ts
// Port of the donor's LoopGuard — detects and prevents agent loops.
//
// Three loop patterns blocked:
//   1. Identical call (same tool + same args hash) seen twice
//   2. Ping-pong (A-B-A-B over the last 4 calls)
//   3. Poll budget exceeded (too many total calls)
//
// Used by both react and codeact strategies. Single-shot doesn't call tools,
// so it doesn't need a guard.

import { createHash } from 'node:crypto';

export class LoopGuard {
  private seenHashes = new Set<string>();
  private recentCalls: string[] = [];
  private readonly pollBudget: number;
  private pollCount = 0;
  private readonly maxIdentical: number;
  private readonly maxPingPong: number;

  constructor(maxIdentical = 50, maxPingPong = 4, pollBudget = 100) {
    this.maxIdentical = maxIdentical;
    this.maxPingPong = maxPingPong;
    this.pollBudget = pollBudget;
  }

  /**
   * Check a tool call for loop patterns.
   * Returns an error message if a loop is detected, or null if the call is OK.
   */
  check(toolName: string, args: string): string | null {
    const hash = this.hashCall(toolName, args);

    // 1. Identical call detection
    if (this.seenHashes.has(hash)) {
      return `Loop detected: identical call to '${toolName}' with same arguments`;
    }
    this.seenHashes.add(hash);

    // 2. Ping-pong detection (A-B-A-B over the last 4 calls)
    this.recentCalls.push(toolName);
    if (this.recentCalls.length > this.maxPingPong * 2) {
      this.recentCalls.shift();
    }
    if (this.recentCalls.length >= 4) {
      const len = this.recentCalls.length;
      const calls = this.recentCalls;
      if (
        calls[len - 1] === calls[len - 3] &&
        calls[len - 2] === calls[len - 4] &&
        calls[len - 1] !== calls[len - 2]
      ) {
        return `Ping-pong loop detected between '${calls[len - 1]}' and '${calls[len - 2]}'`;
      }
    }

    // 3. Poll budget
    this.pollCount++;
    if (this.pollCount > this.pollBudget) {
      return `Poll budget exceeded: ${this.pollCount} calls made (budget: ${this.pollBudget})`;
    }

    return null;
  }

  reset(): void {
    this.seenHashes.clear();
    this.recentCalls = [];
    this.pollCount = 0;
  }

  private hashCall(toolName: string, args: string): string {
    return createHash('sha256').update(`${toolName}|${args}`).digest('hex');
  }
}
