import type { Theme, ThemeName } from '@/types';

export const themes: Record<ThemeName, Theme> = {
  'zero-two': {
    name: 'zero-two',
    label: 'Zero Two Dark',
    colors: {
      siren: '#EE1C1C',
      active: '#C41010',
      dim: '#6A0808',
      background: '#07070B',
      surface: '#0E0E14',
      raised: '#15151E',
      border: '#1E1E2A',
      text: '#C8C8DC',
      textSecondary: '#8A8AA0',
      textMuted: '#5A5A72',
      accent: '#EE1C1C',
    },
  },
  'cyber-neon': {
    name: 'cyber-neon',
    label: 'Cyber Neon',
    colors: {
      siren: '#00F0FF',
      active: '#00C8D6',
      dim: '#006B73',
      background: '#050508',
      surface: '#0A0A12',
      raised: '#10101A',
      border: '#181828',
      text: '#E0F8FF',
      textSecondary: '#7A9DA8',
      textMuted: '#4A5A62',
      accent: '#00F0FF',
    },
  },
  'midnight-blue': {
    name: 'midnight-blue',
    label: 'Midnight Blue',
    colors: {
      siren: '#4A90E2',
      active: '#3A78C2',
      dim: '#1E3A5F',
      background: '#060A12',
      surface: '#0C1220',
      raised: '#121A2E',
      border: '#1A2440',
      text: '#D4E4F7',
      textSecondary: '#7A8EA8',
      textMuted: '#4A5A72',
      accent: '#4A90E2',
    },
  },
  'aurora-purple': {
    name: 'aurora-purple',
    label: 'Aurora Purple',
    colors: {
      siren: '#B76CFD',
      active: '#9A4DE0',
      dim: '#5A2080',
      background: '#0A0612',
      surface: '#120C20',
      raised: '#1A122E',
      border: '#241A40',
      text: '#E8D8FF',
      textSecondary: '#9A88B8',
      textMuted: '#5A4A72',
      accent: '#B76CFD',
    },
  },
  'obsidian': {
    name: 'obsidian',
    label: 'Obsidian',
    colors: {
      siren: '#E0E0E0',
      active: '#C0C0C0',
      dim: '#606060',
      background: '#000000',
      surface: '#0A0A0A',
      raised: '#121212',
      border: '#1A1A1A',
      text: '#FFFFFF',
      textSecondary: '#888888',
      textMuted: '#555555',
      accent: '#FFFFFF',
    },
  },
  'hacker-green': {
    name: 'hacker-green',
    label: 'Hacker Green',
    colors: {
      siren: '#00FF41',
      active: '#00D636',
      dim: '#007A1F',
      background: '#020802',
      surface: '#061206',
      raised: '#0A1A0A',
      border: '#0E280E',
      text: '#E0FFE8',
      textSecondary: '#6AAD78',
      textMuted: '#3A6B42',
      accent: '#00FF41',
    },
  },
  'crimson-night': {
    name: 'crimson-night',
    label: 'Crimson Night',
    colors: {
      siren: '#FF6B8A',
      active: '#E05270',
      dim: '#802840',
      background: '#0F0206',
      surface: '#1A080C',
      raised: '#240E14',
      border: '#32141E',
      text: '#FFE8EE',
      textSecondary: '#B88898',
      textMuted: '#784858',
      accent: '#FF6B8A',
    },
  },
  'solar-eclipse': {
    name: 'solar-eclipse',
    label: 'Solar Eclipse',
    colors: {
      siren: '#FFB627',
      active: '#E09E1A',
      dim: '#805A0C',
      background: '#0C0802',
      surface: '#181208',
      raised: '#221A0C',
      border: '#302610',
      text: '#FFF0D4',
      textSecondary: '#B8A078',
      textMuted: '#786848',
      accent: '#FFB627',
    },
  },
  'arctic-dark': {
    name: 'arctic-dark',
    label: 'Arctic Dark',
    colors: {
      siren: '#A8D8FF',
      active: '#88B8E0',
      dim: '#406880',
      background: '#060A10',
      surface: '#0C1420',
      raised: '#121C2E',
      border: '#1A283E',
      text: '#E0F0FF',
      textSecondary: '#88A0B8',
      textMuted: '#4A6078',
      accent: '#A8D8FF',
    },
  },
  'dracula-evolution': {
    name: 'dracula-evolution',
    label: 'Dracula Evolution',
    colors: {
      siren: '#FF79C6',
      active: '#E05DA8',
      dim: '#803868',
      background: '#0B0A10',
      surface: '#151320',
      raised: '#1E1C2E',
      border: '#28263E',
      text: '#F8F8F2',
      textSecondary: '#A8A4C0',
      textMuted: '#686480',
      accent: '#FF79C6',
    },
  },
};

export const defaultTheme: ThemeName = 'zero-two';

export function applyTheme(themeName: ThemeName): void {
  const theme = themes[themeName];
  if (!theme) return;

  const root = document.documentElement;
  root.style.setProperty('--siren-red', theme.colors.siren);
  root.style.setProperty('--active-red', theme.colors.active);
  root.style.setProperty('--dim-red', theme.colors.dim);
  root.style.setProperty('--void-black', theme.colors.background);
  root.style.setProperty('--surface-dark', theme.colors.surface);
  root.style.setProperty('--surface-raised', theme.colors.raised);
  root.style.setProperty('--border-subtle', theme.colors.border);
  root.style.setProperty('--bright-silver', theme.colors.text);
  root.style.setProperty('--steel-silver', theme.colors.textSecondary);
  root.style.setProperty('--muted-silver', theme.colors.textMuted);
}
