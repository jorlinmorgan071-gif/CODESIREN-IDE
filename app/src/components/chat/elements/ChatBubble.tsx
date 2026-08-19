// app/src/components/chat/elements/ChatBubble.tsx
// Section 6 — Chat bubble and its elements.
// Two styles: Style A (fixed premium glass) + Style B (theme-reactive accent-tinted).
// Structural elements: avatar, action icon row, follow-up chips, code blocks, collapsible thinking panel.
// All colors use Code Siren theme tokens — no bundled palette.

import React, { useState, memo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Copy, Share2, ThumbsUp, ThumbsDown, Volume2, RefreshCw,
  ChevronDown, Check, ArrowRight, User, Bot,
} from 'lucide-react';
import { TypewriterText, ShimmerText } from './text-animations';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { ChatMessage as AppChatMessage } from '@/types';

// ── Types ────────────────────────────────────────────────────────────────

export type BubbleStyle = 'A' | 'B';

// Re-export the app's ChatMessage type so consumers can import from here
export type ChatMessage = AppChatMessage;

export interface ChatCodeBlock {
  language: string;
  code: string;
  filename?: string;
}

export interface FollowUpChip {
  text: string;
}

interface ChatBubbleProps {
  message: ChatMessage;
  bubbleStyle?: BubbleStyle;
  onFollowUpClick?: (text: string) => void;
  onRegenerate?: () => void;
  onCopy?: (content: string) => void;
  onShare?: (content: string) => void;
  onSpeak?: (content: string) => void;
  onThumbsUp?: () => void;
  onThumbsDown?: () => void;
}

// ── Helper: parse code blocks from content ───────────────────────────────

