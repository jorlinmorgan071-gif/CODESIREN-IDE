export interface Project {
  id: string;
  name: string;
  lastAccessed: string;
  activeAgents: number;
  completionPercent: number;
  errorCount: number;
  files: FileNode[];
  chats: ChatSession[];
}

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  language?: string;
  content?: string;
  isOpen?: boolean;
  isModified?: boolean;
  isActive?: boolean;
  children?: FileNode[];
  parentId?: string | null;
}

export interface ChatSession {
  id: string;
  name: string;
  messages: ChatMessage[];
  isActive: boolean;
  agentId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  agentName?: string;
  isStreaming?: boolean;
  artifacts?: Artifact[];
  // Chat interface directive additions (Section 6)
  thinkingContent?: string;
  thinkingDurationMs?: number;
  isThinking?: boolean;
  codeBlocks?: Array<{ language: string; code: string; filename?: string }>;
  followUps?: Array<{ text: string }>;
}

export interface Artifact {
  id: string;
  type: 'file' | 'image' | 'code' | 'link';
  name: string;
  content?: string;
  language?: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  specialization: string;
  trustScore: number;
  status: 'idle' | 'working' | 'reviewing' | 'debating';
  currentTask?: string;
  icon: string;
  color: string;
}

export interface TerminalSession {
  id: string;
  name: string;
  shell: string;
  history: TerminalLine[];
  isActive: boolean;
}

export interface TerminalLine {
  id: string;
  type: 'input' | 'output' | 'error' | 'system';
  content: string;
  timestamp: string;
}

export type GhostMode = 'observation' | 'approval' | 'auto' | 'autonomous';

export type ThemeName =
  | 'zero-two'
  | 'cyber-neon'
  | 'midnight-blue'
  | 'aurora-purple'
  | 'obsidian'
  | 'hacker-green'
  | 'crimson-night'
  | 'solar-eclipse'
  | 'arctic-dark'
  | 'dracula-evolution';

export interface Theme {
  name: ThemeName;
  label: string;
  colors: {
    siren: string;
    active: string;
    dim: string;
    background: string;
    surface: string;
    raised: string;
    border: string;
    text: string;
    textSecondary: string;
    textMuted: string;
    accent: string;
  };
}

export type SidebarTab = 'explorer' | 'search' | 'git' | 'agents' | 'extensions' | 'settings';

export type BottomPanelTab = 'terminal' | 'problems' | 'output' | 'agent-chat';

