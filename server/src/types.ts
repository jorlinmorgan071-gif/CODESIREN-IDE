// server/src/types.ts
// Code Siren core types — PDF Section 05 + directive Section 4 (executionMode addendum).
// Every absorbed agent (Fabrication, Operative, Sentinel) and every Engineering-Pillar
// agent will use these exact types. No agent is exempt.

// ── Agent identity ────────────────────────────────────────────────────────

export type AgentDomain =
  | 'ARCHITECT'
  | 'FRONTEND'
  | 'BACKEND'
  | 'DATABASE'
  | 'SECURITY'
  | 'DEVOPS'
  | 'QA'
  | 'DOCUMENTATION'
  | 'PERFORMANCE'
  | 'TERMINAL'
  | 'MEMORY'
  | 'DESIGN'
  | 'EXTENSION'
  | 'RESEARCH'
  | 'DEPLOYMENT'
  | 'PROMPT'
  | 'REVIEW'
  // Personal-Pillar domains (added per directive Section 3 — agents not yet built)
  | 'FABRICATION'
  | 'OPERATIVE'
  | 'SENTINEL';

export type AgentStatus = 'IDLE' | 'RUNNING' | 'REVIEWING' | 'ERROR' | 'PAUSED';

export type ExecutionMode = 'single-shot' | 'react' | 'codeact';
// Per directive Section 1: ReAct and CodeAct are VALUES of executionMode, not agents.
// They are ported from the donor project's native_react / native_openhands / simple agents
// into server/orchestration/strategies/{react,codeact,single-shot}.ts (Step 2).

export type TaskType =
  | 'chat'
  | 'code-gen'
  | 'code-review'
  | 'plan'
  | 'research'
  | 'test'
  | 'deploy'
  | 'fabricate-cad'
  | 'fabricate-print'
  | 'slice'
  | 'discover'
  | 'browse'
  | 'device-command'
  | 'monitor'
  | 'recall'
  | 'custom';

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

// ── AgentTask (PDF Section 05 + directive Section 4) ──────────────────────

export interface AgentTask {
  id: string;                    // uuid
  projectId: string;             // FK to projects.id
  sessionId: string;             // FK to sessions.id
  agentId: string;               // e.g. 'architect-agent'
  type: TaskType;
  description: string;
  context: ProjectContext;
  files?: string[];
  priority: TaskPriority;
  timeout?: number;              // ms
  executionMode: ExecutionMode;  // directive Section 4 — single-shot | react | codeact
  // Origin transport — a spoken command and a typed command resolve to the SAME
  // AgentTask shape and travel through the SAME AgentManager.send() call.
  // 'voice' is added here ahead of Step 8 to make the contract explicit.
  origin: 'chat' | 'voice' | 'gesture' | 'api';
  createdAt: number;
  // ── Phase B (Context Manager) — additive optional field ────────────────
  // Assembled by AgentManager.send()/executeAndWait() before the task is
  // dispatched to the target agent. Purely additive — no existing agent is
  // REQUIRED to read this field; callers that don't set it work unchanged.
  //
  // Per directive Section 4: if Context Manager throws or times out (2s),
  // the task is dispatched with contextBundle === undefined (fail-open —
  // see the explicit comment in agent-manager.ts for the rationale).
  contextBundle?: import('./context/types.js').ContextBundle;
}

export interface ProjectContext {
  projectId: string;
  rootPath: string;
  techStack: Record<string, unknown>;
  activeFiles: string[];
  codeDna?: CodeDna;
  recentMessages?: string[];
  // Approval-gate fix: the user who requested this task. Side-effect-capable
  // agents (Terminal, Operative, Fabrication) read this to tag their
  // ghostMode.findings with userId, so the approval endpoint can verify
  // the user who approves is the user who requested.
  userId?: string;
}

export interface CodeDna {
  namingStyle: Record<string, unknown>;
  indentStyle: 'spaces' | 'tabs';
  indentSize: number;
  commentRatio: number;
  preferredPatterns: string[];
  preferredLibs: string[];
}

// ── AgentChunk (PDF Section 05) ───────────────────────────────────────────

export type AgentChunkType =
  | 'text'
  | 'code'
  | 'file'
  | 'command'
  | 'done'
  | 'error'
  | 'progress';

export interface AgentChunk {
  type: AgentChunkType;
  content: string;
  meta?: Record<string, unknown>;
}

// ── Agent events (PDF Section 13) ─────────────────────────────────────────

export type AgentEventName =
  | 'agent:start'
  | 'agent:chunk'
  | 'agent:progress'
  | 'agent:complete'
  | 'agent:error'
  | 'agent:status'
  | 'meeting:start'
  | 'meeting:proposal'
  | 'meeting:decision'
  // Ghost Mode events
  | 'ghost:detection'
  | 'ghost:plan'
  | 'ghost:fix'
  | 'ghost:rollback'
  // Editor events
  | 'editor:open'
  | 'editor:typing'
  | 'editor:save'
  | 'editor:cursor'
  // Collab events
  | 'collab:cursor'
  | 'collab:join'
  | 'collab:leave'
  // Terminal events
  | 'terminal:input'
  | 'terminal:output'
  | 'terminal:suggest'
  | 'terminal:resize'
  // Preview events
  | 'preview:reload'
  | 'preview:regression'
  // Personal-Pillar events (directive Section 6 — added ahead of agent build)
  | 'fabrication:progress'
  | 'presence:gesture'
  | 'presence:faceauth'
  | 'sentinel:alert'
  // Brain Visualizer events (memory engine)
  | 'memory:created'
  | 'memory:deleted'
  | 'memory:searched'
  // Face Avatar + Live Voice Pipeline events
  | 'voice:transcript'
  | 'voice:agent-start'
  | 'voice:agent-chunk'
  | 'voice:agent-response'
  | 'voice:error'
  | 'voice:session-ended'
  | 'voice:auto-disconnect'
  // Agent Relay + Mother AI Orchestrator events (directive Section 1.6)
  | 'relay:plan-ready'
  | 'relay:milestone-start'
  | 'relay:milestone-complete'
  | 'relay:milestone-rejected'
  | 'relay:awaiting-user'
  | 'relay:plan-complete'
  | 'relay:error'
  // Tier 1 free-chat stream events (directive Section 1.2)
  | 'orchestrator:chunk'
  | 'orchestrator:complete'
  | 'orchestrator:error';