function parseContent(content: string): { prose: string[]; codeBlocks: ChatCodeBlock[] } {
  const prose: string[] = [];
  const codeBlocks: ChatCodeBlock[] = [];
  const codeBlockRegex = /```(\w+)?(?::([^\n]+))?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Push prose before this code block
    if (match.index > lastIndex) {
      const before = content.slice(lastIndex, match.index).trim();
      if (before) prose.push(before);
    }
    codeBlocks.push({
      language: match[1] || 'text',
      code: match[3].trim(),
      filename: match[2]?.trim(),
    });
    lastIndex = match.index + match[0].length;
  }

  // Push remaining prose
  if (lastIndex < content.length) {
    const after = content.slice(lastIndex).trim();
    if (after) prose.push(after);
  }

  return { prose, codeBlocks };
}

// ── CodeBlock sub-component ──────────────────────────────────────────────

function CodeBlockView({ block }: { block: ChatCodeBlock }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(block.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="chat-code-block my-2">
      <div className="chat-code-block-header">
        <span>{block.filename || block.language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 transition-colors hover:text-[var(--bright-silver)]"
          style={{ color: 'var(--steel-silver)' }}
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          <span className="text-[10px]">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre><code>{block.code}</code></pre>
    </div>
  );
}

// ── Thinking panel sub-component ─────────────────────────────────────────

function ThinkingPanel({
  content,
  isThinking,
  durationMs,
}: {
  content?: string;
  isThinking?: boolean;
  durationMs?: number;
}) {
  const [expanded, setExpanded] = useState(isThinking ?? false);

  // Auto-expand when thinking starts, auto-collapse when done
  React.useEffect(() => {
    setExpanded(isThinking ?? false);
  }, [isThinking]);

  const elapsedSec = durationMs ? Math.round(durationMs / 1000) : 0;

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] transition-colors"
        style={{ color: 'var(--steel-silver)' }}
      >
        {isThinking ? (
          <ShimmerText text="…is thinking" loop as="span" />
        ) : (
          <span>Thought for {elapsedSec}s</span>
        )}
        <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.15 }}>
          <ChevronDown className="w-3 h-3" />
        </motion.div>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              className="mt-1.5 p-2.5 rounded-md text-[12px] font-mono"
              style={{
                backgroundColor: 'var(--void-black)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--steel-silver)',
                fontFamily: 'JetBrains Mono, monospace',
                whiteSpace: 'pre-wrap',
              }}
            >
              {content || '(thinking…)'}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Action icon row ──────────────────────────────────────────────────────

function ActionRow({
  onCopy, onShare, onSpeak, onRegenerate, onThumbsUp, onThumbsDown,
}: {
  onCopy?: () => void;
  onShare?: () => void;
  onSpeak?: () => void;
  onRegenerate?: () => void;
  onThumbsUp?: () => void;
  onThumbsDown?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const actions = [
    { icon: copied ? Check : Copy, label: 'Copy', onClick: () => { onCopy?.(); setCopied(true); setTimeout(() => setCopied(false), 2000); } },
    { icon: Share2, label: 'Share', onClick: onShare },
    { icon: ThumbsUp, label: 'Good', onClick: onThumbsUp },
    { icon: ThumbsDown, label: 'Bad', onClick: onThumbsDown },
    { icon: Volume2, label: 'Listen', onClick: onSpeak },
    { icon: RefreshCw, label: 'Regenerate', onClick: onRegenerate },
  ];

  return (
    <div className="flex items-center gap-1 mt-1.5 -ml-1">
      {actions.map((a, i) => {
        const Icon = a.icon;
        return (
          <button
            key={i}
            onClick={a.onClick}
            className="p-1 rounded transition-colors hover:bg-[var(--surface-raised)]"
            style={{ color: 'var(--muted-silver)' }}
            title={a.label}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}
    </div>
  );
}

// ── Main ChatBubble component ────────────────────────────────────────────

export const ChatBubble = memo(function ChatBubble({
  message,
  bubbleStyle = 'A',
  onFollowUpClick,
  onRegenerate,
  onCopy,
  onShare,
  onSpeak,
  onThumbsUp,
  onThumbsDown,
}: ChatBubbleProps) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const styleClass = bubbleStyle === 'A' ? 'bubble-style-a' : 'bubble-style-b';

  const { prose, codeBlocks } = isAssistant
    ? parseContent(message.content)
    : { prose: [message.content], codeBlocks: [] };

  // Combine parsed code blocks with any explicitly provided ones
  const allCodeBlocks = [...codeBlocks, ...(message.codeBlocks || [])];

  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
        style={{
          backgroundColor: isUser ? 'var(--surface-raised)' : 'var(--siren-red)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {isUser ? (
          <User className="w-3.5 h-3.5" style={{ color: 'var(--steel-silver)' }} />
        ) : (
          <Bot className="w-3.5 h-3.5" style={{ color: 'white' }} />
        )}
      </div>

      {/* Bubble content */}
      <div className={`flex flex-col max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Agent name (for assistant messages) */}
        {isAssistant && message.agentName && (
          <div className="text-[10px] mb-0.5" style={{ color: 'var(--muted-silver)' }}>
            {message.agentName}
          </div>
        )}

        {/* Bubble */}
        <div
          className={`rounded-lg px-3.5 py-2.5 ${styleClass}`}
          style={isUser ? {
            backgroundColor: 'var(--surface-raised)',
            border: '1px solid var(--border-subtle)',
          } : undefined}
        >
          {/* Thinking panel (assistant only) */}
          {isAssistant && (message.isThinking || message.thinkingContent !== undefined) && (
            <ThinkingPanel
              content={message.thinkingContent}
              isThinking={message.isThinking}
              durationMs={message.thinkingDurationMs}
            />
          )}

          {/* Prose content */}
          {prose.map((text, i) => (
            <div
              key={i}
              className="text-[13px] leading-relaxed mb-1 last:mb-0"
              style={{ color: 'var(--bright-silver)' }}
            >
              {isAssistant && message.isStreaming ? (
                <TypewriterText text={text} speed={15} showCursor />
              ) : (
                <MarkdownRenderer content={text} />
              )}
            </div>
          ))}

          {/* Code blocks — rendered in bordered boxes, never inline with prose */}
          {allCodeBlocks.map((block, i) => (
            <CodeBlockView key={i} block={block} />
          ))}

          {/* Artifacts */}
          {message.artifacts && message.artifacts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {message.artifacts.map((a, i) => (
                <span
                  key={i}
                  className="text-[10px] px-2 py-0.5 rounded"
                  style={{
                    backgroundColor: 'var(--surface-raised)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--steel-silver)',
                  }}
                >
                  📎 {a.name}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Action row (assistant only) */}
        {isAssistant && !message.isStreaming && (
          <ActionRow
            onCopy={() => onCopy?.(message.content)}
            onShare={() => onShare?.(message.content)}
            onSpeak={() => onSpeak?.(message.content)}
            onRegenerate={onRegenerate}
            onThumbsUp={onThumbsUp}
            onThumbsDown={onThumbsDown}
          />
        )}

        {/* Follow-up suggestion chips (assistant only) */}
        {isAssistant && message.followUps && message.followUps.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.followUps.map((chip, i) => (
              <button
                key={i}
                className="follow-up-chip"
                onClick={() => onFollowUpClick?.(chip.text)}
              >
                <ArrowRight className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
                {chip.text}
              </button>
            ))}
          </div>
        )}

        {/* Timestamp */}
        <div className="text-[9px] mt-0.5" style={{ color: 'var(--muted-silver)' }}>
          {message.timestamp}
        </div>
      </div>
    </div>
  );
});
