// app/src/lib/api.ts
// Fetch wrapper for the Code Siren backend.
// Single base URL (VITE_API_URL), single auth header.

import type {
  AuthResponse,
  AgentListItem,
  SendTaskResponse,
  OrchestratorPlan,
  OrchestratorPlanStatus,
  OrchestratorPlanSummary,
  OrchestratorSettings,
  VoiceSettings,
  VoiceProviderOption,
  KokoroVoiceOption,
  ElevenLabsVoiceOption,
} from '@/types';
import { getToken, clearAuth } from './auth';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });

  if (res.status === 401) {
    clearAuth();
    throw new Error('Unauthorized — token cleared. Reload to re-authenticate.');
  }
  if (!res.ok) {
    let body: Record<string, unknown> | null = null;
    try { body = await res.json(); } catch { /* ignore */ }
    const errMsg = (body as Record<string, unknown>)?.error;
    throw new Error(typeof errMsg === 'string' ? errMsg : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  async register(email: string, password: string, name: string): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
  },

  async login(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  async me(): Promise<{ user: AuthResponse['user'] }> {
    return request('/auth/me');
  },

  async listAgents(): Promise<{ agents: AgentListItem[] }> {
    return request('/agents');
  },

  async sendToAgent(
    agentId: string,
    description: string,
    opts: {
      type?: string;
      executionMode?: 'single-shot' | 'react' | 'codeact';
      origin?: 'chat' | 'voice' | 'gesture' | 'api';
    } = {},
  ): Promise<SendTaskResponse> {
    return request<SendTaskResponse>(`/agents/${agentId}/send`, {
      method: 'POST',
      body: JSON.stringify({
        description,
        type: opts.type ?? 'chat',
        executionMode: opts.executionMode ?? 'single-shot',
        origin: opts.origin ?? 'chat',
      }),
    });
  },

  async health(): Promise<Record<string, unknown>> {
    return request('/health');
  },

  // AI Meeting Room — surfaces a structured meeting result (proposals,
  // votes, decision) so the AgentPanel "Open Meeting Room" button has a
  // real, visible response. Returns synchronously.
  async startMeeting(
    topic: string,
    quorum = 3,
  ): Promise<{
    meetingId: string;
    topic: string;
    decision: 'approved' | 'rejected' | 'inconclusive';
    tally: { approve: number; abstain: number; reject: number };
    quorum: number;
    participants: Array<{
      id: string;
      name: string;
      domain: string;
      color: string;
      trustScore: number;
    }>;
    proposals: Array<{
      agentId: string;
      agentName: string;
      domain: string;
      color: string;
      trustScore: number;
      text: string;
      vote: 'approve' | 'abstain' | 'reject';
    }>;
    startedAt: number;
    completedAt: number;
  }> {
    return request('/agents/meeting', {
      method: 'POST',
      body: JSON.stringify({ topic, quorum }),
    });
  },

  // ── Agent Relay + Orchestrator (directive Section 1.7) ──────────────────

  // Tier 1 chat — fire-and-forget; the response streams back over WS as
  // orchestrator:chunk events with the same shape as agent:chunk.
  orchestratorChat(sessionId: string, message: string, context?: {
    workspaceRoot?: string;
    activeFile?: string;
    openFiles?: string[];
    activeFileContent?: string;
  }): Promise<{
    taskId: string;
    sessionId: string;
    status: string;
    stream: string;
  }> {
    return request('/orchestrator/chat', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message, context }),
    });
  },

  // Generate a build plan from the session's chat history.
  generatePlan(sessionId: string): Promise<{
    planId: string;
    plan: OrchestratorPlan;
    engine: string;
    approvalMode: 'auto' | 'default';
    status: string;
  }> {
    return request('/orchestrator/plan', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
  },

  // Approve a plan (with optional milestone edits) and start the relay loop.
  approvePlan(planId: string, body: {
    approvalMode?: 'auto' | 'default';
    milestones?: Array<{
      id: string;
      title?: string;
      description?: string;
      assignedAgent?: string;
      dependsOn?: string[];
      acceptanceCriteria?: string[];
    }>;
  }): Promise<{ planId: string; status: string; message: string }> {
    return request(`/orchestrator/plan/${planId}/approve`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // Advance to the next milestone (default-approval mode).
  advancePlan(planId: string): Promise<{ planId: string; status: string }> {
    return request(`/orchestrator/plan/${planId}/advance`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  // Pause a running relay.
  pausePlan(planId: string): Promise<{ planId: string; status: string }> {
    return request(`/orchestrator/plan/${planId}/pause`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  // Stop a relay entirely.
  stopPlan(planId: string): Promise<{ planId: string; status: string }> {
    return request(`/orchestrator/plan/${planId}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  // Get current relay status (including milestone logs).
  getPlanStatus(planId: string): Promise<OrchestratorPlanStatus> {
    return request(`/orchestrator/plan/${planId}/status`);
  },

  // List all plans (or filter by session).
  listPlans(sessionId?: string): Promise<{ plans: OrchestratorPlanSummary[] }> {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    return request(`/orchestrator/plans${qs}`);
  },

  // Get full plan detail (for the sidebar Builds section).
  getPlanDetail(planId: string): Promise<OrchestratorPlanStatus> {
    return request(`/orchestrator/plan/${planId}`);
  },

  // Set orchestrator settings (engine + approval mode + Tier 1 model).
  setOrchestratorSettings(body: {
    engine?: 'gemini-flash' | 'nvidia-nemotron';
    approvalMode?: 'auto' | 'default';
    tier1Model?: string;
  }): Promise<{ settings: OrchestratorSettings }> {
    return request('/orchestrator/settings', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // Get orchestrator settings + available engines + Tier 1 model options.
  getOrchestratorSettings(): Promise<{
    settings: OrchestratorSettings;
    availableEngines: Array<{ id: string; available: boolean; reason?: string }>;
    tier1Models: Array<{ id: string; label: string; desc?: string }>;
  }> {
    return request('/orchestrator/settings');
  },

  // ── Phase E Build 2: Voice provider settings ───────────────────────────
  // Mirrors getOrchestratorSettings/setOrchestratorSettings pattern.

  // Get voice settings + available providers + Kokoro + ElevenLabs voice catalogs.
  getVoiceSettings(): Promise<{
    settings: VoiceSettings;
    voiceProviders: VoiceProviderOption[];
    kokoroVoices: KokoroVoiceOption[];
    elevenlabsVoices: ElevenLabsVoiceOption[];
  }> {
    return request('/voice/settings');
  },

  // Update voice settings (provider + optional kokoro voice/langCode + elevenlabs voiceId).
  // POST both persists AND applies the change at runtime via applyVoiceProvider().
  setVoiceSettings(body: Partial<VoiceSettings>): Promise<{ settings: VoiceSettings }> {
    return request('/voice/settings', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};
