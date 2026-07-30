// app/src/store/RelayContext.tsx
// Global state for the Agent Relay system — directive Section 2.3.
//
// Tracks:
//   - Current running plan (planId, status, currentMilestone, projectName)
//   - Awaiting-user state (when the relay pauses for user advance)
//   - All known plans (for the sidebar Builds section)
//
// Listens to WS events: relay:plan-ready, relay:milestone-start,
// relay:milestone-complete, relay:milestone-rejected, relay:awaiting-user,
// relay:plan-complete, relay:error.

/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { wsClient } from '@/lib/ws';
import { api } from '@/lib/api';
import type { AgentEvent, OrchestratorPlanSummary } from '@/types';

interface RelayState {
  // The currently-running plan, if any.
  activePlanId: string | null;
  activeProjectName: string | null;
  activeMilestoneId: string | null;
  activeMilestoneTitle: string | null;
  activeAgentId: string | null;
  status: 'idle' | 'running' | 'awaiting-user' | 'completed' | 'failed';
  // When awaiting-user: the summary to display + next milestone id.
  awaitingSummary: string | null;
  awaitingNextMilestoneId: string | null;
  // The most recent error from the relay.
  lastError: string | null;
  // Total milestones in the active plan + index of the current one.
  totalMilestones: number;
  completedMilestones: number;
}

interface RelayContextValue extends RelayState {
  // Refresh the plans list from the server (used by the sidebar).
  refreshPlans: () => Promise<void>;
  // All known plans (sidebar Builds list).
  plans: OrchestratorPlanSummary[];
  // Open the plan review panel for a specific plan.
  reviewPlanId: string | null;
  openPlanReview: (planId: string) => void;
  closePlanReview: () => void;
  // Advance / pause / stop the active plan.
  advance: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
}

const RelayContext = createContext<RelayContextValue | null>(null);

const initialState: RelayState = {
  activePlanId: null,
  activeProjectName: null,
  activeMilestoneId: null,
  activeMilestoneTitle: null,
  activeAgentId: null,
  status: 'idle',
  awaitingSummary: null,
  awaitingNextMilestoneId: null,
  lastError: null,
  totalMilestones: 0,
  completedMilestones: 0,
};

export function RelayProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RelayState>(initialState);
  const [plans, setPlans] = useState<OrchestratorPlanSummary[]>([]);
  const [reviewPlanId, setReviewPlanId] = useState<string | null>(null);

  const refreshPlans = useCallback(async () => {
    try {
      const res = await api.listPlans();
      setPlans(res.plans);
    } catch (err) {
      console.warn('[relay] refreshPlans failed:', err);
    }
  }, []);

  // Load plans list on mount. refreshPlans is async and calls setPlans
  // AFTER an await, so this does NOT trigger the cascading-render path
  // that react-hooks/set-state-in-effect guards against — the eslint
  // rule fires statically without knowing that.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshPlans();
  }, [refreshPlans]);

  // Subscribe to relay:* WS events
  useEffect(() => {
    const offPlanReady = wsClient.on('relay:plan-ready' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { planId: string; plan: { projectName: string; milestones: unknown[] } };
      setState({
        ...initialState,
        activePlanId: payload.planId,
        activeProjectName: payload.plan.projectName,
        totalMilestones: payload.plan.milestones.length,
        status: 'idle',  // plan-ready means awaiting user approval, not running yet
      });
      refreshPlans();
    });

    const offMilestoneStart = wsClient.on('relay:milestone-start' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { agentId: string; description: string };
      setState((s) => ({
        ...s,
        activeAgentId: payload.agentId,
        status: 'running',
        activeMilestoneTitle: payload.description.split('\n')[0] ?? null,
      }));
    });

    const offMilestoneComplete = wsClient.on('relay:milestone-complete' as never, () => {
      setState((s) => ({
        ...s,
        activeMilestoneId: null,
        activeAgentId: null,
        completedMilestones: s.completedMilestones + 1,
      }));
      refreshPlans();
    });

    const offMilestoneRejected = wsClient.on('relay:milestone-rejected' as never, () => {
      // Don't change state — the relay will retry the milestone.
      // The frontend can show a transient toast if desired.
    });

    const offAwaitingUser = wsClient.on('relay:awaiting-user' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { planId: string; milestoneId: string; summary: string; nextMilestoneId?: string };
      setState((s) => ({
        ...s,
        status: 'awaiting-user',
        awaitingSummary: payload.summary,
        awaitingNextMilestoneId: payload.nextMilestoneId ?? null,
      }));
    });

    const offPlanComplete = wsClient.on('relay:plan-complete' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { planId: string; projectName: string };
      setState({
        ...initialState,
        status: 'completed',
        activePlanId: payload.planId,
        activeProjectName: payload.projectName,
      });
      refreshPlans();
    });

    const offError = wsClient.on('relay:error' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { planId: string; error: string };
      setState((s) => ({
        ...s,
        status: 'failed',
        lastError: payload.error,
      }));
    });

    return () => {
      offPlanReady();
      offMilestoneStart();
      offMilestoneComplete();
      offMilestoneRejected();
      offAwaitingUser();
      offPlanComplete();
      offError();
    };
  }, [refreshPlans]);

  const openPlanReview = useCallback((planId: string) => {
    setReviewPlanId(planId);
  }, []);

  const closePlanReview = useCallback(() => {
    setReviewPlanId(null);
  }, []);

  const advance = useCallback(async () => {
    if (!state.activePlanId) return;
    try {
      await api.advancePlan(state.activePlanId);
      setState((s) => ({ ...s, status: 'running', awaitingSummary: null }));
    } catch (err) {
      console.warn('[relay] advance failed:', err);
    }
  }, [state.activePlanId]);

  const pause = useCallback(async () => {
    if (!state.activePlanId) return;
    try {
      await api.pausePlan(state.activePlanId);
      setState((s) => ({ ...s, status: 'idle' }));
    } catch (err) {
      console.warn('[relay] pause failed:', err);
    }
  }, [state.activePlanId]);

  const stop = useCallback(async () => {
    if (!state.activePlanId) return;
    try {
      await api.stopPlan(state.activePlanId);
      setState({ ...initialState });
    } catch (err) {
      console.warn('[relay] stop failed:', err);
    }
  }, [state.activePlanId]);

  return (
    <RelayContext.Provider
      value={{
        ...state,
        plans,
        refreshPlans,
        reviewPlanId,
        openPlanReview,
        closePlanReview,
        advance,
        pause,
        stop,
      }}
    >
      {children}
    </RelayContext.Provider>
  );
}

export function useRelay() {
  const ctx = useContext(RelayContext);
  if (!ctx) throw new Error('useRelay must be used within RelayProvider');
  return ctx;
}
