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
  // ── Phase C Agent 3 (Database Agent) — additive inter-agent hand-off field ──
  // Generic input field for passing typed data from a prior agent's output
  // to this agent's task. Used by the caller-supplies-confirmed-schema pattern:
  //   1. Caller dispatches Database Agent via executeAndWait() → collects result
  //   2. Caller constructs Backend Agent task with inputData: databaseAgentResult
  //   3. Backend Agent reads task.inputData to get the confirmed schema
  //
  // No multi-agent dispatch exists in AgentManager today — the CALLER mediates
  // sequencing. This field is the typed hand-off channel. Agents that don't
  // read it work unchanged (it's optional).
  inputData?: Record<string, unknown>;
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
  // Phase A Section 1b: dependency-vulnerability findings carry the package
  // metadata needed by planFix() to build a real remediation plan + by
  // applyFix() to run `npm audit fix` targeting the right project dir.
  // Optional — only set for `type: 'dependency-vulnerability'` findings.
  packageName?: string;
  currentVersion?: string;
  recommendedFix?: string;  // semver range from npm audit advisory, e.g. ">=1.2.8"
}

export interface GhostPlan {
  findingId: string;
  steps: string[];
  preview: string;
  // Phase A Section 1b: tells applyFix() what remediation path to run.
  //   'npm-audit-fix' — run `npm audit fix` (no --force) + verify with re-audit
  //   'suggest-only'  — no-op: the "fix" is the human having seen the suggestion
  // Undefined for plans built before Section 1b (backwards compat with the
  // approval-gate flow used by Terminal/Operative/Fabrication agents, which
  // don't go through applyFix() — they wait for the FSM transition only).
  fixAction?: 'npm-audit-fix' | 'suggest-only';
  // For 'npm-audit-fix': the cwd to run the command in (server/ dir).
  // For 'suggest-only': undefined.
  fixCwd?: string;
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
  | 'anthropic'      // direct Anthropic (Phase A Section 6)
  | 'groq'           // Groq — fastest inference via LPU hardware (Phase A Section 6)
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

// ── Phase C Agent 3 (DatabaseAgent) — schema/migration types ────────────
//
// Database Agent owns schema changes ONLY. It never writes route/handler
// code (that's Backend Agent's job). These types define the confirmed-
// schema output that gets passed to Backend Agent via task.inputData.

export interface ColumnSpec {
  name: string;
  dataType: string;          // e.g. 'uuid', 'text', 'timestamp', 'integer'
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
}

export interface TableSpec {
  name: string;
  columns: ColumnSpec[];
}

export interface MigrationResult {
  filename: string;          // e.g. '011_add_user_avatar.sql'
  sql: string;               // the full SQL content
  tables: TableSpec[];       // parsed table/column specs from the SQL
  applied: boolean;          // whether the migration was executed
  // Standardized error code when applied=false. 'postgres-unavailable' is
  // the degraded-mode signal (Postgres not connected). Other strings are
  // human-readable details (validation failures, Ghost Mode rejection, etc.).
  // Callers checking for degraded mode should test `error === 'postgres-unavailable'`
  // OR `error?.startsWith('postgres-unavailable')` for forward-compat.
  error?: string;
}

export interface SchemaIntrospectionResult {
  tables: TableSpec[];
  available: boolean;        // false when Postgres unavailable (degraded mode)
  skipped?: string;          // human-readable reason when available=false
  // Standardized error code — 'postgres-unavailable' when degraded mode.
  // Callers checking for degraded mode should test this field, not `skipped`.
  error?: 'postgres-unavailable';
}

/**
 * The confirmed-schema output that Backend Agent's caller passes via
 * task.inputData. This is what Backend Agent reads to know what
 * tables/columns are live.
 *
 * Per directive Section 4: distinct from SchemaIntrospectionResult —
 * confirmSchema() returns THIS shape (for ONE table), while
 * introspectSchema() returns SchemaIntrospectionResult (for ALL tables,
 * used for diagnostic/monitoring purposes). Backend Agent consumes
 * confirmSchema() output; introspectSchema() is for admin/dashboards.
 */
export interface SchemaConfirmation {
  // null when postgres-unavailable (we couldn't check), NOT the same as
  // false (table doesn't exist). Backend Agent should refuse to proceed
  // when tableExists is null — it means the confirmation is incomplete.
  tableExists: boolean | null;
  columns: { name: string; dataType: string }[];
  migrationApplied: boolean;
  migrationFile: string | null;
  confirmedAt: number;       // epoch ms — when this confirmation was generated
  // Degraded-mode flag — when set, tableExists is null and columns is empty.
  error?: 'postgres-unavailable';
}

export interface DatabaseAgentResult {
  migration?: MigrationResult;
  schemaIntrospection?: SchemaIntrospectionResult;
  reviewTier: 'full-scan' | 'partial-scan' | 'stub-fallback';
  skipped: string[];
  // The confirmed schema to pass to Backend Agent via task.inputData.
  // Backend Agent reads this to know what tables/columns are live.
  confirmedSchema?: {
    tables: TableSpec[];
    migrationFile: string;
    applied: boolean;
  };
}

// ── Phase C Agent 4 (BackendAgent) — route generation result ────────────
//
// Backend Agent generates Express route files + registers them in index.ts.
// Both writes go through writeProjectFile() → CodeReviewAgent gate.
// This result tracks whether each write succeeded — partial failure is
// reported honestly, never silently reported as success.

export interface BackendRouteResult {
  routeFileWritten: boolean;
  registered: boolean;         // whether index.ts registration succeeded
  routeFilePath: string | null;
  routeContent: string | null;  // the generated route file content
  error?: string;               // present if any write failed
  // Refusal reasons (pre-write sanity checks that blocked generation)
  refused?: string;
  // Which columns the generated code references (for DB-backed routes)
  referencedColumns?: string[];
}

// ── Phase C Agent 5 (DevOpsAgent) — operational health types ────────────

export interface BuildResult {
  success: boolean;
  output: string;        // stdout + stderr combined
  durationMs: number;
}

export interface VerifyBuildResult {
  app: BuildResult;
  server: BuildResult;
  overallSuccess: boolean;
}

export interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  type: 'minor' | 'major' | 'patch';  // kind of update available
}

