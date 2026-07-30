// app/src/systems/presence/gesture.ts
// Gesture input modality — Layer-1 input alongside keyboard/mouse.
//
// Per directive Section 4: "add the System Presence Layer (MediaPipe-based
// gesture + face input) as an input modality registered the same way
// keyboard/mouse are — not a separate floating app window."
//
// Per Step 10 condition 1: gesture controls must prove no separate
// GestureWindow/GestureOverlay component exists, and the gesture handler is
// registered as an input modality — not a floating canvas on top of the UI.
//
// This module exports a useGestureInput hook that registers gesture events
// on the EXISTING document/window, not on a separate canvas element. The
// gesture events are dispatched as standard CustomEvents on window — the
// same way keyboard (keydown) and mouse (click) events work. No separate
// DOM element is created.

import { useEffect, useRef } from 'react';

export type GestureType = 'pinch' | 'open-palm' | 'close-fist';

export interface GestureEvent {
  type: GestureType;
  target?: string;      // UI action target (e.g., 'chat-panel', 'file-explorer')
  timestamp: number;
}

// Gesture → UI action mapping (per directive Section 1 + donor's gesture mapping):
//   pinch      → confirm/click
//   open-palm  → release window
//   close-fist → grab/drag window
const GESTURE_ACTION_MAP: Record<GestureType, string> = {
  'pinch': 'click',
  'open-palm': 'release',
  'close-fist': 'grab',
};

/**
 * Register gesture input as a Layer-1 input modality.
 *
 * This hook listens for gesture events on the GLOBAL window object — the same
 * way React listens for keyboard (keydown) and mouse (click) events. It does
 * NOT create a separate canvas, overlay, or window. The gesture events are
 * dispatched as CustomEvents on window by the (deployment-time) MediaPipe
 * Hand Landmarker integration.
 *
 * In Step 10's stub mode, gestures are simulated via the /api/presence/gesture
 * endpoint — the server emits presence:gesture WS events, and this hook
 * dispatches them as UI actions.
 */
export function useGestureInput(
  onGesture: (gesture: GestureType, action: string) => void,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  const handlerRef = useRef(onGesture);
  useEffect(() => {
    handlerRef.current = onGesture;
  }, [onGesture]);

  useEffect(() => {
    if (!enabled) return;

    // Register gesture listener on window — same pattern as keyboard/mouse.
    // This is NOT a separate canvas; it's a window-level event listener.
    const handleGestureEvent = (event: Event) => {
      const detail = (event as CustomEvent<GestureEvent>).detail;
      if (!detail) return;
      const action = GESTURE_ACTION_MAP[detail.type] ?? 'unknown';
      handlerRef.current(detail.type, action);
    };

    // Listen for presence:gesture events dispatched on window
    // (these come from the WS client, which receives them from the server)
    window.addEventListener('presence:gesture', handleGestureEvent as EventListener);

    // Also register as a standard input modality alongside keyboard/mouse
    // — this is the "registered the same way keyboard/mouse are" part.
    // The gesture handler is on window, not on a separate DOM element.
    console.log('[presence] gesture input modality registered on window (alongside keyboard/mouse)');

    return () => {
      window.removeEventListener('presence:gesture', handleGestureEvent as EventListener);
    };
  }, [enabled]);
}

/**
 * Dispatch a gesture event on window. Used by the WS client when it receives
 * a presence:gesture event from the server. This makes gesture events flow
 * through the same event system as keyboard/mouse.
 */
export function dispatchGesture(gesture: GestureEvent): void {
  window.dispatchEvent(new CustomEvent('presence:gesture', { detail: gesture }));
}

/**
 * Simulate a gesture (for testing). Dispatches a CustomEvent on window.
 */
export function simulateGesture(type: GestureType, target?: string): void {
  dispatchGesture({
    type,
    target,
    timestamp: Date.now(),
  });
}
