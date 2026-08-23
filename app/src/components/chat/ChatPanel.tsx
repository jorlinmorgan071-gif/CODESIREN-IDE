// app/src/components/chat/ChatPanel.tsx
// Section 1+2+6 — Main chat panel. Wires ChatBubble + ChatInput to the existing
// backend (WS streaming, agent:chunk events, api.sendToAgent).
// Replaces the old ChatPanel entirely. Uses the new components from the directive.
// All colors theme-token driven. No Next.js imports.

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  MessageSquare, ChevronDown, Image as ImageIcon,
} from 'lucide-react';
import { useApp } from '@/store/AppContext';
import { useRelay } from '@/store/RelayContext';
import { wsClient } from '@/lib/ws';
import { api } from '@/lib/api';
import type { AgentEvent } from '@/types';
import { ChatBubble, type ChatMessage, type BubbleStyle } from './elements/ChatBubble';
import { ChatInput } from './elements/ChatInput';
import { getActiveEditorContent, getActiveEditorSelection } from '@/components/editor/CodeEditor';
import { RotatingLoader } from '@/components/ui/loaders';
import { NotificationContainer, type NotificationItem } from '@/components/ui/notification-alert';
import { ChatBackgroundSettings, type ChatBackground } from './ChatBackgroundSettings';

// ── Helper: generate message ID ──────────────────────────────────────────

function genId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── ChatPanel component ──────────────────────────────────────────────────