// Phase A — Monaco IDE Intelligence: problems surfaced from Monaco's
// TypeScript/JavaScript diagnostics to the Problems tab.
export interface Problem {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface EditorTab {
  fileId: string;
  fileName: string;
  language: string;
  isModified: boolean;
  isActive: boolean;
}

export interface WorksAnalysis {
  projectName: string;
  completionPercent: number;
  errorCount: number;
  activeAgents: number;
  totalFiles: number;
  totalLines: number;
  issues: Issue[];
}

export interface Issue {
  id: string;
  type: 'error' | 'warning' | 'info';
  message: string;
  file: string;
  line: number;
}

export interface Snapshot {
  id: string;
  timestamp: string;
  label: string;
  filesChanged: number;
  agents: string[];
}

// ── Backend types (mirror server/src/types.ts) ───────────────────────────
// Step 0 addendum — these match the server's contracts so the UI can talk to
// the real backend instead of using setTimeout simulations.

export type AgentDomain =
  | 'ARCHITECT' | 'FRONTEND' | 'BACKEND' | 'DATABASE' | 'SECURITY'
  | 'DEVOPS' | 'QA' | 'DOCUMENTATION' | 'PERFORMANCE' | 'TERMINAL'
  | 'MEMORY' | 'DESIGN' | 'EXTENSION' | 'RESEARCH' | 'DEPLOYMENT'
  | 'PROMPT' | 'REVIEW'
  // Personal-Pillar domains (directive Section 3 — agents not yet built)
  | 'FABRICATION' | 'OPERATIVE' | 'SENTINEL';

export type ExecutionMode = 'single-shot' | 'react' | 'codeact';

export type AgentEventName =
  | 'agent:start' | 'agent:chunk' | 'agent:progress' | 'agent:complete'
  | 'agent:error' | 'agent:status'
  | 'meeting:start' | 'meeting:proposal' | 'meeting:decision'
  | 'ghost:detection' | 'ghost:plan' | 'ghost:fix' | 'ghost:rollback'
  | 'editor:open' | 'editor:typing' | 'editor:save' | 'editor:cursor'
  | 'collab:cursor' | 'collab:join' | 'collab:leave'
  | 'terminal:input' | 'terminal:output' | 'terminal:suggest' | 'terminal:resize'
  | 'preview:reload' | 'preview:regression'
  | 'fabrication:progress' | 'presence:gesture' | 'presence:faceauth' | 'sentinel:alert';

export interface AgentEvent<P = unknown> {
  event: AgentEventName;
  payload: P;
  ts: number;
  id: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface AgentListItem {
  id: string;
  name: string;
  domain: AgentDomain;
  icon: string;
  color: string;
  trustScore: number;
  status: 'IDLE' | 'RUNNING' | 'REVIEWING' | 'ERROR' | 'PAUSED';
}

export interface SendTaskResponse {
  taskId: string;
  agentId: string;
  status: 'accepted';
  stream: string;
}

// ── Agent Relay + Orchestrator types (directive Section 4) ───────────────

export interface Milestone {
  id: string;
  title: string;
  description: string;
  assignedAgent: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
}

export interface OrchestratorPlan {
  projectName: string;
  summary: string;
  techStack: string[];
  milestones: Milestone[];
}

export type PlanStatus =
  | 'draft' | 'approved' | 'running' | 'paused'
  | 'awaiting-user' | 'completed' | 'failed' | 'stopped';

export interface OrchestratorSettings {
  engine: 'gemini-flash' | 'nvidia-nemotron';
  approvalMode: 'auto' | 'default';
  tier1Model: string;
}

// Phase E Build 2: Voice provider settings — mirrors server-side VoiceSettings
// in server/src/orchestrator/voice-settings.ts. Extensible for Chatterbox/ElevenLabs.
export type VoiceProviderId = 'zai' | 'kokoro';

export interface VoiceSettings {
  provider: VoiceProviderId;
  kokoroVoice?: string;
  kokoroLangCode?: string;
}

export interface VoiceProviderOption {
  id: VoiceProviderId;
  label: string;
  desc?: string;
  available: boolean;
  reason?: string;
}

export interface KokoroVoiceOption {
  name: string;
  langCode: string;
  langLabel: string;
  gender: 'female' | 'male';
  grade?: string;
}

export type MilestoneLogStatus = 'running' | 'approved' | 'rejected' | 'corrected' | 'failed';

export interface OrchestratorDecision {
  approved: boolean;
  summary: string;
  issues: string[];
  corrections: string;
}

export interface MilestoneLog {
  id: string;
  planId: string;
  milestoneId: string;
  agentId: string;
  attempt: number;
  status: MilestoneLogStatus;
  agentResult: { summary: string; filesTouched?: string[] } | null;
  filesReviewed: string[];
  orchestratorDecision: OrchestratorDecision | null;
  startedAt: number;
  completedAt: number | null;
}

export interface OrchestratorPlanStatus {
  id: string;
  sessionId: string;
  projectId: string | null;
  engine: 'gemini-flash' | 'nvidia-nemotron';
  approvalMode: 'auto' | 'default';
  status: PlanStatus;
  plan: OrchestratorPlan;
  currentMilestoneId: string | null;
  createdAt: number;
  updatedAt: number;
  milestoneLogs?: MilestoneLog[];
}

export interface OrchestratorPlanSummary {
  id: string;
  sessionId: string;
  projectName: string;
  summary: string;
  status: PlanStatus;
  engine: 'gemini-flash' | 'nvidia-nemotron';
  approvalMode: 'auto' | 'default';
  currentMilestoneId: string | null;
  milestoneCount: number;
  createdAt: number;
  updatedAt: number;
}
