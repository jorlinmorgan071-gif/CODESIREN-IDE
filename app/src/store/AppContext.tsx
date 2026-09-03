/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react';
import type {
  FileNode,
  ChatSession,
  Agent,
  TerminalSession,
  GhostMode,
  ThemeName,
  SidebarTab,
  BottomPanelTab,
  EditorTab,
  ChatMessage,
  AuthUser,
  Problem,
} from '@/types';
import {
  sampleFileTree,
  sampleChatSessions,
  sampleAgents,
  sampleTerminalSessions,
  sampleEditorTabs,
  sampleFileContent,
} from './demoData';
import { defaultTheme, applyTheme } from './themes';
import { api } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { getToken, getUser, setAuth, clearAuth } from '@/lib/auth';

export interface AppState {
  // Navigation
  activeSidebarTab: SidebarTab;
  sidebarVisible: boolean;
  explorerVisible: boolean;
  chatPanelVisible: boolean;
  bottomPanelVisible: boolean;
  activeBottomTab: BottomPanelTab;

  // Content
  fileTree: FileNode[];
  editorTabs: EditorTab[];
  activeFileId: string | null;
  fileContents: Record<string, string>;

  // Chat
  chatSessions: ChatSession[];
  activeChatId: string;

  // Agents
  agents: Agent[];

  // Terminal
  terminalSessions: TerminalSession[];
  activeTerminalId: string;

  // System
  ghostMode: GhostMode;
  currentTheme: ThemeName;
  currentModel: string;
  isAIGenerating: boolean;

  // Inline AI
  inlineAIVisible: boolean;
  inlineAIPosition: { x: number; y: number };
  // Phase B: Editor Actions — the pending request from Monaco's context menu
  inlineAIRequest: { action: string; code: string; language?: string } | null;

  // Modals
  agentPanelVisible: boolean;
  settingsVisible: boolean;

  // Phase A — Monaco IDE Intelligence: live diagnostics from Monaco's
  // TypeScript/JavaScript language service, surfaced to the Problems tab.
  problems: Problem[];

  // Auth (Step 0 — single JWT flow, single user identity)
  authUser: AuthUser | null;
  authToken: string | null;
  authReady: boolean; // false during initial token check / auto-register
}

export type AppAction =
  | { type: 'SET_SIDEBAR_TAB'; payload: SidebarTab }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_EXPLORER' }
  | { type: 'TOGGLE_CHAT_PANEL' }
  | { type: 'TOGGLE_BOTTOM_PANEL' }
  | { type: 'SET_BOTTOM_TAB'; payload: BottomPanelTab }
  | { type: 'TOGGLE_FOLDER'; payload: string }
  | { type: 'OPEN_FILE'; payload: string }
  | { type: 'CLOSE_TAB'; payload: string }
  | { type: 'SET_ACTIVE_FILE'; payload: string }
  | { type: 'SET_ACTIVE_CHAT'; payload: string }
  | { type: 'CREATE_CHAT_SESSION'; payload: { session: ChatSession } }
  | { type: 'ADD_CHAT_MESSAGE'; payload: { sessionId: string; message: ChatMessage } }
  | { type: 'SET_GHOST_MODE'; payload: GhostMode }
  | { type: 'SET_THEME'; payload: ThemeName }
  | { type: 'SET_MODEL'; payload: string }
  | { type: 'SET_AI_GENERATING'; payload: boolean }
  | { type: 'TOGGLE_INLINE_AI' }
  | { type: 'SET_INLINE_AI_POSITION'; payload: { x: number; y: number } }
  | { type: 'SET_INLINE_AI_REQUEST'; payload: { action: string; code: string; language?: string } | null }
  | { type: 'TOGGLE_AGENT_PANEL' }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'SET_ACTIVE_TERMINAL'; payload: string }
  | { type: 'ADD_TERMINAL_LINE'; payload: { sessionId: string; line: TerminalSession['history'][0] } }
  // D10 #1 closeout — replace the hardcoded sampleAgents roster with real
  // server-derived agent status. Dispatched by:
  //   - the new fetchAgents() effect in AppProvider (calls api.listAgents()
  //     after login)
  //   - the new agent:status WS event listener (updates a single agent's
  //     status without refetching the whole list)
  | { type: 'SET_AGENTS'; payload: Agent[] }
  | { type: 'UPDATE_AGENT_STATUS'; payload: { agentId: string; status: Agent['status'] } }
  | { type: 'LOGIN'; payload: { token: string; user: AuthUser } }
  | { type: 'LOGOUT' }
  | { type: 'AUTH_READY' }
  | { type: 'UPDATE_CHAT_MESSAGE'; payload: { sessionId: string; messageId: string; patch: Partial<ChatMessage> } }
  | { type: 'LOAD_WORKSPACE_FILES'; payload: Array<{ path: string; name: string }> }
  | { type: 'SET_WORKSPACE_FILE_CONTENT'; payload: { fileId: string; path: string; content: string } }
  | { type: 'RECONCILE_FILE_CONTENT'; payload: { fileId: string; content: string } }
  | { type: 'UPDATE_PROBLEMS'; payload: Problem[] };

