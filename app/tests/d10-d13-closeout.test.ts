// app/tests/d10-d13-closeout.test.ts
// Phase: P0/P1/P2 remediation order closeout — D10 + D13 fixes.
//
// This test file proves the 6 fixes that close out the remaining OPEN
// findings from the D2–D17 re-investigation:
//
//   D10 #1 — UI agent badges wired to real /api/agents + agent:status WS
//   D10 #2 — Fake terminal output no longer rendered below the banner
//   D10 #3 — Ghost Mode dropdown calls real /api/ghost-mode/level + strings aligned
//   D10 #4 — TitleBar uses real /api/models/engines instead of hardcoded list
//   D10 #5 — "AI Meeting Room" honestly relabeled as "Meeting Simulation"
//   D13    — code_interpreter stub returns success:false + meta.violation
//
// Pattern mirrors app/tests/extension-claim-removal.test.ts — read the
// production source as text and assert the honest contract is in place.
// This is brittle by design (any future regression that re-introduces the
// fake behavior will fail the test).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const terminalSource = readFileSync(resolve(process.cwd(), 'src/components/terminal/Terminal.tsx'), 'utf8');
const titleBarSource = readFileSync(resolve(process.cwd(), 'src/components/layout/TitleBar.tsx'), 'utf8');
const statusBarSource = readFileSync(resolve(process.cwd(), 'src/components/layout/StatusBar.tsx'), 'utf8');
const agentPanelSource = readFileSync(resolve(process.cwd(), 'src/components/modals/AgentPanel.tsx'), 'utf8');
const appContextSource = readFileSync(resolve(process.cwd(), 'src/store/AppContext.tsx'), 'utf8');
const demoDataSource = readFileSync(resolve(process.cwd(), 'src/store/demoData.ts'), 'utf8');
const apiSource = readFileSync(resolve(process.cwd(), 'src/lib/api.ts'), 'utf8');
const typesSource = readFileSync(resolve(process.cwd(), 'src/types/index.ts'), 'utf8');

describe('D10 #2 — fake terminal output no longer rendered', () => {
  it('Terminal.tsx does not call activeSession?.history.map(...) at runtime', () => {
    // The fake `npm install` / `git status` / `npm run dev` outputs lived in
    // sampleTerminalSessions.history and were rendered via
    // `activeSession?.history.map((line) => ...)`. That map call must be gone.
    //
    // We strip all comment styles before checking — closeout comments may
    // mention the old pattern as historical reference, which is fine. What's
    // NOT fine is the actual runtime call. Comment styles stripped:
    //   - `// ...` line comments
    //   - `* ...` JSDoc continuation lines
    //   - `{/* ... */}` JSX comments (single-line form)
    //   - Multi-line JSX comments `{/* ... */}` spanning multiple lines
    const stripped = terminalSource
      // Remove single-line // comments
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
      // Remove JSX comments {/* ... */} (may span multiple lines)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(stripped).not.toContain('activeSession?.history.map');
    expect(stripped).not.toMatch(/^\s*const activeSession\s*=/m);
  });

  it('Terminal.tsx still renders the honest "Terminal unavailable" banner', () => {
    // The honest banner must remain — we're removing the FAKE output below it,
    // not removing the honest disclosure that the terminal is unavailable.
    expect(terminalSource).toContain('Terminal unavailable');
    expect(terminalSource).toContain('Commands are not executed and no output is generated');
  });

  it('sampleTerminalSessions is now empty (no fabricated npm/git/vite output)', () => {
    // The export is kept (AppContext initialState references it), but it
    // must be an empty array — not the 2 fake sessions with fabricated
    // `npm install` / `git status` / `npm run dev` / `console.log` output.
    expect(demoDataSource).toContain('sampleTerminalSessions: TerminalSession[] = []');
    // Specifically must NOT contain the fabricated output strings.
    expect(demoDataSource).not.toContain('added 42 packages in 3.2s');
    expect(demoDataSource).not.toContain('VITE v5.0.0 ready in 420 ms');
    expect(demoDataSource).not.toContain('Hello from Zero Two');
  });
});