export interface DependencyHealthResult {
  server: OutdatedPackage[];
  app: OutdatedPackage[];
  totalOutdated: number;
  majorUpdatesAvailable: number;
}

export interface PreflightResult {
  passed: boolean;
  warnings: string[];
  failures: string[];
  rawOutput: string;
  exitCode: number;
}

export interface FullHealthCheckResult {
  build: VerifyBuildResult;
  dependencies: DependencyHealthResult;
  preflight: PreflightResult;
  tests: { passed: boolean; output: string; durationMs: number };
  grepAudit: { passed: boolean; output: string };
  overallHealth: 'healthy' | 'degraded' | 'unhealthy';
  checkedAt: number;      // epoch ms
}

// ── Phase C Agent 6 (PerformanceAgent) — static analysis types ──────────

export interface PerformanceAntiPatternFinding {
  file: string;
  line: number;
  pattern: string;            // e.g. 'execSync-in-route-handler', 'unbounded-select'
  severity: 'warning' | 'info';
  suggestion: string;         // actionable fix recommendation
}

export interface BundleSizes {
  app: number;                 // bytes, or 0 if not built
  server: number;              // bytes, or 0 if not built
  unit: 'bytes';
}

export interface PerformanceReviewResult {
  antiPatternFindings: PerformanceAntiPatternFinding[];
  bundleSizes: BundleSizes | null;   // null if dist/ doesn't exist
  overallAssessment: 'healthy' | 'attention-needed' | 'unknown';
  skipped: string[];
}

