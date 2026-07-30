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

interface AppState {
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

type AppAction =
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
  | { type: 'ADD_CHAT_MESSAGE'; payload: { sessionId: string; message: ChatMessage } }
  | { type: 'SET_GHOST_MODE'; payload: GhostMode }
  | { type: 'SET_THEME'; payload: ThemeName }
  | { type: 'SET_MODEL'; payload: string }
  | { type: 'SET_AI_GENERATING'; payload: boolean }
  | { type: 'TOGGLE_INLINE_AI' }
  | { type: 'SET_INLINE_AI_POSITION'; payload: { x: number; y: number } }
  | { type: 'TOGGLE_AGENT_PANEL' }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'SET_ACTIVE_TERMINAL'; payload: string }
  | { type: 'ADD_TERMINAL_LINE'; payload: { sessionId: string; line: TerminalSession['history'][0] } }
  | { type: 'LOGIN'; payload: { token: string; user: AuthUser } }
  | { type: 'LOGOUT' }
  | { type: 'AUTH_READY' }
  | { type: 'UPDATE_CHAT_MESSAGE'; payload: { sessionId: string; messageId: string; patch: Partial<ChatMessage> } }
  | { type: 'UPDATE_PROBLEMS'; payload: Problem[] };

const initialState: AppState = {
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
  activeChatId: 'cs1',

  agents: sampleAgents,

  terminalSessions: sampleTerminalSessions,
  activeTerminalId: 't1',

  ghostMode: 'approval',
  currentTheme: defaultTheme,
  currentModel: 'Ollama 3',
  isAIGenerating: false,

  inlineAIVisible: false,
  inlineAIPosition: { x: 400, y: 200 },

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

function appReducer(state: AppState, action: AppAction): AppState {
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
  const openFile = useCallback((id: string) => dispatch({ type: 'OPEN_FILE', payload: id }), []);
  const closeTab = useCallback((id: string) => dispatch({ type: 'CLOSE_TAB', payload: id }), []);
  const setActiveFile = useCallback((id: string) => dispatch({ type: 'SET_ACTIVE_FILE', payload: id }), []);
  const setActiveChat = useCallback((id: string) => dispatch({ type: 'SET_ACTIVE_CHAT', payload: id }), []);
  const addChatMessage = useCallback((sessionId: string, message: ChatMessage) =>
    dispatch({ type: 'ADD_CHAT_MESSAGE', payload: { sessionId, message } }), []);
  const setGhostMode = useCallback((mode: GhostMode) => dispatch({ type: 'SET_GHOST_MODE', payload: mode }), []);
  const setTheme = useCallback((theme: ThemeName) => dispatch({ type: 'SET_THEME', payload: theme }), []);
  const setModel = useCallback((model: string) => dispatch({ type: 'SET_MODEL', payload: model }), []);
  const setAIGenerating = useCallback((generating: boolean) => dispatch({ type: 'SET_AI_GENERATING', payload: generating }), []);
  const toggleInlineAI = useCallback(() => dispatch({ type: 'TOGGLE_INLINE_AI' }), []);
  const setInlineAIPosition = useCallback((pos: { x: number; y: number }) =>
    dispatch({ type: 'SET_INLINE_AI_POSITION', payload: pos }), []);
  const toggleAgentPanel = useCallback(() => dispatch({ type: 'TOGGLE_AGENT_PANEL' }), []);
  const toggleSettings = useCallback(() => dispatch({ type: 'TOGGLE_SETTINGS' }), []);
  const setActiveTerminal = useCallback((id: string) => dispatch({ type: 'SET_ACTIVE_TERMINAL', payload: id }), []);
  const addTerminalLine = useCallback((sessionId: string, line: TerminalSession['history'][0]) =>
    dispatch({ type: 'ADD_TERMINAL_LINE', payload: { sessionId, line } }), []);
  const updateChatMessage = useCallback((sessionId: string, messageId: string, patch: Partial<ChatMessage>) =>
    dispatch({ type: 'UPDATE_CHAT_MESSAGE', payload: { sessionId, messageId, patch } }), []);
  // Phase A — Monaco IDE Intelligence: replace the problems array.
  // Called by CodeEditor's onDidChangeMarkers listener.
  const updateProblems = useCallback((problems: Problem[]) =>
    dispatch({ type: 'UPDATE_PROBLEMS', payload: problems }), []);

  const login = useCallback((token: string, user: AuthUser) => {
    setAuth(token, user);
    dispatch({ type: 'LOGIN', payload: { token, user } });
    wsClient.connect();
  }, []);

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
      wsClient.connect();
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        addChatMessage,
        updateChatMessage,
        updateProblems,
        setGhostMode,
        setTheme,
        setModel,
        setAIGenerating,
        toggleInlineAI,
        setInlineAIPosition,
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
