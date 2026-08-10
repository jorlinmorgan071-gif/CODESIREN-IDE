// app/src/components/chat/elements/ChatInput.tsx
// Section 2 — Main chat window input bar and welcome state.
// Glass container (from ruixen-moon-chat), auto-resize textarea + attachment previews +
// paste handling (from claude-style-chat-input), two-level model selector (Provider → Model),
// action icons (live/camera/mic), send button with glow.
// All colors use Code Siren theme tokens. No Next.js imports.

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Send, Paperclip, Camera, Mic, Radio, Folder, X, ChevronDown,
  Play, Loader2,
} from 'lucide-react';
import { GlowButton } from '@/components/ui/glow-button';
import { PremiumTooltip } from '@/components/ui/premium-tooltip';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { AttachmentSpinner } from '@/components/ui/loaders';

// ── Types ────────────────────────────────────────────────────────────────

interface Attachment {
  id: string;
  name: string;
  type: 'file' | 'folder' | 'image';
  size?: number;
  preview?: string;  // data URL for images
}

interface EngineInfo {
  id: string;
  name: string;
  available: boolean;
  models?: Array<{ name: string; size?: number }>;
}

interface ModelSelection {
  provider: string;
  model: string;
}

interface ChatInputProps {
  onSend: (text: string, attachments: Attachment[], model: ModelSelection) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Optional callback for the "Start Project" button (directive Section 2.1). */
  onStartProject?: () => void;
  /** When true, the Start Project button shows a loading spinner. */
  startProjectLoading?: boolean;
}

// ── Voice input bar animation (from ai-voice-input snippet) ───────────────

function VoiceVisualizer({ active }: { active: boolean }) {
  return (
    <div className="flex items-center gap-0.5 h-6">
      {Array.from({ length: 5 }).map((_, i) => (
        <motion.div
          key={i}
          className="w-1 rounded-full"
          style={{ backgroundColor: 'var(--siren-red)' }}
          animate={active ? {
            height: [8, 20, 8],
            opacity: [0.5, 1, 0.5],
          } : { height: 4, opacity: 0.3 }}
          transition={{
            repeat: active ? Infinity : 0,
            duration: 0.4,
            delay: i * 0.08,
            ease: 'easeInOut',
          }}
        />
      ))}
    </div>
  );
}

// ── Main ChatInput component ─────────────────────────────────────────────

