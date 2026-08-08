// app/src/components/modals/BubbleSettingsPanel.tsx
// Phase B: Bubble accessibility settings with live preview.
//
// Lets the user customize:
//   - Caption font (12 options with live preview)
//   - Caption size, shadow, background, animation
//   - High-contrast mode
//   - Bubble shape, visualization style, animation
//   - VRM model inside bubble
//   - Bubble size
//
// All changes persist to /api/bubble/settings and update the live bubble.

import { useState, useEffect, useCallback } from 'react';
import { getToken } from '@/lib/auth';
import { Loader2, Check } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

interface BubbleSettings {
  captionFont: string;
  captionSize: string;
  captionShadow: string;
  captionBg: string;
  captionAnimation: string;
  highContrast: boolean;
  bubbleShape: string;
  bubbleVisual: string;
  bubbleAnimation: string;
  showVRM: boolean;
  bubbleAvatarId: string;
  bubbleSize: string;
}

const DEFAULTS: BubbleSettings = {
  captionFont: 'inter',
  captionSize: 'sm',
  captionShadow: 'medium',
  captionBg: 'blur',
  captionAnimation: 'fade',
  highContrast: false,
  bubbleShape: 'circle',
  bubbleVisual: 'ring',
  bubbleAnimation: 'breathe',
  showVRM: false,
  bubbleAvatarId: 'default',
  bubbleSize: 'md',
};

const FONTS = [
  { id: 'inter', label: 'Inter', cssClass: 'caption-font-inter', preview: 'The quick brown fox jumps' },
  { id: 'jetbrains', label: 'JetBrains Mono', cssClass: 'caption-font-jetbrains', preview: 'const x = 42;' },
  { id: 'fira', label: 'Fira Code', cssClass: 'caption-font-fira', preview: '=> { return true; }' },
  { id: 'space', label: 'Space Grotesk', cssClass: 'caption-font-space', preview: 'Hello, World!' },
  { id: 'outfit', label: 'Outfit', cssClass: 'caption-font-outfit', preview: 'Design matters.' },
  { id: 'dm', label: 'DM Sans', cssClass: 'caption-font-dm', preview: 'Clean & readable.' },
  { id: 'sora', label: 'Sora', cssClass: 'caption-font-sora', preview: 'Modern typography.' },
  { id: 'manrope', label: 'Manrope', cssClass: 'caption-font-manrope', preview: 'Easy on the eyes.' },
  { id: 'jakarta', label: 'Plus Jakarta Sans', cssClass: 'caption-font-jakarta', preview: 'Smooth & sharp.' },
  { id: 'roboto-mono', label: 'Roboto Mono', cssClass: 'caption-font-roboto-mono', preview: 'console.log("hi")' },
  { id: 'source-code', label: 'Source Code Pro', cssClass: 'caption-font-source-code', preview: 'function() {}' },
  { id: 'bebas', label: 'Bebas Neue', cssClass: 'caption-font-bebas', preview: 'BOLD AND TALL' },
];

const SIZES = [
  { id: 'xs', label: 'Tiny', px: '9px' },
  { id: 'sm', label: 'Small', px: '11px' },
  { id: 'md', label: 'Medium', px: '13px' },
  { id: 'lg', label: 'Large', px: '16px' },
];

const SHADOWS = [
  { id: 'none', label: 'None' },
  { id: 'soft', label: 'Soft' },
  { id: 'medium', label: 'Medium' },
  { id: 'strong', label: 'Strong' },
  { id: 'raised', label: 'Raised' },
  { id: 'glow', label: 'Glow' },
];

const BGS = [
  { id: 'none', label: 'Transparent' },
  { id: 'solid', label: 'Solid' },
  { id: 'blur', label: 'Blurred' },
  { id: 'gradient', label: 'Gradient' },
  { id: 'accent', label: 'Accent Tint' },
];

const ANIMATIONS = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade In' },
  { id: 'slide', label: 'Slide In' },
  { id: 'scale', label: 'Scale In' },
  { id: 'blur', label: 'Blur In' },
];

const SHAPES = [
  { id: 'circle', label: 'Circle' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'squircle', label: 'Squircle' },
  { id: 'hexagon', label: 'Hexagon' },
];

const VISUALS = [
  { id: 'ring', label: 'Amplitude Ring' },
  { id: 'bars', label: 'Frequency Bars' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'orb', label: 'Orb' },
  { id: 'vrm', label: 'VRM Avatar' },
];

