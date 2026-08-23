import { useEffect, useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '@/store/AppContext';
import { applyTheme } from '@/store/themes';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { TitleBar } from '@/components/layout/TitleBar';
import { FileExplorer } from '@/components/layout/FileExplorer';
import { StatusBar } from '@/components/layout/StatusBar';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { Dock } from '@/components/dock/Dock';
import { Sparkles, PictureInPicture2, Mic, Monitor } from 'lucide-react';
import { useGestureInput, dispatchGesture, type GestureType } from '@/systems/presence/gesture';
import type { AgentEvent, ChatSession } from '@/types';
import { wsClient } from '@/lib/ws';
import { getToken } from '@/lib/auth';
import { createChatSessionId } from '@/lib/chat-session';
import { SensoryFeedbackOverlay } from '@/components/voice/SensoryFeedbackOverlay';
import { ScreenIntelligence } from '@/components/voice/ScreenIntelligence';
import { BubbleToggle } from '@/components/voice/BubbleToggle';

// Phase B — lazy-load heavy voice components (Three.js + VRM + wlipsync)
const InteractionBubble = lazy(() => import('@/components/voice/InteractionBubble').then(m => ({ default: m.InteractionBubble })));

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
  const { state, toggleInlineAI, toggleAgentPanel, toggleSettings, dispatch, createChatSession } = useApp();
  const navigate = useNavigate();
  const relay = useRelay();
  const { isActive: voiceActive, toggleVoiceSession } = useVoiceSession();
  const [sidebarExpanded, setSidebarExpanded] = useState(false);

  // Phase B: Screen Intelligence — screen share state
  const [screenSharing, setScreenSharing] = useState(false);
  const [visionAnalyzing, setVisionAnalyzing] = useState(false);
  const [visionPrompt] = useState('Explain what is on screen. If there is an error message, explain what it means and how to fix it.');

  // Phase B: Interaction bubble visibility
  const [bubbleVisible, setBubbleVisible] = useState(false);

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
          // Custom avatars are served by the API server (not vite)
          const isCustom = id.startsWith('custom-');
          const apiOrigin = API_BASE.replace(/\/api$/, '');
          const url = isCustom
            ? `${apiOrigin}/models/avatars/custom/${id}/model.vrm`
            : `/models/avatars/${id}/model.vrm`;
          setPipAvatarUrl(url);
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

  // Phase B: Screen Intelligence — capture screen frame + analyze via vision endpoint
  const captureAndAnalyze = async (imageDataUri: string, prompt?: string) => {
    setVisionAnalyzing(true);
    try {
      const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';
      const token = getToken() ?? '';
      const res = await fetch(`${API_BASE}/orchestrator/vision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ image: imageDataUri, prompt: prompt ?? visionPrompt }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Vision request failed' })) as { error: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { analysis: string };
      // Display the result in the InlineAI panel via custom event
      window.dispatchEvent(new CustomEvent('code-siren:vision-result', {
        detail: { analysis: data.analysis },
      }));
      // Open the InlineAI panel
      if (!state.inlineAIVisible) toggleInlineAI();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      window.dispatchEvent(new CustomEvent('code-siren:vision-result', {
        detail: { analysis: `Vision analysis failed: ${msg}` },
      }));
      if (!state.inlineAIVisible) toggleInlineAI();
    } finally {
      setVisionAnalyzing(false);
    }
  };

  const handleScreenShare = async () => {
    if (screenSharing) return;
    try {
      setScreenSharing(true);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 }, // low frame rate — we only need one frame
        audio: false,
      });

      // Capture a single frame
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      // Wait one frame for the video to render
      await new Promise(r => requestAnimationFrame(() => r(null)));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0);
      const dataUri = canvas.toDataURL('image/png');

      // Stop the stream immediately — we only needed one frame
      stream.getTracks().forEach(t => t.stop());
      setScreenSharing(false);

      // Send to vision endpoint
      await captureAndAnalyze(dataUri);
    } catch (err: unknown) {
      setScreenSharing(false);
      // User cancelled the picker — don't show an error
      if (err instanceof DOMException && err.name === 'NotAllowedError') return;
      console.error('[screen-share] failed:', err);
    }
  };

  // Phase B: Screen Intelligence — drag-and-drop image handler
  useEffect(() => {
    const handleDrop = async (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file.type.startsWith('image/')) return;

      e.preventDefault();
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUri = reader.result as string;
        await captureAndAnalyze(dataUri, 'Explain what is in this image. If there is an error message, explain what it means and how to fix it.');
      };
      reader.readAsDataURL(file);
    };

    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }
    };

    window.addEventListener('drop', handleDrop);
    window.addEventListener('dragover', handleDragOver);
    return () => {
      window.removeEventListener('drop', handleDrop);
      window.removeEventListener('dragover', handleDragOver);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visionPrompt]);

  // Phase B: Screen Intelligence — paste image handler
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          e.preventDefault();
          const reader = new FileReader();
          reader.onload = async () => {
            const dataUri = reader.result as string;
            await captureAndAnalyze(dataUri, 'Explain what is in this image. If there is an error message, explain what it means and how to fix it.');
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visionPrompt]);

  // Phase B: Listen for bubble settings open requests (click on bubble body)
  useEffect(() => {
    const handler = () => {
      if (!state.settingsVisible) toggleSettings();
      // Also dispatch to SettingsModal to auto-switch to bubble tab
      window.dispatchEvent(new CustomEvent('code-siren:switch-settings-tab', { detail: 'bubble' }));
    };
    window.addEventListener('code-siren:open-bubble-settings', handler);
    return () => window.removeEventListener('code-siren:open-bubble-settings', handler);
  }, [state.settingsVisible, toggleSettings]);

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
    // Create a new chat session — the session entry must exist in state
    // BEFORE it's made active, otherwise ADD_CHAT_MESSAGE / UPDATE_CHAT_MESSAGE
    // silently no-op (keyed to a sessionId that has no matching session).
    const newChatId = createChatSessionId();
    const newSession: ChatSession = {
      id: newChatId,
      name: 'New Chat',
      messages: [],
      isActive: false,
    };
    createChatSession(newSession);
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

      {/* Phase B: Global voice-active indicator — visible on Home route when
          the voice session is active (started via F6 hotkey or FaceView button).
          Shows a pulsing red mic badge so the user always knows the mic is live. */}
      {voiceActive && (
        <div
          className="fixed top-12 right-4 z-50 flex items-center gap-2 px-3 py-1.5 rounded-full animate-pulse"
          style={{
            backgroundColor: 'rgba(238, 28, 28, 0.2)',
            border: '1px solid rgba(238, 28, 28, 0.5)',
            backdropFilter: 'blur(8px)',
          }}
          title="Voice session active — press F6 to end"
        >
          <Mic className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>
            Listening
          </span>
          <button
            onClick={() => void toggleVoiceSession()}
            className="ml-1 text-[10px] underline"
            style={{ color: 'var(--steel-silver)' }}
          >
            End (F6)
          </button>
        </div>
      )}

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

      {/* Phase B: Screen Intelligence — screen share button */}
      <button
        data-testid="screen-share-btn"
        onClick={handleScreenShare}
        disabled={visionAnalyzing}
        className="fixed bottom-4 left-16 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110 z-40"
        style={{
          backgroundColor: screenSharing || visionAnalyzing ? 'rgba(238, 28, 28, 0.2)' : 'rgba(14, 14, 20, 0.8)',
          border: `1px solid ${screenSharing || visionAnalyzing ? 'rgba(238, 28, 28, 0.4)' : 'var(--border-subtle)'}`,
          backdropFilter: 'blur(8px)',
          color: screenSharing || visionAnalyzing ? 'var(--siren-red)' : 'var(--steel-silver)',
        }}
        title={visionAnalyzing ? 'Analyzing screen...' : 'Share screen for AI analysis'}
      >
        {visionAnalyzing ? (
          <span className="text-[10px] animate-pulse">...</span>
        ) : (
          <Monitor className="w-4 h-4" />
        )}
      </button>

      {/* Phase B: Screen Intelligence — sharing active indicator */}
      {(screenSharing || visionAnalyzing) && (
        <div
          className="fixed top-12 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-1.5 rounded-full animate-pulse"
          style={{
            backgroundColor: 'rgba(238, 28, 28, 0.2)',
            border: '1px solid rgba(238, 28, 28, 0.5)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <Monitor className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>
            {visionAnalyzing ? 'Analyzing screen...' : 'Screen sharing active'}
          </span>
        </div>
      )}

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

      {/* Phase B: Sensory feedback overlay — glow + cursor shimmer + waveform + chime */}
      <SensoryFeedbackOverlay />

      {/* Phase B: Interaction bubble — lightweight toggle + lazy-loaded heavy bubble */}
      {!bubbleVisible && (
        <BubbleToggle onClick={() => setBubbleVisible(true)} />
      )}
      {bubbleVisible && (
        <Suspense fallback={null}>
          <InteractionBubble onClose={() => setBubbleVisible(false)} />
        </Suspense>
      )}

      {/* Phase B: Screen Intelligence — screen share + drag-and-drop image analysis */}
      <ScreenIntelligence />
    </div>
  );
}
