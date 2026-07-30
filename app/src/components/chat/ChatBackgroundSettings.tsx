// app/src/components/chat/ChatBackgroundSettings.tsx
// Custom chat background — user-settable wallpaper/images.
// SEPARATE from the Brain Visualizer directive (Section 8).
// Lets the user set a live wallpaper or static image as the chat panel background.
// Does NOT touch any chat-interface phase files beyond ChatPanel.tsx (additive: a background div layer).

import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Image as ImageIcon, X, Upload, Trash2, Check } from 'lucide-react';

export type ChatBackgroundType = 'none' | 'image' | 'video';

export interface ChatBackground {
  type: ChatBackgroundType;
  url: string;  // data URL or external URL
  opacity: number;  // 0..1
  blur: number;  // px
}

interface ChatBackgroundSettingsProps {
  open: boolean;
  onClose: () => void;
  background: ChatBackground;
  onChange: (bg: ChatBackground) => void;
}

const PRESET_WALLPAPERS = [
  { name: 'Aurora', url: 'https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=1920&q=80' },
  { name: 'Nebula', url: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=1920&q=80' },
  { name: 'Ocean', url: 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=1920&q=80' },
  { name: 'Forest', url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=80' },
  { name: 'Mountain', url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80' },
  { name: 'City', url: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1920&q=80' },
];

export function ChatBackgroundSettings({ open, onClose, background, onChange }: ChatBackgroundSettingsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onChange({ ...background, type: 'image', url: reader.result as string });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, [background, onChange]);

  const handlePresetSelect = useCallback((url: string) => {
    setSelectedPreset(url);
    onChange({ ...background, type: 'image', url });
  }, [background, onChange]);

  const handleClear = useCallback(() => {
    onChange({ type: 'none', url: '', opacity: 0.3, blur: 0 });
    setSelectedPreset(null);
  }, [onChange]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[90] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20 }}
            className="rounded-xl overflow-hidden max-w-lg w-full mx-4"
            style={{
              backgroundColor: 'var(--surface-dark)',
              border: '1px solid var(--border-subtle)',
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
                <span className="text-[13px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                  Chat Background
                </span>
              </div>
              <button onClick={onClose} className="p-1 rounded transition-colors hover:bg-[var(--surface-raised)]" style={{ color: 'var(--muted-silver)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-4 space-y-4">
              {/* Current background preview */}
              {background.type !== 'none' && (
                <div
                  className="relative h-24 rounded-lg overflow-hidden"
                  style={{ border: '1px solid var(--border-subtle)' }}
                >
                  <img src={background.url} alt="Background preview" className="w-full h-full object-cover" style={{ opacity: background.opacity, filter: `blur(${background.blur}px)` }} />
                  <div className="absolute inset-0" style={{ backgroundColor: 'rgba(7, 7, 11, 0.5)' }} />
                  <div className="absolute bottom-2 left-2 text-[10px]" style={{ color: 'var(--steel-silver)' }}>
                    Current: {background.type}
                  </div>
                </div>
              )}

              {/* Preset wallpapers */}
              <div>
                <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>
                  Preset Wallpapers
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {PRESET_WALLPAPERS.map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => handlePresetSelect(preset.url)}
                      className="relative h-16 rounded-md overflow-hidden transition-all hover:scale-105"
                      style={{ border: selectedPreset === preset.url ? '2px solid var(--siren-red)' : '1px solid var(--border-subtle)' }}
                    >
                      <img src={preset.url} alt={preset.name} className="w-full h-full object-cover" loading="lazy" />
                      <div className="absolute inset-0 flex items-end p-1" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)' }}>
                        <span className="text-[9px] text-white">{preset.name}</span>
                      </div>
                      {selectedPreset === preset.url && (
                        <div className="absolute top-1 right-1">
                          <Check className="w-3 h-3 text-white" style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.8))' }} />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Upload custom image */}
              <div>
                <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>
                  Custom Image
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md text-[12px] transition-colors"
                  style={{ border: '1px dashed var(--border-hover)', color: 'var(--steel-silver)' }}
                >
                  <Upload className="w-3.5 h-3.5" />
                  Upload image or video
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </div>

              {/* Opacity slider */}
              {background.type !== 'none' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--muted-silver)' }}>Opacity</span>
                    <span className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>{Math.round(background.opacity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={background.opacity}
                    onChange={(e) => onChange({ ...background, opacity: parseFloat(e.target.value) })}
                    className="w-full"
                    style={{ accentColor: 'var(--siren-red)' }}
                  />
                </div>
              )}

              {/* Blur slider */}
              {background.type !== 'none' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--muted-silver)' }}>Blur</span>
                    <span className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>{background.blur}px</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={20}
                    step={1}
                    value={background.blur}
                    onChange={(e) => onChange({ ...background, blur: parseInt(e.target.value) })}
                    className="w-full"
                    style={{ accentColor: 'var(--siren-red)' }}
                  />
                </div>
              )}

              {/* Clear button */}
              {background.type !== 'none' && (
                <button
                  onClick={handleClear}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[11px] transition-colors"
                  style={{ border: '1px solid rgba(238, 28, 28, 0.3)', color: 'var(--siren-red)' }}
                >
                  <Trash2 className="w-3 h-3" />
                  Remove Background
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