export interface AgentEvent<P = unknown> {
  event: AgentEventName;
  payload: P;
  ts: number;                    // epoch ms — required per PDF Section 20
  id: string;                    // uuid — required per PDF Section 20
}

// ── Ghost Mode (PDF Section 16) ───────────────────────────────────────────

export type GhostState =
  | 'inactive'
  | 'scanning'
  | 'detected'
  | 'planning'
  | 'awaiting_approval'
  | 'applying'
  | 'verifying'
  | 'complete'
  | 'rolled_back';

export type GhostModeLevel =
  | 'observation-only'
  | 'approval-required'
  | 'auto-amend'
  | 'autonomous';

export interface GhostFinding {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  filePath?: string;
  line?: number;
  description: string;
  // Approval-gate fix: the user whose session created this finding. The
  // approval endpoint verifies req.user.id matches this field before
  // transitioning state. Optional for backwards compat with existing callers
  // (Sentinel Agent's ambient scans don't have a user); the approval
  // endpoint rejects findings without a userId (fail closed).
  userId?: string;
  // The agent that reported this finding, so the UI can show context.
  agentId?: string;
  // The task that triggered this finding, so the waiting agent can be
  // notified when the approval decision arrives.
  taskId?: string;
}

export interface GhostPlan {
  findingId: string;
  steps: string[];
  preview: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
}

export interface JwtClaims {
  sub: string;        // user id
  email: string;
  name: string;
  plan: AuthUser['plan'];
  iat?: number;
  exp?: number;
}

// ── Model Router (stub for Step 0) ────────────────────────────────────────

export type EngineId =
  | 'stub'           // Step 0 — streams synthetic output, no API key needed
  | 'openrouter'     // OpenRouter gateway (Claude, GPT-4o, Gemini, DeepSeek, etc.)
  | 'openai'         // direct OpenAI
  | 'anthropic'      // direct Anthropic
  | 'ollama'         // local — directive's offline→Ollama branch
  | 'vllm'           // local
  | 'sglang'         // local
  | 'llamacpp';      // local

export interface ModelRouterRequest {
  agentId: string;
  domain: AgentDomain;
  messages: RouterMessage[];
  temperature?: number;
  maxTokens?: number;
  executionMode: ExecutionMode;
}

export interface RouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ModelRouterChunk {
  delta: string;
  done: boolean;
}

// ── Agent result ──────────────────────────────────────────────────────────

export interface ReviewResult {
  approved: boolean;
  score: number;            // 0–100
  notes: string;
  issues: string[];
  // ── Phase C (CodeReviewAgent hardening) — additive optional field ──────
  // Distinguishes which tier produced this review result:
  //   'security-rejected' — Tier 1 regex caught a security issue (score 0, auto-reject)
  //   'llm-reviewed'      — Tier 2 LLM produced structured output (SCORE:/APPROVED: or <review>JSON</review>)
  //   'llm-error'         — Tier 2 LLM call threw an error (fail-closed reject)
  //   'stub-fallback'     — Tier 2 LLM produced unstructured output, no security issues → approved at score 75
  // Undefined for backwards compat (callers that don't read this field still work).
  reviewTier?: 'security-rejected' | 'stub-fallback' | 'llm-reviewed' | 'llm-error';
}

// ── Phase C Agent 2 (SecurityAgent) — SecurityReviewResult ───────────────
//
// Distinct from ReviewResult — SecurityAgent is NOT a per-write gate (unlike
// CodeReviewAgent). It performs a holistic scan across 3 surfaces:
//   1. Dependency vulnerabilities (npm audit --json)
//   2. Auth/session logic (LLM holistic review)
//   3. API/network exposure (static route-file pass)
//
// The shape reflects the directive's Section 4 spec exactly.

export interface DependencyFinding {
  package: string;
  currentVersion: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  advisory: string;          // advisory title + URL
  recommendedFix: string;    // e.g. "upgrade to >=1.20.6"
}

export interface AuthFinding {
  file: string;
  issue: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
}

export interface ExposureFinding {
  route: string;
  issue: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
}

export interface SecurityReviewResult {
  dependencyFindings: DependencyFinding[];
  authFindings: AuthFinding[];
  exposureFindings: ExposureFinding[];
  overallRisk: 'critical' | 'high' | 'moderate' | 'low' | 'none';
  reviewTier: 'full-scan' | 'partial-scan' | 'stub-fallback';
  skipped: string[];         // honest reporting of anything that couldn't run
}

export interface MemoryChunk {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface MemoryMeta {
  sourceType: 'agent' | 'user' | 'file' | 'doc';
  sourceRef?: string;
  tags?: string[];
}

// ── AgentManager message bus (PDF Section 14) ─────────────────────────────

export interface AgentMessage {
  id: string;
  from: string;             // agentId or 'user' or 'system'
  to: string[];             // agentId[] or ['broadcast']
  type: string;             // e.g. 'task:execute', 'task:review', 'broadcast:status'
  payload: Record<string, unknown>;
  ts: number;
}
