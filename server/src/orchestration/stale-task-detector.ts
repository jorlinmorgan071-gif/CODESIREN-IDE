// server/src/orchestration/stale-task-detector.ts
// Phase 3 Follow-up — Stale Task Detector.
//
// On server boot AND periodically, scans .task-states/ for tasks that were
// left 'in-progress' or 'interrupted' from a previous process (or from a
// crash mid-execution). For each stale task:
//   1. Calls markInterrupted() if it hasn't been already (preserves which
//      step was running — the state file already has this from the last
//      startStep() call, which persisted immediately).
//   2. Broadcasts a 'task:stale-detected' WS event so the UI can surface
//      "Task X was interrupted — click to resume" to the user.
//   3. The task is now resumable via getResumptionPoint(taskId) — the
//      detector does NOT auto-resume, it only marks + surfaces. A user
//      or agent must explicitly request resumption.
//
// "Surface" means: broadcast a WS event + log it. The UI (or any WS client)
// receives the event and can show a notification. The task sits in
// 'interrupted' state on disk until someone calls resumeTask(taskId).
//
// Threshold: a task is considered stale if its updatedAt is older than
// STALE_THRESHOLD_MS (default 5 minutes, configurable via env var
// STALE_TASK_THRESHOLD_MS). This prevents false positives on tasks that
// are legitimately running (e.g., a long build step).

import { listTaskStates, markInterrupted, getResumptionPoint, type TaskState } from './task-state.js';
import { makeEvent, broadcast } from '../ws/events.js';
import { handleStaleTaskDetection } from './task-recovery.js';

const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000; // 1 minute

let scanIntervalHandle: NodeJS.Timeout | null = null;

export interface StaleTaskDetection {
  taskId: string;
  agentId: string;
  goal: string;
  previouslyStatus: string;   // 'in-progress' or 'interrupted' (before markInterrupted)
  staleForMs: number;         // how long since updatedAt
  resumeFromStep: number | null;
  resumeReason: string;
}

/**
 * Scan all task states for stale ones.
 * Returns the list of stale tasks found (empty if none).
 *
 * A task is stale if:
 *   - status is 'in-progress' or 'interrupted' (not 'completed', 'failed', 'not-started')
 *   - updatedAt is older than the threshold
 *
 * For each stale task:
 *   - If status was 'in-progress', call markInterrupted() to record the step
 *   - Compute the resumption point
 *   - Broadcast a WS event
 */
export function scanForStaleTasks(opts?: {
  thresholdMs?: number;
  broadcastEvents?: boolean;  // default true; false for tests
}): StaleTaskDetection[] {
  const threshold = opts?.thresholdMs ?? getStaleThreshold();
  const shouldBroadcast = opts?.broadcastEvents ?? true;
  const now = Date.now();
  const detections: StaleTaskDetection[] = [];

  const allStates = listTaskStates();

  for (const state of allStates) {
    // Only scan tasks that are in-progress or interrupted
    if (state.status !== 'in-progress' && state.status !== 'interrupted') {
      continue;
    }

    const ageMs = now - state.updatedAt;
    if (ageMs < threshold) {
      // Not stale yet — still legitimately running (or recently interrupted)
      continue;
    }

    // This task is stale
    const previouslyStatus = state.status;

    // If it was 'in-progress', mark it as interrupted (preserves which step
    // was running — markInterrupted reads the 'running' step from the state
    // file and records it in interruptedAtStep).
    if (previouslyStatus === 'in-progress') {
      markInterrupted(state.taskId);
    }

    // Compute resumption point
    const resumption = getResumptionPoint(state.taskId);

    const detection: StaleTaskDetection = {
      taskId: state.taskId,
      agentId: state.agentId,
      goal: state.goal,
      previouslyStatus,
      staleForMs: ageMs,
      resumeFromStep: resumption.resumeFromStep,
      resumeReason: resumption.reason,
    };
    detections.push(detection);

    console.log(
      `[stale-detector] stale task found: ${state.taskId} ` +
      `(agent=${state.agentId}, was=${previouslyStatus}, ` +
      `staleFor=${Math.round(ageMs / 1000)}s, ` +
      `resumeFromStep=${resumption.resumeFromStep})`
    );

    // Broadcast WS event so the UI can surface it
    if (shouldBroadcast) {
      try {
        broadcast(makeEvent('task:stale-detected' as any, {
          taskId: state.taskId,
          agentId: state.agentId,
          goal: state.goal,
          previouslyStatus,
          staleForMs: ageMs,
          resumeFromStep: resumption.resumeFromStep,
          resumeReason: resumption.reason,
        }));
      } catch (err) {
        // broadcast may fail if WS server isn't running (e.g., in tests)
        console.warn(`[stale-detector] failed to broadcast event for ${state.taskId}:`, err);
      }

      // Phase 4 Step 5: trigger the recovery flow from the stale detection.
      // This is NOT a separate mechanism — it's the same recovery flow,
      // triggered by the stale detector's output.
      try {
        handleStaleTaskDetection(detection);
      } catch (err) {
        console.warn(`[stale-detector] recovery handler failed for ${state.taskId}:`, err);
      }
    }
  }

  if (detections.length > 0) {
    console.log(`[stale-detector] scan complete: ${detections.length} stale task(s) found`);
  }

  return detections;
}

/**
 * Start the periodic stale-task scan.
 * Runs immediately on call (boot), then every scanIntervalMs.
 */
export function startStaleTaskDetector(opts?: {
  scanIntervalMs?: number;
  thresholdMs?: number;
}): void {
  if (process.env.DISABLE_STALE_TASK_DETECTOR === '1') {
    console.log('[stale-detector] disabled (DISABLE_STALE_TASK_DETECTOR=1)');
    return;
  }
  if (scanIntervalHandle) return; // already started

  const scanInterval = opts?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;

  console.log(
    `[stale-detector] started ` +
    `(scan every ${scanInterval / 1000}s, ` +
    `stale threshold ${getStaleThreshold(opts?.thresholdMs) / 1000}s)`
  );

  // Run immediately on boot — this is the critical scan that catches
  // tasks orphaned by a previous process crash.
  const bootDetections = scanForStaleTasks({ thresholdMs: opts?.thresholdMs });
  if (bootDetections.length > 0) {
    console.log(`[stale-detector] boot scan found ${bootDetections.length} orphaned task(s)`);
  }

  // Schedule periodic scans — catches tasks that go stale while the server
  // is running (e.g., agent process crashes mid-execution hours into uptime)
  scanIntervalHandle = setInterval(() => {
    try {
      scanForStaleTasks({ thresholdMs: opts?.thresholdMs });
    } catch (err) {
      console.error('[stale-detector] periodic scan error:', err);
    }
  }, scanInterval);

  // Don't keep Node alive just for this interval
  if (scanIntervalHandle.unref) scanIntervalHandle.unref();
}

/**
 * Stop the periodic scan. For tests / shutdown.
 */
export function stopStaleTaskDetector(): void {
  if (scanIntervalHandle) {
    clearInterval(scanIntervalHandle);
    scanIntervalHandle = null;
    console.log('[stale-detector] stopped');
  }
}

/**
 * Get the stale threshold from env var or use the provided/default value.
 */
function getStaleThreshold(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const envValue = process.env.STALE_TASK_THRESHOLD_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_STALE_THRESHOLD_MS;
}