export function ChatInput({ onSend, disabled, placeholder = 'Message Code Siren…', onStartProject, startProjectLoading }: ChatInputProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  // Model selector state
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [providerDropdown, setProviderDropdown] = useState(false);
  const [modelDropdown, setModelDropdown] = useState(false);

  // Live voice session — wired to the "Live conversation" button (Radio icon).
  // toggleVoiceSession() starts a call if inactive, ends it if active (same
  // function the F6 hotkey uses). isActive drives the button's color so the
  // user can see at a glance whether a call is live.
  const { isActive, toggleVoiceSession } = useVoiceSession();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // ── Type definitions for Web Speech API (not in standard TS lib) ──────
  interface SpeechRecognitionEvent {
    resultIndex: number;
    results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
  }
  interface SpeechRecognitionInstance {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start: () => void;
    stop: () => void;
    onresult: (event: SpeechRecognitionEvent) => void;
    onend: () => void;
    onerror: () => void;
  }
  type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  // ── Load engines/models on mount ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api'}/models/engines`, {
          headers: { Authorization: `Bearer ${localStorage.getItem('code_siren_jwt')}` },
        });
        if (!res.ok) return;
        const body = await res.json() as { engines: EngineInfo[] };
        if (cancelled) return;
        const available = body.engines.filter(e => e.available);
        setEngines(available);
        if (available.length > 0 && !selectedProvider) {
          setSelectedProvider(available[0].id);
        }
      } catch { /* server not ready yet */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Current provider's models (derived, no setState in effect) ────────
  const currentEngine = engines.find(e => e.id === selectedProvider);
  const currentModels = currentEngine?.models ?? [];

  // ── Auto-resize textarea ──────────────────────────────────────────────
  const adjustHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, []);

  useEffect(() => { adjustHeight(); }, [text, adjustHeight]);

  // ── Send handler ──────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    if (!text.trim() || disabled) return;
    onSend(text.trim(), attachments, { provider: selectedProvider, model: selectedModel });
    setText('');
    setAttachments([]);
    adjustHeight();
  }, [text, attachments, disabled, onSend, selectedProvider, selectedModel, adjustHeight]);

  // ── Key handler: Enter to send, Shift+Enter for newline ───────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Paste handler: large text + images ────────────────────────────────
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          setAttachments(prev => [...prev, {
            id: `paste-${Date.now()}`,
            name: `pasted-image.${file.type.split('/')[1]}`,
            type: 'image',
            size: file.size,
            preview: reader.result as string,
          }]);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  // ── File attachment ───────────────────────────────────────────────────
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setUploading(true);
    const newAttachments: Attachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const att: Attachment = {
        id: `file-${Date.now()}-${i}`,
        name: file.name,
        type: file.type.startsWith('image/') ? 'image' : 'file',
        size: file.size,
      };
      if (att.type === 'image') {
        const reader = new FileReader();
        reader.onload = () => { att.preview = reader.result as string; };
        reader.readAsDataURL(file);
      }
      newAttachments.push(att);
    }
    setTimeout(() => {
      setAttachments(prev => [...prev, ...newAttachments]);
      setUploading(false);
    }, 500);
    e.target.value = '';
  };

  // ── Folder attachment ─────────────────────────────────────────────────
  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const folderName = files[0].webkitRelativePath?.split('/')[0] || 'folder';
    setAttachments(prev => [...prev, {
      id: `folder-${Date.now()}`,
      name: folderName,
      type: 'folder',
      size: files.length,
    }]);
    e.target.value = '';
  };

  // ── Remove attachment ─────────────────────────────────────────────────
  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  // ── Mic: press-and-hold-to-record, release → transcribe → auto-send ──
  const startRecording = () => {
    setIsRecording(true);
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
    const SpeechRecognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      let finalTranscript = '';
      recognition.onresult = (event: SpeechRecognitionEvent) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
      };
      recognition.onend = () => {
        setIsRecording(false);
        if (finalTranscript.trim()) {
          setText(finalTranscript.trim());
          setTimeout(() => {
            onSend(finalTranscript.trim(), attachments, { provider: selectedProvider, model: selectedModel });
            setText('');
            setAttachments([]);
          }, 200);
        }
      };
      recognition.onerror = () => setIsRecording(false);
      recognition.start();
      recognitionRef.current = recognition;
    } else {
      setTimeout(() => { setIsRecording(false); }, 2000);
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    } else {
      setIsRecording(false);
    }
  };

  // ── Hidden file inputs ────────────────────────────────────────────────
  const hiddenInputs = (
    <>
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
      <input ref={folderInputRef} type="file" className="hidden" onChange={handleFolderSelect}
        {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)} />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={handleFileSelect} />
    </>
  );

  return (
    <div className="flex flex-col items-center w-full">
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 w-full max-w-2xl">
          {attachments.map(att => (
            <div
              key={att.id}
              className="relative flex items-center gap-2 px-2.5 py-1.5 rounded-md"
              style={{
                backgroundColor: 'var(--surface-raised)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {att.type === 'image' && att.preview ? (
                <img src={att.preview} alt={att.name} className="w-6 h-6 rounded object-cover" />
              ) : att.type === 'folder' ? (
                <Folder className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
              ) : (
                <Paperclip className="w-4 h-4" style={{ color: 'var(--steel-silver)' }} />
              )}
              <span className="text-[11px] max-w-[120px] truncate" style={{ color: 'var(--steel-silver)' }}>
                {att.name}
              </span>
              {att.size !== undefined && att.type !== 'folder' && (
                <span className="text-[9px]" style={{ color: 'var(--muted-silver)' }}>
                  {(att.size / 1024).toFixed(0)}KB
                </span>
              )}
              <button
                onClick={() => removeAttachment(att.id)}
                className="p-0.5 rounded hover:bg-[var(--surface-dark)]"
                style={{ color: 'var(--muted-silver)' }}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main input container — glass panel */}
      <div className="glass-panel rounded-xl w-full max-w-2xl">
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isRecording ? 'Listening…' : placeholder}
          disabled={disabled}
          rows={1}
          className="w-full bg-transparent text-[13px] leading-relaxed resize-none outline-none px-4 pt-3 pb-2"
          style={{ color: 'var(--bright-silver)', minHeight: 42, maxHeight: 200 }}
        />

        {/* Footer: action icons + model selector + send */}
        <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
          {/* Left: action icons */}
          <div className="flex items-center gap-1">
            <PremiumTooltip text="Attach files" position="top">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)]"
                style={{ color: 'var(--steel-silver)' }}
                disabled={uploading}
              >
                {uploading ? <AttachmentSpinner size={16} /> : <Paperclip className="w-4 h-4" />}
              </button>
            </PremiumTooltip>

            <PremiumTooltip text="Attach folder" position="top">
              <button
                onClick={() => folderInputRef.current?.click()}
                className="p-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)]"
                style={{ color: 'var(--steel-silver)' }}
              >
                <Folder className="w-4 h-4" />
              </button>
            </PremiumTooltip>

            <PremiumTooltip text="Vision input" position="top">
              <button
                onClick={() => cameraInputRef.current?.click()}
                className="p-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)]"
                style={{ color: 'var(--steel-silver)' }}
              >
                <Camera className="w-4 h-4" />
              </button>
            </PremiumTooltip>

            <PremiumTooltip text="Live conversation" position="top">
              <button
                onClick={() => void toggleVoiceSession()}
                className="p-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)]"
                style={{ color: isActive ? 'var(--siren-red)' : 'var(--steel-silver)' }}
              >
                <Radio className="w-4 h-4" />
              </button>
            </PremiumTooltip>

            <PremiumTooltip text="Press and hold to record" position="top">
              <button
                onPointerDown={startRecording}
                onPointerUp={stopRecording}
                onPointerLeave={stopRecording}
                className="p-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)]"
                style={{ color: isRecording ? 'var(--siren-red)' : 'var(--steel-silver)' }}
              >
                {isRecording ? <VoiceVisualizer active /> : <Mic className="w-4 h-4" />}
              </button>
            </PremiumTooltip>
          </div>

          {/* Right: model selector + send */}
          <div className="flex items-center gap-2">
            {/* Provider dropdown */}
            {engines.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => { setProviderDropdown(!providerDropdown); setModelDropdown(false); }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors hover:bg-[var(--surface-raised)]"
                  style={{ color: 'var(--steel-silver)', border: '1px solid var(--border-subtle)' }}
                >
                  {currentEngine?.name || selectedProvider}
                  <ChevronDown className="w-3 h-3" />
                </button>
                <AnimatePresence>
                  {providerDropdown && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.15 }}
                      className="absolute bottom-full mb-1 right-0 min-w-[140px] rounded-md overflow-hidden z-50"
                      style={{
                        backgroundColor: 'var(--surface-raised)',
                        border: '1px solid var(--border-subtle)',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                      }}
                    >
                      {engines.map(e => (
                        <button
                          key={e.id}
                          onClick={() => { setSelectedProvider(e.id); setSelectedModel(''); setProviderDropdown(false); }}
                          className="w-full text-left px-3 py-1.5 text-[11px] transition-colors hover:bg-[var(--surface-dark)]"
                          style={{
                            color: e.id === selectedProvider ? 'var(--siren-red)' : 'var(--steel-silver)',
                          }}
                        >
                          {e.name}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* Model dropdown */}
            {currentModels.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => { setModelDropdown(!modelDropdown); setProviderDropdown(false); }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors hover:bg-[var(--surface-raised)]"
                  style={{ color: 'var(--steel-silver)', border: '1px solid var(--border-subtle)' }}
                >
                  {selectedModel || 'Select model'}
                  <ChevronDown className="w-3 h-3" />
                </button>
                <AnimatePresence>
                  {modelDropdown && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.15 }}
                      className="absolute bottom-full mb-1 right-0 min-w-[160px] rounded-md overflow-hidden z-50 max-h-48 overflow-y-auto"
                      style={{
                        backgroundColor: 'var(--surface-raised)',
                        border: '1px solid var(--border-subtle)',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                      }}
                    >
                      {currentModels.map(m => (
                        <button
                          key={m.name}
                          onClick={() => { setSelectedModel(m.name); setModelDropdown(false); }}
                          className="w-full text-left px-3 py-1.5 text-[11px] transition-colors hover:bg-[var(--surface-dark)]"
                          style={{
                            color: m.name === selectedModel ? 'var(--siren-red)' : 'var(--steel-silver)',
                          }}
                        >
                          {m.name}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* Start Project button (directive Section 2.1) — always visible,
                labeled, distinct from the send icon. Triggers the orchestrator
                to read chat history + produce a structured build plan. */}
            {onStartProject && (
              <button
                onClick={onStartProject}
                disabled={startProjectLoading || disabled}
                className="flex items-center gap-1 px-2.5 h-8 rounded-md text-[11px] font-medium transition-colors hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed flex-shrink-0"
                style={{
                  backgroundColor: startProjectLoading ? 'rgba(238, 28, 28, 0.08)' : 'rgba(238, 28, 28, 0.12)',
                  border: '1px solid rgba(238, 28, 28, 0.3)',
                  color: 'var(--siren-red)',
                }}
                title="Have the orchestrator read this conversation and produce a structured build plan"
              >
                {startProjectLoading ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Reading…
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3" />
                    Start Project
                  </>
                )}
              </button>
            )}

            {/* Send button with glow */}
            <GlowButton
              size="icon"
              glow
              onClick={handleSend}
              disabled={!text.trim() || disabled}
              className="!w-8 !h-8"
            >
              <Send className="w-3.5 h-3.5" />
            </GlowButton>
          </div>
        </div>
      </div>

      {hiddenInputs}
    </div>
  );
}