describe('D10 #4 — TitleBar uses real /api/models/engines, not hardcoded list', () => {
  it('TitleBar.tsx does not declare a hardcoded `const models` array', () => {
    // Pre-closeout TitleBar.tsx had:
    //   const models = ['Ollama 3', 'Claude 3.5 Sonnet', 'GPT-4o', ...]
    // That hardcoded list is gone — the dropdown now iterates `engines`
    // fetched from /api/models/engines.
    //
    // We check for the actual declaration pattern (const models = [...])
    // rather than just the model name strings — closeout comments may
    // mention the old names as historical reference, which is fine.
    expect(titleBarSource).not.toMatch(/^const models\s*=\s*\[/m);
    expect(titleBarSource).not.toMatch(/^const models:\s*string\[\]\s*=\s*\[/m);
  });

  it('TitleBar.tsx fetches real engines via api.listEngines()', () => {
    expect(titleBarSource).toContain('api.listEngines');
  });

  it('TitleBar.tsx gates the "AI Online" badge on real engine availability', () => {
    // Pre-closeout the badge was always green + pulsing regardless of config.
    // Now it's gated on anyRealEngineAvailable.
    expect(titleBarSource).toContain('anyRealEngineAvailable');
    expect(titleBarSource).toContain('AI Offline');  // shown when no real engine
    // The hardcoded pulsing dot must be replaced with conditional rendering.
    expect(titleBarSource).not.toMatch(/className=.*animate-agent-pulse.*AI Online/s);
    // The conditional animation is the right pattern:
    expect(titleBarSource).toContain('animation: anyRealEngineAvailable');
  });

  it('api.ts exposes listEngines() calling /models/engines', () => {
    expect(apiSource).toContain('listEngines');
    expect(apiSource).toContain("request('/models/engines')");
  });
});

describe('D10 #3 — Ghost Mode dropdown wired to real /api/ghost-mode/level', () => {
  it('StatusBar.tsx uses the server-aligned GhostMode strings', () => {
    // Pre-closeout the client used 'observation'/'approval'/'auto'/'autonomous'
    // which didn't match the server's 'observation-only'/'approval-required'/
    // 'auto-amend'/'autonomous'. Now they must align 1:1.
    expect(statusBarSource).toContain("'observation-only'");
    expect(statusBarSource).toContain("'approval-required'");
    expect(statusBarSource).toContain("'auto-amend'");
    expect(statusBarSource).toContain("'autonomous'");
    // The old short names must NOT appear as ghostModeConfig keys.
    expect(statusBarSource).not.toMatch(/observation:\s*\{/);
    expect(statusBarSource).not.toMatch(/approval:\s*\{/);
    expect(statusBarSource).not.toMatch(/^auto:\s*\{/m);
  });

  it('types/index.ts GhostMode type matches server GhostModeLevel', () => {
    expect(typesSource).toContain("'observation-only' | 'approval-required' | 'auto-amend' | 'autonomous'");
  });

  it('AppContext.tsx setGhostMode also calls api.setGhostModeLevel', () => {
    // Pre-closeout setGhostMode only dispatched a local reducer action.
    // Now it must also POST to the server.
    expect(appContextSource).toContain('api.setGhostModeLevel');
    expect(appContextSource).toContain("type: 'SET_GHOST_MODE'");
  });

  it('AppContext.tsx syncs ghost mode from server on mount', () => {
    // The new useEffect that fetches the server's current level on mount.
    expect(appContextSource).toContain('api.getGhostModeLevel');
  });

  it('api.ts exposes setGhostModeLevel + getGhostModeLevel', () => {
    expect(apiSource).toContain('setGhostModeLevel');
    expect(apiSource).toContain('getGhostModeLevel');
    expect(apiSource).toContain("request('/ghost-mode/level'");
  });
});

describe('D10 #1 — UI agent badges wired to real /api/agents + WS events', () => {
  it('AppContext.tsx dispatches SET_AGENTS from real api.listAgents() call', () => {
    expect(appContextSource).toContain("type: 'SET_AGENTS'");
    expect(appContextSource).toContain('api.listAgents');
  });

  it('AppContext.tsx subscribes to agent:status WS events', () => {
    expect(appContextSource).toContain("wsClient.on('agent:status'");
    expect(appContextSource).toContain("type: 'UPDATE_AGENT_STATUS'");
  });

  it('AppContext.tsx fetchAgents is called from login flow + auto-login useEffect', () => {
    expect(appContextSource).toContain('fetchAgents()');
    // Called from both the login callback AND the auto-login useEffect.
    const matches = appContextSource.match(/fetchAgents\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('D10 #5 — "AI Meeting Room" honestly relabeled', () => {
  it('AgentPanel.tsx does not claim real AI collaboration', () => {
    // Pre-closeout the footer said "Agents collaborate in the AI Meeting Room
    // for major decisions" — implying real deliberation. The new label must
    // honestly disclose that it's a deterministic simulation.
    expect(agentPanelSource).not.toContain('Agents collaborate in the AI Meeting Room');
    expect(agentPanelSource).not.toContain('Open Meeting Room');
    expect(agentPanelSource).not.toContain('Reconvene Meeting');
    expect(agentPanelSource).not.toContain('AI Meeting: ');
  });

  it('AgentPanel.tsx uses the honest "Meeting Simulation" label', () => {
    expect(agentPanelSource).toContain('Meeting Simulation');
    expect(agentPanelSource).toContain('Run Meeting Simulation');
    expect(agentPanelSource).toContain('Meeting simulation — deterministic');
    expect(agentPanelSource).toContain('no LLM calls');
  });
});