export function ChatPanel() {
  const { state, addChatMessage, updateChatMessage } = useApp();
  const relay = useRelay();
  const [bubbleStyle, setBubbleStyle] = useState<BubbleStyle>('A');
  const [isGenerating, setIsGenerating] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [showStyleToggle, setShowStyleToggle] = useState(false);
  // Custom chat background (separate from Brain directive)
  const [chatBackground, setChatBackground] = useState<ChatBackground>({ type: 'none', url: '', opacity: 0.3, blur: 0 });
  const [showBackgroundSettings, setShowBackgroundSettings] = useState(false);
  // Start Project loading state — directive Section 2.1.
  // True while the orchestrator is reading the chat history + producing
  // a plan. The "Start Project" button shows a spinner during this time.
  const [startProjectLoading, setStartProjectLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const activeChat = state.chatSessions.find(c => c.id === state.activeChatId);
  const messages = useMemo(() => activeChat?.messages ?? [], [activeChat?.messages]);
  const requestStartTime = useRef<number>(0);

  // ── Auto-scroll to bottom on new messages ─────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Dismiss notification ──────────────────────────────────────────────
  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  // ── Add notification (only for the 3 trigger conditions per Section 8) ─
  const addNotification = useCallback((severity: NotificationItem['severity'], title: string, description?: string) => {
    const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setNotifications(prev => [...prev, { id, severity, title, description, duration: 5000 }]);
    // Auto-dismiss after 5s
    setTimeout(() => dismissNotification(id), 5000);
  }, [dismissNotification]);

  // ── WS event listener for agent responses ─────────────────────────────
  // Listens to BOTH agent:* (existing agent-relay flow) AND orchestrator:*
  // (Tier 1 free-chat per directive Section 1.2). The orchestrator:* events
  // have the same payload shape as agent:* so the rendering code is shared.
  useEffect(() => {
    const offStart = wsClient.on('agent:start', () => {
      setIsGenerating(true);
      requestStartTime.current = Date.now();
    });

    const handleChunk = (evt: AgentEvent) => {
      const payload = evt.payload as { taskId: string; type: string; content: string; meta?: Record<string, unknown> };
      if (payload.type === 'text' && payload.content) {
        // Find the streaming assistant message for this task and append content
        const sessionId = state.activeChatId;
        if (sessionId) {
          // Find the last assistant message that's still streaming
          const chat = state.chatSessions.find(c => c.id === sessionId);
          const lastAssistant = chat?.messages.find(m => m.isStreaming && m.role === 'assistant');
          if (lastAssistant) {
            updateChatMessage(sessionId, lastAssistant.id, {
              content: lastAssistant.content + payload.content,
            });
          }
        }
      }
    };

    const offChunk = wsClient.on('agent:chunk', handleChunk);
    const offOrchChunk = wsClient.on('orchestrator:chunk' as never, handleChunk);

    const handleComplete = () => {
      setIsGenerating(false);
      const sessionId = state.activeChatId;
      if (sessionId) {
        const chat = state.chatSessions.find(c => c.id === sessionId);
        const lastAssistant = chat?.messages.find(m => m.isStreaming && m.role === 'assistant');
        if (lastAssistant) {
          updateChatMessage(sessionId, lastAssistant.id, { isStreaming: false });
        }
      }

      // Notification: fire ONLY on long-running response finishing (Section 8)
      const elapsed = Date.now() - requestStartTime.current;
      if (elapsed > 10_000) {
        addNotification('success', 'Response complete', `Completed in ${(elapsed / 1000).toFixed(1)}s`);
      }
    };

    const offComplete = wsClient.on('agent:complete', handleComplete);
    const offOrchComplete = wsClient.on('orchestrator:complete' as never, handleComplete);

    const handleError = (evt: AgentEvent) => {
      setIsGenerating(false);
      const payload = evt.payload as { error: string };
      const sessionId = state.activeChatId;
      if (sessionId) {
        const chat = state.chatSessions.find(c => c.id === sessionId);
        const lastAssistant = chat?.messages.find(m => m.isStreaming && m.role === 'assistant');
        if (lastAssistant) {
          updateChatMessage(sessionId, lastAssistant.id, {
            content: payload.error,
            isStreaming: false,
            isThinking: false,
          });
        }
      }
      addNotification('error', 'Agent error', payload.error);
    };

    const offError = wsClient.on('agent:error', handleError);
    const offOrchError = wsClient.on('orchestrator:error' as never, handleError);

    return () => {
      offStart(); offChunk(); offOrchChunk();
      offComplete(); offOrchComplete();
      offError(); offOrchError();
    };
  }, [state.activeChatId, state.chatSessions, updateChatMessage, addNotification]);

  // ── Send message ──────────────────────────────────────────────────────
  const handleSend = useCallback(async (text: string, _attachments: unknown[], _model: { provider: string; model: string }) => {
    void _attachments; void _model;
    const sessionId = state.activeChatId;

    // Add user message
    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    if (sessionId) {
      addChatMessage(sessionId, userMsg);
    }

    // Add placeholder assistant message (streaming)
    const assistantMsg: ChatMessage = {
      id: genId(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      agentName: 'Code Siren',
      isStreaming: true,
      isThinking: true,
      thinkingContent: 'Analyzing your request…',
    };
    if (sessionId) {
      addChatMessage(sessionId, assistantMsg);
    }

    // Normal chat selects only server-owned capabilities. General and read
    // requests retain the AgentManager stream; write/fix intent returns a
    // review-only plan and never executes a file change or test here.
    try {
      if (sessionId) {
        // Send editor-relative context only. The server resolves the selected
        // workspace root from the authenticated project identity. The live
        // editor content (including unsaved edits) is captured via
        // getActiveEditorContent(). This ensures the agent receives
        // the current buffer, not a stale disk read.
        const activeTab = state.editorTabs.find(t => t.isActive);
        const openFiles = state.editorTabs.flatMap(t => t.workspacePath ? [t.workspacePath] : []);
        const liveContent = getActiveEditorContent();
        const selection = getActiveEditorSelection();
        const result = await api.orchestratorChat(sessionId, text, {
          activeFile: activeTab?.workspacePath,
          openFiles: openFiles.length > 0 ? openFiles : undefined,
          activeFileContent: liveContent ?? undefined,
          selection: selection ?? undefined,
        });
        if (result.status === 'plan-ready') {
          updateChatMessage(sessionId, assistantMsg.id, {
            isStreaming: false,
            isThinking: false,
            content: 'Review-only change plan created. No files were changed and no tests have run. Review the plan before approving any work.',
          });
          relay.openPlanReview(result.planId);
        }
      }
    } catch (err) {
      // Mark the assistant message as errored
      if (sessionId) {
        updateChatMessage(sessionId, assistantMsg.id, {
          isStreaming: false,
          isThinking: false,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      addNotification('error', 'Failed to send', err instanceof Error ? err.message : String(err));
    }
  }, [state.activeChatId, state.editorTabs, addChatMessage, updateChatMessage, addNotification, relay]);

  // ── Follow-up click: send as next message ─────────────────────────────
  const handleFollowUp = useCallback((text: string) => {
    handleSend(text, [], { provider: '', model: '' });
  }, [handleSend]);

  // ── Regenerate last response ──────────────────────────────────────────
  const handleRegenerate = useCallback(() => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      handleSend(lastUser.content, [], { provider: '', model: '' });
    }
  }, [messages, handleSend]);

  // ── Start Project (directive Section 2.1) ─────────────────────────────
  // Calls POST /api/orchestrator/plan with the current sessionId. The
  // orchestrator reads the chat history, produces a structured build plan,
  // and emits relay:plan-ready. RelayContext catches that event and we
  // open the PlanReviewPanel here.
  const handleStartProject = useCallback(async () => {
    const sessionId = state.activeChatId;
    if (!sessionId) return;
    setStartProjectLoading(true);
    try {
      const result = await api.generatePlan(sessionId);
      relay.openPlanReview(result.planId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addNotification('error', 'Plan generation failed', msg);
    } finally {
      setStartProjectLoading(false);
    }
  }, [state.activeChatId, relay, addNotification]);

  return (
    <div
      className="flex flex-col h-full relative overflow-hidden"
      style={{
        backgroundColor: 'var(--void-black)',
        // Give the chat panel a defined flex footprint so the CodeEditor
        // (which is `flex-1`) cannot crush it to zero width or cause it to
        // overlap. min-width keeps it usable; shrink-0 prevents flex from
        // squeezing it. This guarantees the editor's text cannot bleed
        // through, because the chat panel owns a hard-rectangular region
        // with an opaque background and clipped overflow.
        minWidth: 380,
        flexShrink: 0,
        width: 480,
      }}
    >
      {/* Custom chat background (Bug B fix) — sibling of header/scroll/input,
          NOT a child of the scroll container. Lives at z-index 0 so it sits
          behind everything else, and because it's NOT inside the
          overflow-y:auto container, it does NOT scroll with the message list.
          The scroll container below is transparent so the background shows
          through while messages scroll independently on top of it. */}
      {chatBackground.type === 'image' && chatBackground.url && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${chatBackground.url})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: chatBackground.opacity,
            filter: `blur(${chatBackground.blur}px)`,
            zIndex: 0,
          }}
        />
      )}

      {/* Header — chat title + bubble style toggle (z-index 1, above bg) */}
      <div
        className="flex items-center justify-between px-4 py-2.5 shrink-0"
        style={{
          borderBottom: '1px solid var(--border-subtle)',
          position: 'relative',
          zIndex: 1,
          backgroundColor: 'var(--void-black)',
        }}
      >
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
            {activeChat?.name || 'New Chat'}
          </span>
        </div>

        {/* Bubble style toggle (A/B) + Background settings */}
        <div className="flex items-center gap-2">
          {/* Background settings button (custom chat background — separate from Brain directive) */}
          <button
            onClick={() => setShowBackgroundSettings(true)}
            className="p-1.5 rounded transition-colors hover:bg-[var(--surface-raised)]"
            style={{ color: chatBackground.type !== 'none' ? 'var(--siren-red)' : 'var(--steel-silver)' }}
            title="Chat background settings"
          >
            <ImageIcon className="w-3.5 h-3.5" />
          </button>

          <div className="relative">
          <button
            onClick={() => setShowStyleToggle(!showStyleToggle)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors hover:bg-[var(--surface-raised)]"
            style={{ color: 'var(--steel-silver)', border: '1px solid var(--border-subtle)' }}
          >
            Style {bubbleStyle}
            <ChevronDown className="w-2.5 h-2.5" />
          </button>
          <AnimatePresence>
            {showStyleToggle && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute top-full right-0 mt-1 rounded-md overflow-hidden z-50"
                style={{
                  backgroundColor: 'var(--surface-raised)',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                }}
              >
                {(['A', 'B'] as BubbleStyle[]).map(style => (
                  <button
                    key={style}
                    onClick={() => { setBubbleStyle(style); setShowStyleToggle(false); }}
                    className="w-full text-left px-3 py-1.5 text-[11px] transition-colors hover:bg-[var(--surface-dark)]"
                    style={{ color: style === bubbleStyle ? 'var(--siren-red)' : 'var(--steel-silver)' }}
                  >
                    Style {style} — {style === 'A' ? 'Premium Glass' : 'Theme Reactive'}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Messages list — transparent so the sibling background shows through.
          z-index 1 to sit above the background. The background itself was
          moved OUT of this container (Bug B fix) so it no longer scrolls
          with the message list. */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4 relative"
        style={{
          backgroundColor: 'transparent',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <div className="relative z-10">
        {messages.length === 0 && !isGenerating && (
          // Welcome state — fill the entire scroll container and center the
          // content both axes. Previously used `h-full`, but the parent
          // wrapper has no explicit height, so `h-full` resolved to 0 and
          // the welcome text fell back to content-height at the top of the
          // container, looking "jammed into the bottom" relative to the
          // empty space below. Using `absolute inset-0` makes the welcome
          // div fill the scroll container directly (which is `relative`),
          // so flex centering works correctly. Renders immediately on mount
          // — no auth gate, no delay. Disappears the moment the first
          // message is added (messages.length becomes 1).
          <div
            className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none"
            style={{ padding: '16px' }}
          >
            <MessageSquare className="w-8 h-8 mb-3" style={{ color: 'var(--muted-silver)' }} />
            <div className="text-xl font-semibold mb-1" style={{ color: 'var(--bright-silver)' }}>
              {(() => {
                const name = state.authUser?.name || 'Operator';
                const hour = new Date().getHours();
                if (hour < 12) return `Good morning, ${name}`;
                if (hour < 18) return `Good afternoon, ${name}`;
                return `Good evening, ${name}`;
              })()}
            </div>
            <span className="text-[12px]" style={{ color: 'var(--muted-silver)' }}>
              How can I help you today?
            </span>
          </div>
        )}

        {messages.map((msg) => (
          <ChatBubble
            key={msg.id}
            message={msg}
            bubbleStyle={bubbleStyle}
            onFollowUpClick={handleFollowUp}
            onRegenerate={handleRegenerate}
            onCopy={(content) => navigator.clipboard.writeText(content)}
          />
        ))}

        {/* Thinking indicator (when generating but no content yet) */}
        {isGenerating && messages.length > 0 && !messages[messages.length - 1]?.content && (
          <div className="flex items-center gap-3 px-2">
            <RotatingLoader size={24} intervalMs={2500} />
            <span className="text-[12px]" style={{ color: 'var(--steel-silver)' }}>
              <motion.span animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 1.5 }}>
                Thinking…
              </motion.span>
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
        </div>{/* close relative z-10 wrapper */}
      </div>

      {/* Input bar (z-index 1, opaque bg so it stays readable over the background) */}
      <div
        className="shrink-0 px-4 pb-3 pt-2"
        style={{
          borderTop: '1px solid var(--border-subtle)',
          position: 'relative',
          zIndex: 1,
          backgroundColor: 'var(--void-black)',
        }}
      >
        <ChatInput
          onSend={handleSend}
          disabled={isGenerating}
          onStartProject={handleStartProject}
          startProjectLoading={startProjectLoading}
        />
      </div>

      {/* Notifications */}
      <NotificationContainer notifications={notifications} onDismiss={dismissNotification} />

      {/* Chat background settings (custom chat background — separate from Brain directive) */}
      <ChatBackgroundSettings
        open={showBackgroundSettings}
        onClose={() => setShowBackgroundSettings(false)}
        background={chatBackground}
        onChange={setChatBackground}
      />
    </div>
  );
}
