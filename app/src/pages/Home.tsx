import { useEffect, useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '@/store/AppContext';
import { applyTheme } from '@/store/themes';
import { TitleBar } from '@/components/layout/TitleBar';
import { FileExplorer } from '@/components/layout/FileExplorer';
import { StatusBar } from '@/components/layout/StatusBar';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { Dock } from '@/components/dock/Dock';
import { Sparkles, PictureInPicture2 } from 'lucide-react';
import { useGestureInput, dispatchGesture, type GestureType } from '@/systems/presence/gesture';
import type { AgentEvent } from '@/types';
import { wsClient } from '@/lib/ws';
import { getToken } from '@/lib/auth';

// Phase B — lazy-load the AvatarOverlay (heavy: Three.js + VRM)
const AvatarOverlay = lazy(() => import('@/components/avatar/AvatarOverlay').then(m => ({ default: m.AvatarOverlay })));

// Phase 5 — lazy-load heavy, conditionally-rendered components.
// These components pull in large vendor libs (xterm, motion/react, monaco)
// that aren't needed on initial page load.
const CodeEditor = lazy(() => import('@/components/editor/CodeEditor').then((m) => ({ default: m.CodeEditor })));
const ChatPanel = lazy(() => import('@/components/chat/ChatPanel').then((m) => ({ default: m.ChatPanel })));
const Terminal = lazy(() => import('@/components/terminal/Terminal').then((m) => ({ default: m.Terminal })));
const InlineAI = lazy(() => import('@/components/panels/InlineAI').then((m) => ({ default: m.InlineAI })));
const AgentPanel = lazy(() => import('@/components/modals/AgentPanel').then((m) => ({ default: m.AgentPanel })));
const SettingsModal = lazy(() => import('@/components/modals/SettingsModal').then((m) => ({ default: m.SettingsModal })));
const PlanReviewPanel = lazy(() => import('@/components/modals/PlanReviewPanel').then((m) => ({ default: m.PlanReviewPanel })));
// Approval-gate fix: real approval dialog. NOT lazy-loaded — it must be
// available immediately when a ghost:plan event arrives, even on a fresh
// page load. It's small (no vendor deps) so the bundle impact is minimal.
import { ApprovalDialog } from '@/components/modals/ApprovalDialog';
// Relay banner — directive Section 2.3. Shows when orchestrator pauses
// between milestones (default-approval mode). NOT lazy-loaded: it needs to
// be available the moment a relay:awaiting-user event arrives.
import { RelayBanner } from '@/components/panels/RelayBanner';
import { useRelay } from '@/store/RelayContext';

export default function Home() {
  const { state, toggleInlineAI, toggleAgentPanel, toggleSettings, dispatch } = useApp();
  const navigate = useNavigate();
  const relay = useRelay();
  const [sidebarExpanded, setSidebarExpanded] = useState(false);

  // Phase B: PIP avatar overlay state
  const [pipEnabled, setPipEnabled] = useState(false);
  const [pipPosition, setPipPosition] = useState({ x: 100, y: 100 });
  const [pipAvatarUrl, setPipAvatarUrl] = useState('/models/sample.vrm');

  useEffect(() => {
    applyTheme(state.currentTheme);
  }, [state.currentTheme]);

  // Phase B: Fetch avatar settings on boot (for PIP overlay)
  useEffect(() => {
    if (!state.authReady) return;
    const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';
    const token = getToken() ?? '';
    fetch(`${API_BASE}/avatar/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (data.settings) {
          setPipEnabled(data.settings.pipEnabled ?? false);
          setPipPosition(data.settings.pipPosition ?? { x: 100, y: 100 });
          const id = data.settings.selectedAvatarId ?? 'default';
          setPipAvatarUrl(`/models/avatars/${id}/model.vrm`);
        }
      })
      .catch(() => {});
  }, [state.authReady]);

  // Phase B: Toggle PIP overlay
  const togglePip = async () => {
    const newEnabled = !pipEnabled;
    setPipEnabled(newEnabled);
    const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';
    const token = getToken() ?? '';
    try {
      await fetch(`${API_BASE}/avatar/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pipEnabled: newEnabled }),
      });
    } catch { /* persistence failure — UI state still updates locally */ }
  };

  // Phase B: Save PIP position on drag end (not every frame)
  const handlePipDragEnd = async (pos: { x: number; y: number }) => {
    setPipPosition(pos);
    const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';
    const token = getToken() ?? '';
    try {
      await fetch(`${API_BASE}/avatar/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pipPosition: pos }),
      });
    } catch { /* persistence failure — position still updates locally */ }
  };

  // Keyboard shortcuts — registered on window (Layer-1 input modality)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey) {
        switch (e.key.toLowerCase()) {
          case 'a':
            e.preventDefault();
            break;
          case 't':
            e.preventDefault();
            break;
          case 'g':
            e.preventDefault();
            break;
          case 'm':
            e.preventDefault();
            toggleAgentPanel();
            break;
          case 'b':
            e.preventDefault();
            break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleAgentPanel]);

  // ── Step 10: Gesture input — registered on window ALONGSIDE keyboard/mouse ──
  useGestureInput((gestureType, action) => {
    console.log(`[gesture] ${gestureType} → ${action}`);
    if (action === 'click') {
      dispatch({ type: 'TOGGLE_AGENT_PANEL' });
    }
  });

  // Listen for presence:gesture WS events and dispatch them as window events
  useEffect(() => {
    const offGesture = wsClient.on('presence:gesture', (evt: AgentEvent) => {
      dispatchGesture({
        type: (evt.payload as { gesture: string }).gesture as GestureType,
        target: (evt.payload as { target: string }).target as string,
        timestamp: evt.ts,
      });
    });
    return () => offGesture();
  }, []);

  // ── Dock navigation handler ──────────────────────────────────────────
  // Resolves to a single "most-foreground" view id so the matching Dock item
  // lights up. Priority (highest first):
  //   settings → agents → chat → terminal → editor (default)
  // brain/face/dashboard are route-based; they don't show on Home so they're
  // not part of this derivation.
  const deriveActiveView = (): string => {
    if (state.settingsVisible) return 'settings';
    if (state.agentPanelVisible) return 'agents';
    if (state.chatPanelVisible) return 'chat';
    if (state.bottomPanelVisible) return 'terminal';
    return 'editor';
  };

  const handleDockNavigate = (target: string) => {
    switch (target) {
      case 'chat':
        // Show chat panel. If hidden, toggle it on. If already visible, do
        // nothing (don't toggle off — that would leave no center panel).
        if (!state.chatPanelVisible) dispatch({ type: 'TOGGLE_CHAT_PANEL' });
        break;
      case 'editor':
        // Hide chat panel so editor is fully visible, ensure explorer is open.
        if (state.chatPanelVisible) dispatch({ type: 'TOGGLE_CHAT_PANEL' });
        if (!state.explorerVisible) dispatch({ type: 'TOGGLE_EXPLORER' });
        break;
      case 'terminal':
        dispatch({ type: 'TOGGLE_BOTTOM_PANEL' });
        break;
      case 'agents':
        toggleAgentPanel();
        break;
      case 'brain':
        navigate('/brain');
        break;
      case 'face':
        navigate('/face');
        break;
      case 'dashboard':
        navigate('/dashboard');
        break;
      case 'settings':
        toggleSettings();
        break;
    }
  };

  // ── Sidebar handlers ─────────────────────────────────────────────────
  const handleSelectChat = (chatId: string) => {
    dispatch({ type: 'SET_ACTIVE_CHAT', payload: chatId });
    if (!state.chatPanelVisible) dispatch({ type: 'TOGGLE_CHAT_PANEL' });
    setSidebarExpanded(false);
  };

  const handleNewChat = () => {
    // Create a new chat session
    const newChatId = `cs-${Date.now()}`;
    dispatch({ type: 'SET_ACTIVE_CHAT', payload: newChatId });
    if (!state.chatPanelVisible) dispatch({ type: 'TOGGLE_CHAT_PANEL' });
    setSidebarExpanded(false);
  };

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--void-black)' }}
    >
      {/* Title Bar */}
      <TitleBar />

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Expandable Sidebar (replaces old IconSidebar) */}
        <Sidebar
          expanded={sidebarExpanded}
          onToggle={() => setSidebarExpanded(!sidebarExpanded)}
          onNavigate={handleDockNavigate}
          onOpenSettings={toggleSettings}
          onNewChat={handleNewChat}
          onSelectChat={handleSelectChat}
        />

        {/* File Explorer */}
        {state.explorerVisible && <FileExplorer />}

        {/* Center Area: Editor + Terminal */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Editor + Chat Panel — both lazy-loaded (monaco + motion/react) */}
          <div className="flex-1 flex overflow-hidden">
            <Suspense fallback={null}>
              <CodeEditor />
            </Suspense>
            {state.chatPanelVisible && (
              <Suspense fallback={null}>
                <ChatPanel />
              </Suspense>
            )}
          </div>

          {/* Bottom Panel — lazy-loaded (xterm is heavy) */}
          {state.bottomPanelVisible && (
            <Suspense fallback={null}>
              <Terminal />
            </Suspense>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* Dock — floating glass pill at bottom center (Section 5) */}
      <Dock onNavigate={handleDockNavigate} activeView={deriveActiveView()} />

      {/* Phase B: PIP toggle button — bottom-left, next to the Dock */}
      <button
        data-testid="pip-toggle"
        onClick={togglePip}
        className="fixed bottom-4 left-4 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110 z-40"
        style={{
          backgroundColor: pipEnabled ? 'rgba(238, 28, 28, 0.2)' : 'rgba(14, 14, 20, 0.8)',
          border: `1px solid ${pipEnabled ? 'rgba(238, 28, 28, 0.4)' : 'var(--border-subtle)'}`,
          backdropFilter: 'blur(8px)',
          color: pipEnabled ? 'var(--siren-red)' : 'var(--steel-silver)',
        }}
        title={pipEnabled ? 'Hide avatar overlay' : 'Show avatar overlay'}
      >
        <PictureInPicture2 className="w-4 h-4" />
      </button>

      {/* Phase B: Avatar PIP overlay — draggable, position-persisted */}
      {pipEnabled && (
        <Suspense fallback={null}>
          <AvatarOverlay
            avatarUrl={pipAvatarUrl}
            position={pipPosition}
            onClose={togglePip}
            onDragEnd={handlePipDragEnd}
          />
        </Suspense>
      )}

      {/* Floating Action Button for Inline AI */}
      <button
        className="fixed bottom-12 right-4 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110 z-40 animate-glow-pulse"
        style={{
          backgroundColor: 'var(--siren-red)',
          color: 'white',
          boxShadow: '0 4px 16px rgba(238, 28, 28, 0.4)',
        }}
        onClick={toggleInlineAI}
        title="Toggle Inline AI (Ariadne)"
      >
        <Sparkles className="w-5 h-5" />
      </button>

      {/* Inline AI Panel — lazy-loaded (motion/react) */}
      <Suspense fallback={null}>
        <InlineAI />
      </Suspense>

      {/* Agent Panel Modal — lazy-loaded (motion/react) */}
      <Suspense fallback={null}>
        <AgentPanel />
      </Suspense>

      {/* Settings Modal — lazy-loaded (motion/react) */}
      <Suspense fallback={null}>
        <SettingsModal />
      </Suspense>

      {/* Approval-gate fix: real approval dialog. Always mounted so it can
          receive ghost:plan WS events immediately. Renders null when no
          approvals are pending. */}
      <ApprovalDialog />

      {/* Agent Relay — Plan Review panel (directive Section 2.2). Opens when
          the user clicks "Start Project" in the chat input or when a
          relay:plan-ready event fires. Renders null when reviewPlanId is null. */}
      <Suspense fallback={null}>
        <PlanReviewPanel
          open={relay.reviewPlanId !== null}
          planId={relay.reviewPlanId}
          onClose={relay.closePlanReview}
        />
      </Suspense>

      {/* Agent Relay — persistent awaiting-user banner (directive Section 2.3).
          Shows when the orchestrator pauses between milestones in
          default-approval mode. Renders null when no plan is awaiting. */}
      <RelayBanner />
    </div>
  );
}