const BUBBLE_ANIMS = [
  { id: 'none', label: 'None' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'rotate', label: 'Rotate Glow' },
  { id: 'breathe', label: 'Breathe' },
];

const BUBBLE_SIZES = [
  { id: 'sm', label: 'Small (80px)' },
  { id: 'md', label: 'Medium (120px)' },
  { id: 'lg', label: 'Large (160px)' },
];

export function BubbleSettingsPanel() {
  const [settings, setSettings] = useState<BubbleSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const token = getToken() ?? '';
    fetch(`${API_BASE}/bubble/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (data.settings) setSettings({ ...DEFAULTS, ...data.settings });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const update = useCallback(async (updates: Partial<BubbleSettings>) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    setSaving(true);
    try {
      const token = getToken() ?? '';
      await fetch(`${API_BASE}/bubble/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(updates),
      });
      // Dispatch event so the bubble updates live
      window.dispatchEvent(new CustomEvent('code-siren:bubble-settings-changed', { detail: newSettings }));
    } catch { /* */ } finally {
      setSaving(false);
    }
  }, [settings]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--siren-red)' }} />
      </div>
    );
  }

  const selectedFont = FONTS.find(f => f.id === settings.captionFont) ?? FONTS[0];

  return (
    <div className="space-y-6 pb-4">
      {/* Saving indicator */}
      {saving && (
        <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted-silver)' }}>
          <Loader2 className="w-3 h-3 animate-spin" /> Saving...
        </div>
      )}

      {/* Live Preview */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Live Preview</div>
        <div className="p-4 rounded-lg" style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}>
          {/* Bubble preview */}
          <div className="flex items-center justify-center mb-4">
            <div
              className={`bubble-shape-${settings.bubbleShape} bubble-style-${settings.bubbleAnimation}`}
              style={{
                width: 80, height: 80,
                backgroundColor: 'rgba(7, 7, 11, 0.9)',
                border: '2px solid rgba(238, 28, 28, 0.4)',
                boxShadow: '0 0 20px rgba(238, 28, 28, 0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <span className="text-[8px]" style={{ color: 'var(--muted-silver)' }}>
                {settings.bubbleVisual === 'vrm' ? '👤' : settings.bubbleVisual === 'ring' ? '◎' : settings.bubbleVisual === 'bars' ? '▮▮' : settings.bubbleVisual === 'pulse' ? '●' : '⬤'}
              </span>
            </div>
          </div>
          {/* Caption preview */}
          <div className="flex justify-center">
            <div
              key={`${settings.captionFont}-${settings.captionAnimation}-${settings.highContrast}`}
              className={`caption-font-${settings.captionFont} caption-shadow-${settings.captionShadow} caption-bg-${settings.captionBg} caption-anim-${settings.captionAnimation} ${settings.highContrast ? 'caption-high-contrast' : ''}`}
              style={{
                fontSize: SIZES.find(s => s.id === settings.captionSize)?.px ?? '11px',
                padding: '4px 8px',
                borderRadius: '4px',
                maxWidth: '280px',
                color: settings.highContrast ? '#fff' : 'var(--bright-silver)',
              }}
            >
              <span style={{ fontSize: '0.8em', opacity: 0.6 }}>You: </span>
              {selectedFont.preview}
            </div>
          </div>
        </div>
      </div>

      {/* Caption Font */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Caption Font</div>
        <div className="grid grid-cols-2 gap-1.5">
          {FONTS.map(font => (
            <button
              key={font.id}
              onClick={() => update({ captionFont: font.id })}
              className={`caption-font-${font.id} p-2.5 rounded-md text-left transition-all text-[12px]`}
              style={{
                backgroundColor: settings.captionFont === font.id ? 'rgba(238, 28, 28, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.captionFont === font.id ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                color: 'var(--bright-silver)',
              }}
            >
              <div className="font-medium mb-0.5">{font.label}</div>
              <div className="text-[10px] opacity-70">{font.preview}</div>
              {settings.captionFont === font.id && <Check className="inline-block w-3 h-3 ml-1" style={{ color: 'var(--siren-red)' }} />}
            </button>
          ))}
        </div>
      </div>

      {/* Caption Size */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Caption Size</div>
        <div className="flex gap-1.5">
          {SIZES.map(s => (
            <button
              key={s.id}
              onClick={() => update({ captionSize: s.id })}
              className="flex-1 py-2 rounded-md text-[11px] transition-all"
              style={{
                backgroundColor: settings.captionSize === s.id ? 'rgba(238, 28, 28, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.captionSize === s.id ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                color: 'var(--bright-silver)',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Caption Shadow */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Caption Shadow</div>
        <div className="grid grid-cols-3 gap-1.5">
          {SHADOWS.map(s => (
            <button
              key={s.id}
              onClick={() => update({ captionShadow: s.id })}
              className={`caption-shadow-${s.id} py-2 rounded-md text-[11px] transition-all`}
              style={{
                backgroundColor: settings.captionShadow === s.id ? 'rgba(238, 28, 28, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.captionShadow === s.id ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                color: 'var(--bright-silver)',
              }}
            >{s.label}</button>
          ))}
        </div>
      </div>

      {/* Caption Background */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Caption Background</div>
        <div className="grid grid-cols-3 gap-1.5">
          {BGS.map(b => (
            <button
              key={b.id}
              onClick={() => update({ captionBg: b.id })}
              className="py-2 rounded-md text-[11px] transition-all"
              style={{
                backgroundColor: settings.captionBg === b.id ? 'rgba(238, 28, 28, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.captionBg === b.id ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                color: 'var(--bright-silver)',
              }}
            >{b.label}</button>
          ))}
        </div>
      </div>

      {/* Caption Animation */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Caption Animation</div>
        <div className="grid grid-cols-3 gap-1.5">
          {ANIMATIONS.map(a => (
            <button
              key={a.id}
              onClick={() => update({ captionAnimation: a.id })}
              className="py-2 rounded-md text-[11px] transition-all"
              style={{
                backgroundColor: settings.captionAnimation === a.id ? 'rgba(238, 28, 28, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.captionAnimation === a.id ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                color: 'var(--bright-silver)',
              }}
            >{a.label}</button>
          ))}
        </div>
      </div>

      {/* High Contrast Toggle */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <button
            onClick={() => update({ highContrast: !settings.highContrast })}
            className="relative w-10 h-5 rounded-full transition-colors"
            style={{ backgroundColor: settings.highContrast ? 'var(--siren-red)' : 'var(--surface-raised)' }}
          >
            <div
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
              style={{ transform: settings.highContrast ? 'translateX(22px)' : 'translateX(2px)' }}
            />
          </button>
          <span className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>High Contrast Captions</span>
        </label>
      </div>

      {/* Bubble Shape */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Bubble Shape</div>
        <div className="grid grid-cols-4 gap-1.5">
          {SHAPES.map(s => (
            <button
              key={s.id}
              onClick={() => update({ bubbleShape: s.id })}
              className="py-2 rounded-md text-[11px] transition-all"
              style={{
                backgroundColor: settings.bubbleShape === s.id ? 'rgba(238, 28, 28, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.bubbleShape === s.id ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                color: 'var(--bright-silver)',
              }}
            >{s.label}</button>
          ))}
        </div>
      </div>

      {/* Bubble Visualization */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Bubble Visualization</div>
        <div className="grid grid-cols-3 gap-1.5">
          {VISUALS.map(v => (
            <button
              key={v.id}
              onClick={() => update({ bubbleVisual: v.id, showVRM: v.id === 'vrm' })}
              className="py-2 rounded-md text-[11px] transition-all"
              style={{
                backgroundColor: settings.bubbleVisual === v.id ? 'rgba(238, 28, 28, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.bubbleVisual === v.id ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                color: 'var(--bright-silver)',
              }}
            >{v.label}</button>
          ))}
        </div>
      </div>

      {/* Bubble Animation */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Bubble Animation</div>
        <div className="grid grid-cols-4 gap-1.5">
          {BUBBLE_ANIMS.map(a => (
            <button
              key={a.id}
              onClick={() => update({ bubbleAnimation: a.id })}
              className="py-2 rounded-md text-[11px] transition-all"
              style={{
                backgroundColor: settings.bubbleAnimation === a.id ? 'rgba(238, 28, 28, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.bubbleAnimation === a.id ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                color: 'var(--bright-silver)',
              }}
            >{a.label}</button>
          ))}
        </div>
      </div>

      {/* Bubble Size */}
      <div>
        <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Bubble Size</div>
        <div className="grid grid-cols-3 gap-1.5">
          {BUBBLE_SIZES.map(s => (
            <button
              key={s.id}
              onClick={() => update({ bubbleSize: s.id })}
              className="py-2 rounded-md text-[11px] transition-all"
              style={{
                backgroundColor: settings.bubbleSize === s.id ? 'rgba(238, 28, 28, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.bubbleSize === s.id ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                color: 'var(--bright-silver)',
              }}
            >{s.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
