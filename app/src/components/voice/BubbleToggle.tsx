// app/src/components/voice/BubbleToggle.tsx
// Phase B: Lightweight toggle button for the interaction bubble.
// Split from InteractionBubble.tsx so it doesn't require heavy imports
// (Three.js, VRM, wlipsync) to render. The heavy InteractionBubble
// is lazy-loaded only when the user clicks this toggle.

import { Mic } from 'lucide-react';

interface BubbleToggleProps {
  onClick: () => void;
}

export function BubbleToggle({ onClick }: BubbleToggleProps) {
  return (
    <button
      data-testid="interaction-bubble-toggle"
      onClick={onClick}
      className="fixed bottom-4 right-28 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110 z-40"
      style={{
        backgroundColor: 'rgba(14, 14, 20, 0.8)',
        border: '1px solid var(--border-subtle)',
        backdropFilter: 'blur(8px)',
        color: 'var(--steel-silver)',
      }}
      title="Show interaction bubble"
    >
      <Mic className="w-4 h-4" />
    </button>
  );
}