// ── Phase C Agent 7 (DocumentationAgent) — doc generation types ─────────

export interface CommentDocResult {
  file: string;
  updatedContent: string | null;   // null if refused or no changes needed
  written: boolean;
  refused?: string;                // reason if generation was refused
  commentAdded: boolean;
}

export interface ReadmeSectionResult {
  file: string;
  sectionName: string;
  updatedContent: string | null;   // null if refused
  written: boolean;
  preservedOutsideMarkers: boolean; // byte-for-byte preservation proof
  refused?: string;
}

export interface ApiDocEntry {
  method: string;             // GET, POST, PUT, DELETE, PATCH
  path: string;               // e.g. '/:agentId/send'
  mountPath: string;          // e.g. '/api/agents'
  fullPath: string;           // mountPath + path
  requiresAuth: boolean;
  schemaFields: { name: string; type: string; required: boolean; description?: string }[];
  description: string;        // from file-level comment or route-level comment
}

export interface ApiDocResult {
  file: string;
  routerVarName: string;
  mountPath: string | null;   // null if can't determine from index.ts
  routes: ApiDocEntry[];
  refused?: string;
}

// ── Phase C Agent 8 (ResearchAgent) — web search types ──────────────────

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  hostName: string;
  rank: number;
}

export interface PageContent {
  title: string;
  url: string;
  content: string;       // stripped text content
  tokensUsed: number;
}

export interface ResearchResult {
  query: string;
  mode: 'web-search' | 'no-search-available';
  searchResults: SearchResult[];
  fetchedPages: PageContent[];
  synthesis: string | null;     // LLM synthesis with source citations. null if mode != 'web-search'
  sources: { url: string; title: string }[];  // every source cited in synthesis
  reason?: string;              // present when mode === 'no-search-available'
}

// ── Phase C Agent 9 (UIDesignerAgent) — UI review types ─────────────────

export interface UITokenFinding {
  hardcodedColor: string;     // the hex value found, e.g. '#FF0000'
  line: number;
  suggestion: string;         // e.g. 'Use var(--siren-red) instead' or 'No matching token — add a new one'
}

export interface UIAccessibilityFinding {
  issue: string;
  line: number;
  severity: 'warning';
}

export interface UIConventionFinding {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface UIReviewResult {
  tokenFindings: UITokenFinding[];
  accessibilityFindings: UIAccessibilityFinding[];
  conventionFindings: UIConventionFinding[];
  overallCompliance: 'compliant' | 'minor-issues' | 'needs-attention';
  outOfScopeNote: string;
}

export interface UIGenerateResult {
  filePath: string;
  content: string | null;
  written: boolean;
  refused?: string;
}

// ── Phase C Agent 10 (PromptEngineerAgent) — prompt analysis types ──────

export interface PromptFinding {
  agentId: string;
  promptName: string;          // 'SYSTEM_PROMPT' or 'MIGRATION_GEN_PROMPT' etc.
  findingType: 'length' | 'missing-role' | 'missing-output-format' | 'missing-constraints' | 'missing-examples' | 'conflicting-instructions';
  severity: 'warning' | 'info';
  detail: string;
  line: number;
}

export interface PromptAnalysisResult {
  agentId: string;
  prompts: {
    promptName: string;
    content: string;
    tokenEstimate: number;
    findings: PromptFinding[];
  }[];
  totalFindings: number;
}

export interface EmpiricalTestResult {
  agentId: string;
  reviewTier: 'security-rejected' | 'stub-fallback' | 'llm-reviewed' | 'llm-error' | 'not-applicable';
  inconclusive: boolean;       // true when stub engine is active
  reason: string;
}

export interface PromptProposal {
  agentId: string;
  promptName: string;
  proposedPrompt: string;
  changes: { what: string; why: string; findingType: PromptFinding['findingType'] }[];
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