export const initialState: AppState = {
  activeSidebarTab: 'explorer',
  sidebarVisible: true,
  explorerVisible: true,
  chatPanelVisible: true,
  bottomPanelVisible: true,
  activeBottomTab: 'terminal',

  fileTree: sampleFileTree,
  editorTabs: sampleEditorTabs,
  activeFileId: 'f17',
  fileContents: sampleFileContent,

  chatSessions: sampleChatSessions,
  activeChatId: sampleChatSessions[0].id,

  agents: sampleAgents,

  terminalSessions: sampleTerminalSessions,
  // D10 #2 closeout: with sampleTerminalSessions now empty, the activeTerminalId
  // default is null instead of 't1' (which no longer exists). Terminal.tsx
  // handles this gracefully — it shows the honest "Terminal unavailable"
  // banner regardless of whether a session is active.
  activeTerminalId: '',

  ghostMode: 'approval-required',
  currentTheme: defaultTheme,
  currentModel: 'Ollama 3',
  isAIGenerating: false,

  inlineAIVisible: false,
  inlineAIPosition: { x: 400, y: 200 },
  inlineAIRequest: null,

  agentPanelVisible: false,
  settingsVisible: false,

  // Phase A — Monaco IDE Intelligence: live diagnostics from Monaco's
  // TypeScript/JavaScript language service. Empty until the editor mounts
  // and starts emitting marker changes.
  problems: [],

  authUser: getUser(),
  authToken: getToken(),
  authReady: false,
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_SIDEBAR_TAB':
      return { ...state, activeSidebarTab: action.payload };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarVisible: !state.sidebarVisible };
    case 'TOGGLE_EXPLORER':
      return { ...state, explorerVisible: !state.explorerVisible };
    case 'TOGGLE_CHAT_PANEL':
      return { ...state, chatPanelVisible: !state.chatPanelVisible };
    case 'TOGGLE_BOTTOM_PANEL':
      return { ...state, bottomPanelVisible: !state.bottomPanelVisible };
    case 'SET_BOTTOM_TAB':
      return { ...state, activeBottomTab: action.payload };

    case 'TOGGLE_FOLDER': {
      const toggleInTree = (nodes: FileNode[]): FileNode[] =>
        nodes.map((node) => {
          if (node.id === action.payload) {
            return { ...node, isOpen: !node.isOpen };
          }
          if (node.children) {
            return { ...node, children: toggleInTree(node.children) };
          }
          return node;
        });
      return { ...state, fileTree: toggleInTree(state.fileTree) };
    }

    case 'OPEN_FILE': {
      const fileId = action.payload;
      const findFile = (nodes: FileNode[]): FileNode | undefined => {
        for (const node of nodes) {
          if (node.id === fileId) return node;
          if (node.children) {
            const found = findFile(node.children);
            if (found) return found;
          }
        }
        return undefined;
      };
      const file = findFile(state.fileTree);
      if (!file || file.type === 'folder') return state;

      const existingTab = state.editorTabs.find((t) => t.fileId === fileId);
      let newTabs = state.editorTabs;

      if (!existingTab) {
        newTabs = [
          ...state.editorTabs,
          {
            fileId: file.id,
            fileName: file.name,
            workspacePath: file.workspacePath,
            language: file.language || 'plaintext',
            isModified: false,
            isActive: false,
          },
        ];
      }

      newTabs = newTabs.map((t) => ({
        ...t,
        isActive: t.fileId === fileId,
      }));

      return { ...state, editorTabs: newTabs, activeFileId: fileId };
    }

    case 'LOAD_WORKSPACE_FILES': {
      const languageForPath = (path: string) => {
        if (/\.(ts|tsx)$/i.test(path)) return 'typescript';
        if (/\.(js|jsx|mjs|cjs)$/i.test(path)) return 'javascript';
        if (/\.css$/i.test(path)) return 'css';
        if (/\.json$/i.test(path)) return 'json';
        if (/\.md$/i.test(path)) return 'markdown';
        if (/\.html?$/i.test(path)) return 'html';
        return 'plaintext';
      };
      return {
        ...state,
        fileTree: action.payload.map((file) => ({
          id: `workspace:${file.path}`,
          name: file.name,
          workspacePath: file.path,
          type: 'file' as const,
          language: languageForPath(file.path),
        })),
        editorTabs: [],
        activeFileId: null,
        fileContents: {},
      };
    }

    case 'SET_WORKSPACE_FILE_CONTENT': {
      const matchingTab = state.editorTabs.find((tab) => tab.fileId === action.payload.fileId && tab.workspacePath === action.payload.path);
      if (!matchingTab) return state;
      return {
        ...state,
        fileContents: { ...state.fileContents, [action.payload.fileId]: action.payload.content },
      };
    }

    case 'CLOSE_TAB': {
      const newTabs = state.editorTabs.filter((t) => t.fileId !== action.payload);
      if (state.activeFileId === action.payload && newTabs.length > 0) {
        const lastTab = newTabs[newTabs.length - 1];
        return {
          ...state,
          editorTabs: newTabs.map((t, i) => ({
            ...t,
            isActive: i === newTabs.length - 1,
          })),
          activeFileId: lastTab.fileId,
        };
      }
      return { ...state, editorTabs: newTabs, activeFileId: newTabs.length > 0 ? state.activeFileId : null };
    }

    case 'SET_ACTIVE_FILE':
      return {
        ...state,
        activeFileId: action.payload,
        editorTabs: state.editorTabs.map((t) => ({
          ...t,
          isActive: t.fileId === action.payload,
        })),
      };

    case 'SET_ACTIVE_CHAT':
      return {
        ...state,
        activeChatId: action.payload,
        chatSessions: state.chatSessions.map((s) => ({
          ...s,
          isActive: s.id === action.payload,
        })),
      };

    case 'CREATE_CHAT_SESSION':
      return {
        ...state,
        chatSessions: [...state.chatSessions, action.payload.session],
      };

    case 'ADD_CHAT_MESSAGE': {
      const { sessionId, message } = action.payload;
      return {
        ...state,
        chatSessions: state.chatSessions.map((s) =>
          s.id === sessionId
            ? { ...s, messages: [...s.messages, message] }
            : s
        ),
      };
    }

    case 'SET_GHOST_MODE':
      return { ...state, ghostMode: action.payload };

    case 'SET_THEME': {
      applyTheme(action.payload);
      return { ...state, currentTheme: action.payload };
    }

    case 'SET_MODEL':
      return { ...state, currentModel: action.payload };

    case 'SET_AI_GENERATING':
      return { ...state, isAIGenerating: action.payload };

    case 'TOGGLE_INLINE_AI':
      return { ...state, inlineAIVisible: !state.inlineAIVisible };

    case 'SET_INLINE_AI_POSITION':
      return { ...state, inlineAIPosition: action.payload };

    case 'SET_INLINE_AI_REQUEST':
      return { ...state, inlineAIRequest: action.payload, inlineAIVisible: true };

    case 'TOGGLE_AGENT_PANEL':
      return { ...state, agentPanelVisible: !state.agentPanelVisible };

    case 'TOGGLE_SETTINGS':
      return { ...state, settingsVisible: !state.settingsVisible };

    case 'SET_ACTIVE_TERMINAL':
      return {
        ...state,
        activeTerminalId: action.payload,
        terminalSessions: state.terminalSessions.map((s) => ({
          ...s,
          isActive: s.id === action.payload,
        })),
      };

    case 'ADD_TERMINAL_LINE': {
      const { sessionId, line } = action.payload;
      return {
        ...state,
        terminalSessions: state.terminalSessions.map((s) =>
          s.id === sessionId ? { ...s, history: [...s.history, line] } : s
        ),
      };
    }

    // D10 #1 closeout — SET_AGENTS replaces the hardcoded sampleAgents roster
    // with real server-derived agent data. The initial state still uses
    // sampleAgents (so the UI has something to render before login), but
    // after login the fetchAgents() effect dispatches SET_AGENTS with real
    // data from GET /api/agents.
    case 'SET_AGENTS':
      return { ...state, agents: action.payload };

    // D10 #1 closeout — UPDATE_AGENT_STATUS is dispatched by the agent:status
    // WS event listener. Updates a single agent's status in-place without
    // refetching the whole list. Maps the server's 'RUNNING'/'IDLE'/
    // 'REVIEWING'/'ERROR'/'PAUSED' enum to the client's 'working'/'idle'/
    // 'reviewing'/'debating' enum (see mapServerAgentStatus).
    case 'UPDATE_AGENT_STATUS': {
      const { agentId, status } = action.payload;
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === agentId ? { ...a, status } : a
        ),
      };
    }

    case 'LOGIN':
      return { ...state, authUser: action.payload.user, authToken: action.payload.token, authReady: true };

    case 'LOGOUT':
      return { ...state, authUser: null, authToken: null, authReady: true };

    case 'AUTH_READY':
      return { ...state, authReady: true };

    case 'UPDATE_CHAT_MESSAGE': {
      const { sessionId, messageId, patch } = action.payload;
      return {
        ...state,
        chatSessions: state.chatSessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === messageId ? { ...m, ...patch } : m
                ),
              }
            : s
        ),
      };
    }

    case 'RECONCILE_FILE_CONTENT':
      return {
        ...state,
        fileContents: { ...state.fileContents, [action.payload.fileId]: action.payload.content },
        editorTabs: state.editorTabs.map((tab) =>
          tab.fileId === action.payload.fileId ? { ...tab, isModified: false } : tab
        ),
      };

    case 'UPDATE_PROBLEMS':
      // Phase A — Monaco IDE Intelligence. Replace the entire problems
      // array on each marker change (Monaco sends the full marker set,
      // not a delta). Cheap because the array is small (< 100 entries
      // even on a heavily broken file).
      return { ...state, problems: action.payload };

    default:
      return state;
  }
}

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  toggleFolder: (id: string) => void;
  openFile: (id: string) => void;
  closeTab: (id: string) => void;
  setActiveFile: (id: string) => void;
  setActiveChat: (id: string) => void;
  createChatSession: (session: ChatSession) => void;
  addChatMessage: (sessionId: string, message: ChatMessage) => void;
  updateChatMessage: (sessionId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  // Phase A — Monaco IDE Intelligence: live diagnostics.
  updateProblems: (problems: Problem[]) => void;
  setGhostMode: (mode: GhostMode) => void;
  setTheme: (theme: ThemeName) => void;
  setModel: (model: string) => void;
  setAIGenerating: (generating: boolean) => void;
  toggleInlineAI: () => void;
  setInlineAIPosition: (pos: { x: number; y: number }) => void;
  setInlineAIRequest: (req: { action: string; code: string; language?: string } | null) => void;
  toggleAgentPanel: () => void;
  toggleSettings: () => void;
  setActiveTerminal: (id: string) => void;
  addTerminalLine: (sessionId: string, line: TerminalSession['history'][0]) => void;
  // Auth helpers
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  const toggleFolder = useCallback((id: string) => dispatch({ type: 'TOGGLE_FOLDER', payload: id }), []);
  const openFile = useCallback((id: string) => {
    const findFile = (nodes: FileNode[]): FileNode | undefined => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const found = node.children ? findFile(node.children) : undefined;
        if (found) return found;
      }
      return undefined;
    };
    const file = findFile(state.fileTree);
    dispatch({ type: 'OPEN_FILE', payload: id });
    if (!file?.workspacePath || file.type !== 'file') return;
    void api.readWorkspaceFile(file.workspacePath).then((result) => {
      if (result.path !== file.workspacePath) return;
      dispatch({ type: 'SET_WORKSPACE_FILE_CONTENT', payload: { fileId: id, path: result.path, content: result.content } });
    }).catch((error) => console.warn('[workspace] file read failed:', error instanceof Error ? error.message : error));
  }, [state.fileTree]);
  const closeTab = useCallback((id: string) => dispatch({ type: 'CLOSE_TAB', payload: id }), []);
  const setActiveFile = useCallback((id: string) => dispatch({ type: 'SET_ACTIVE_FILE', payload: id }), []);
  const setActiveChat = useCallback((id: string) => dispatch({ type: 'SET_ACTIVE_CHAT', payload: id }), []);
  const createChatSession = useCallback((session: ChatSession) =>
    dispatch({ type: 'CREATE_CHAT_SESSION', payload: { session } }), []);
  const addChatMessage = useCallback((sessionId: string, message: ChatMessage) =>
    dispatch({ type: 'ADD_CHAT_MESSAGE', payload: { sessionId, message } }), []);
  // D10 #3 closeout — setGhostMode now ALSO calls POST /api/ghost-mode/level
  // so the server's FSM actually transitions. Pre-closeout this only
  // dispatched a local reducer action, so the dropdown was cosmetic-only —
  // the server stayed at 'approval-required' (hardcoded at boot from
  // index.ts:82) regardless of what the user picked. Now the server's
  // ghostMode.setLevel() is called via the new /level endpoint, and the
  // local reducer mirrors the server state for immediate UI feedback.
  const setGhostMode = useCallback((mode: GhostMode) => {
    dispatch({ type: 'SET_GHOST_MODE', payload: mode });
    void api.setGhostModeLevel(mode).catch((error) =>
      console.warn('[ghost-mode] setLevel failed:', error instanceof Error ? error.message : error)
    );
  }, []);
  const setTheme = useCallback((theme: ThemeName) => dispatch({ type: 'SET_THEME', payload: theme }), []);
  const setModel = useCallback((model: string) => dispatch({ type: 'SET_MODEL', payload: model }), []);
  const setAIGenerating = useCallback((generating: boolean) => dispatch({ type: 'SET_AI_GENERATING', payload: generating }), []);
  const toggleInlineAI = useCallback(() => dispatch({ type: 'TOGGLE_INLINE_AI' }), []);
  const setInlineAIPosition = useCallback((pos: { x: number; y: number }) =>
    dispatch({ type: 'SET_INLINE_AI_POSITION', payload: pos }), []);
  const setInlineAIRequest = useCallback((req: { action: string; code: string; language?: string } | null) =>
    dispatch({ type: 'SET_INLINE_AI_REQUEST', payload: req }), []);
  const toggleAgentPanel = useCallback(() => dispatch({ type: 'TOGGLE_AGENT_PANEL' }), []);
  const toggleSettings = useCallback(() => dispatch({ type: 'TOGGLE_SETTINGS' }), []);
  const setActiveTerminal = useCallback((id: string) => dispatch({ type: 'SET_ACTIVE_TERMINAL', payload: id }), []);
  const addTerminalLine = useCallback((sessionId: string, line: TerminalSession['history'][0]) =>
    dispatch({ type: 'ADD_TERMINAL_LINE', payload: { sessionId, line } }), []);
  // D10 #1 closeout — fetchAgents() calls GET /api/agents (which already
  // existed but was never called from anywhere in the UI) and dispatches
  // SET_AGENTS with the real server-derived roster. Called once after login.
  // Subsequent status changes are pushed via the agent:status WS event
  // (see the WS listener registered in the same useEffect).
  const fetchAgents = useCallback(() => {
    void api.listAgents()
      .then((response) => {
        // Map server status enum to client status enum.
        // Server: 'IDLE' | 'RUNNING' | 'REVIEWING' | 'ERROR' | 'PAUSED'
        // Client: 'idle' | 'working' | 'reviewing' | 'debating'
        const mapStatus = (serverStatus: string): Agent['status'] => {
          if (serverStatus === 'RUNNING') return 'working';
          if (serverStatus === 'REVIEWING') return 'reviewing';
          if (serverStatus === 'PAUSED' || serverStatus === 'ERROR') return 'debating';
          return 'idle';  // 'IDLE' or unknown
        };
        const agents: Agent[] = response.agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.domain,  // server exposes `domain` as the role-like tag
          specialization: a.domain,  // server doesn't expose specialization — reuse domain
          trustScore: a.trustScore,
          status: mapStatus(a.status),
          currentTask: a.status === 'RUNNING' ? 'Working' : undefined,
          icon: a.icon,
          color: a.color,
        }));
        dispatch({ type: 'SET_AGENTS', payload: agents });
      })
      .catch((error) => console.warn('[agents] listAgents failed:', error instanceof Error ? error.message : error));
  }, []);
  const updateChatMessage = useCallback((sessionId: string, messageId: string, patch: Partial<ChatMessage>) =>
    dispatch({ type: 'UPDATE_CHAT_MESSAGE', payload: { sessionId, messageId, patch } }), []);
  // Phase A — Monaco IDE Intelligence: replace the problems array.
  // Called by CodeEditor's onDidChangeMarkers listener.
  const updateProblems = useCallback((problems: Problem[]) =>
    dispatch({ type: 'UPDATE_PROBLEMS', payload: problems }), []);
  const loadWorkspaceFiles = useCallback(() => {
    void api.listWorkspaceFiles()
      .then((workspace) => dispatch({ type: 'LOAD_WORKSPACE_FILES', payload: workspace.files }))
      .catch((error) => console.warn('[workspace] file inventory failed:', error instanceof Error ? error.message : error));
  }, []);

  const login = useCallback((token: string, user: AuthUser) => {
    setAuth(token, user);
    dispatch({ type: 'LOGIN', payload: { token, user } });
    void api.currentWorkspace()
      .then((workspace) => {
        wsClient.connect(workspace.projectId);
        loadWorkspaceFiles();
        // D10 #1 closeout — fetch real agent roster from /api/agents after
        // login. Replaces the hardcoded sampleAgents with real server data.
        fetchAgents();
      })
      .catch(() => wsClient.connect());
  }, [fetchAgents, loadWorkspaceFiles]);

  const logout = useCallback(() => {
    clearAuth();
    wsClient.disconnect();
    dispatch({ type: 'LOGOUT' });
  }, []);

  // Step 0 auto-login: if no token on mount, register a dev user so the
  // ChatPanel can immediately talk to the real backend. Face auth (Step 10)
  // layers on top of this same token — never a parallel path.
  useEffect(() => {
    if (state.authToken && state.authUser) {
      void api.currentWorkspace()
        .then((workspace) => {
          wsClient.connect(workspace.projectId);
          loadWorkspaceFiles();
          // D10 #1 closeout — fetch real agent roster on mount when already
          // authenticated (covers page refresh).
          fetchAgents();
        })
        .catch(() => wsClient.connect());
      dispatch({ type: 'AUTH_READY' });
      return;
    }
    // Auto-register a dev user. Idempotent — if the email is taken, log in.
    const devEmail = `dev@code-siren.local`;
    const devPassword = `dev-password-step-0`;
    const devName = `Step 0 Developer`;
    api.register(devEmail, devPassword, devName)
      .then((res) => login(res.token, res.user))
      .catch((err) => {
        if (String(err).includes('already registered') || String(err).includes('409')) {
          return api.login(devEmail, devPassword).then((res) => login(res.token, res.user));
        }
        console.warn('[auth] auto-register failed:', err.message);
        dispatch({ type: 'AUTH_READY' });
      })
      .catch((err) => {
        console.warn('[auth] auto-login failed:', err.message);
        dispatch({ type: 'AUTH_READY' });
      });
  }, [fetchAgents, loadWorkspaceFiles, login, state.authToken, state.authUser]);

  // D10 #1 closeout — subscribe to agent:status WS events. The server
  // broadcasts these on every agent state transition (RUNNING → IDLE etc.).
  // The handler maps the server's status enum to the client's enum and
  // dispatches UPDATE_AGENT_STATUS so the StatusBar/AgentPanel/Terminal
  // agent-chat tab reflect the real server-side state in real time, instead
  // of the hardcoded sampleAgents "working"/"reviewing" values.
  useEffect(() => {
    const unsubscribe = wsClient.on('agent:status', (event) => {
      const payload = event.payload as { agentId: string; status: string };
      if (!payload?.agentId || !payload?.status) return;
      const mapStatus = (serverStatus: string): Agent['status'] => {
        if (serverStatus === 'RUNNING') return 'working';
        if (serverStatus === 'REVIEWING') return 'reviewing';
        if (serverStatus === 'PAUSED' || serverStatus === 'ERROR') return 'debating';
        return 'idle';
      };
      dispatch({
        type: 'UPDATE_AGENT_STATUS',
        payload: { agentId: payload.agentId, status: mapStatus(payload.status) },
      });
    });
    return unsubscribe;
  }, []);

  // D10 #3 closeout — sync the ghost mode level from the server on mount.
  // The server may have been started with a different default level (or
  // another client may have changed it), so we fetch the real current level
  // and dispatch SET_GHOST_MODE to align the local reducer with the server.
  // Without this, the StatusBar dropdown would show the client's default
  // ('approval-required') even if the server was actually running at
  // 'observation-only' or 'autonomous'.
  useEffect(() => {
    if (!state.authToken) return;
    void api.getGhostModeLevel()
      .then((response) => {
        if (response?.level) {
          dispatch({ type: 'SET_GHOST_MODE', payload: response.level as GhostMode });
        }
      })
      .catch((error) =>
        console.warn('[ghost-mode] getLevel failed:', error instanceof Error ? error.message : error)
      );
  }, [state.authToken]);

  return (
    <AppContext.Provider
      value={{
        state,
        dispatch,
        toggleFolder,
        openFile,
        closeTab,
        setActiveFile,
        setActiveChat,
        createChatSession,
        addChatMessage,
        updateChatMessage,
        updateProblems,
        setGhostMode,
        setTheme,
        setModel,
        setAIGenerating,
        toggleInlineAI,
        setInlineAIPosition,
        setInlineAIRequest,
        toggleAgentPanel,
        toggleSettings,
        setActiveTerminal,
        addTerminalLine,
        login,
        logout,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
