// server/src/orchestrator/bubble-settings.ts
// Phase B: Accessibility Settings — bubble aesthetics, caption fonts,
// visualization styles, shadow/animation preferences.
//
// Persists to server/.runtime/bubble-settings.json (same pattern as
// avatar-settings.ts and voice-settings.ts).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);
const SETTINGS_PATH = join(__dirname_esm, '..', '..', '.runtime', 'bubble-settings.json');

export interface BubbleSettings {
  // Caption font family
  captionFont: 'inter' | 'jetbrains' | 'fira' | 'space' | 'outfit' | 'dm' | 'sora' | 'manrope' | 'jakarta' | 'roboto-mono' | 'source-code' | 'bebas';

  // Caption size
  captionSize: 'xs' | 'sm' | 'md' | 'lg';

  // Caption shadow style
  captionShadow: 'none' | 'soft' | 'medium' | 'strong' | 'raised' | 'glow';

  // Caption background style
  captionBg: 'none' | 'solid' | 'blur' | 'gradient' | 'accent';

  // Caption entrance animation
  captionAnimation: 'none' | 'fade' | 'slide' | 'scale' | 'blur';

  // High contrast mode
  highContrast: boolean;

  // Bubble shape
  bubbleShape: 'circle' | 'rounded' | 'squircle' | 'hexagon';

  // Bubble visualization style
  bubbleVisual: 'ring' | 'bars' | 'pulse' | 'orb' | 'vrm';

  // Bubble animation style
  bubbleAnimation: 'none' | 'pulse' | 'rotate' | 'breathe';

  // Show VRM model inside bubble (when bubbleVisual !== 'vrm', this is ignored)
  showVRM: boolean;

  // Selected avatar ID for VRM in bubble
  bubbleAvatarId: string;

  // Bubble size
  bubbleSize: 'sm' | 'md' | 'lg';
}

const DEFAULT_SETTINGS: BubbleSettings = {
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

const VALID_FONTS = new Set(['inter', 'jetbrains', 'fira', 'space', 'outfit', 'dm', 'sora', 'manrope', 'jakarta', 'roboto-mono', 'source-code', 'bebas']);
const VALID_SIZES = new Set(['xs', 'sm', 'md', 'lg']);
const VALID_SHADOWS = new Set(['none', 'soft', 'medium', 'strong', 'raised', 'glow']);
const VALID_BGS = new Set(['none', 'solid', 'blur', 'gradient', 'accent']);
const VALID_ANIMS = new Set(['none', 'fade', 'slide', 'scale', 'blur']);
const VALID_SHAPES = new Set(['circle', 'rounded', 'squircle', 'hexagon']);
const VALID_VISUALS = new Set(['ring', 'bars', 'pulse', 'orb', 'vrm']);
const VALID_BUBBLE_ANIMS = new Set(['none', 'pulse', 'rotate', 'breathe']);
const VALID_BUBBLE_SIZES = new Set(['sm', 'md', 'lg']);

export function getBubbleSettings(): BubbleSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BubbleSettings>;

    return {
      captionFont: VALID_FONTS.has(parsed.captionFont ?? '') ? parsed.captionFont! : DEFAULT_SETTINGS.captionFont,
      captionSize: VALID_SIZES.has(parsed.captionSize ?? '') ? parsed.captionSize! : DEFAULT_SETTINGS.captionSize,
      captionShadow: VALID_SHADOWS.has(parsed.captionShadow ?? '') ? parsed.captionShadow! : DEFAULT_SETTINGS.captionShadow,
      captionBg: VALID_BGS.has(parsed.captionBg ?? '') ? parsed.captionBg! : DEFAULT_SETTINGS.captionBg,
      captionAnimation: VALID_ANIMS.has(parsed.captionAnimation ?? '') ? parsed.captionAnimation! : DEFAULT_SETTINGS.captionAnimation,
      highContrast: typeof parsed.highContrast === 'boolean' ? parsed.highContrast : DEFAULT_SETTINGS.highContrast,
      bubbleShape: VALID_SHAPES.has(parsed.bubbleShape ?? '') ? parsed.bubbleShape! : DEFAULT_SETTINGS.bubbleShape,
      bubbleVisual: VALID_VISUALS.has(parsed.bubbleVisual ?? '') ? parsed.bubbleVisual! : DEFAULT_SETTINGS.bubbleVisual,
      bubbleAnimation: VALID_BUBBLE_ANIMS.has(parsed.bubbleAnimation ?? '') ? parsed.bubbleAnimation! : DEFAULT_SETTINGS.bubbleAnimation,
      showVRM: typeof parsed.showVRM === 'boolean' ? parsed.showVRM : DEFAULT_SETTINGS.showVRM,
      bubbleAvatarId: typeof parsed.bubbleAvatarId === 'string' ? parsed.bubbleAvatarId : DEFAULT_SETTINGS.bubbleAvatarId,
      bubbleSize: VALID_BUBBLE_SIZES.has(parsed.bubbleSize ?? '') ? parsed.bubbleSize! : DEFAULT_SETTINGS.bubbleSize,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setBubbleSettings(updates: Partial<BubbleSettings>): BubbleSettings {
  const current = getBubbleSettings();
  const next: BubbleSettings = { ...current };

  if (updates.captionFont !== undefined && VALID_FONTS.has(updates.captionFont)) next.captionFont = updates.captionFont;
  if (updates.captionSize !== undefined && VALID_SIZES.has(updates.captionSize)) next.captionSize = updates.captionSize;
  if (updates.captionShadow !== undefined && VALID_SHADOWS.has(updates.captionShadow)) next.captionShadow = updates.captionShadow;
  if (updates.captionBg !== undefined && VALID_BGS.has(updates.captionBg)) next.captionBg = updates.captionBg;
  if (updates.captionAnimation !== undefined && VALID_ANIMS.has(updates.captionAnimation)) next.captionAnimation = updates.captionAnimation;
  if (typeof updates.highContrast === 'boolean') next.highContrast = updates.highContrast;
  if (updates.bubbleShape !== undefined && VALID_SHAPES.has(updates.bubbleShape)) next.bubbleShape = updates.bubbleShape;
  if (updates.bubbleVisual !== undefined && VALID_VISUALS.has(updates.bubbleVisual)) next.bubbleVisual = updates.bubbleVisual;
  if (updates.bubbleAnimation !== undefined && VALID_BUBBLE_ANIMS.has(updates.bubbleAnimation)) next.bubbleAnimation = updates.bubbleAnimation;
  if (typeof updates.showVRM === 'boolean') next.showVRM = updates.showVRM;
  if (typeof updates.bubbleAvatarId === 'string') next.bubbleAvatarId = updates.bubbleAvatarId;
  if (updates.bubbleSize !== undefined && VALID_BUBBLE_SIZES.has(updates.bubbleSize)) next.bubbleSize = updates.bubbleSize;

  try {
    const dir = dirname(SETTINGS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch {}

  return next;
}

// Font display names for the UI
export const FONT_OPTIONS: Array<{ id: string; label: string; cssClass: string; preview: string }> = [
  { id: 'inter', label: 'Inter', cssClass: 'caption-font-inter', preview: 'The quick brown fox' },
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
  { id: 'bebas', label: 'Bebas Neue', cssClass: 'caption-font-bebas', preview: 'BOLD & TALL' },
];
