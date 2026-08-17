// Phase 3 diagnostics adapter: captures the existing factory result outside
// R3F frame loops and samples only while a diagnostics surface is visible.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createAvatarCompatibilityDiagnostics,
  type AvatarCapabilities,
  type AvatarCompatibilityDiagnostics,
  type ResolvedAvatarCompatibility,
} from '@/lib/avatar-compatibility';
import type { AvatarMotionState } from '@/lib/avatar-motion';
import type { LocalVrmaRegistry } from '@/lib/local-vrma-session';

export type AvatarDiagnosticsContext = 'face' | 'pip' | 'bubble';

export interface AvatarDiagnosticsRuntimeState {
  currentMotionState: AvatarMotionState;
  activeAnimation: AvatarMotionState | null;
  proceduralFallback: boolean;
}

export interface AvatarDiagnosticsViewSnapshot {
  context: AvatarDiagnosticsContext;
  capturedAtMs: number;
  diagnostics: AvatarCompatibilityDiagnostics;
}

interface UseAvatarDiagnosticsSnapshotOptions {
  context: AvatarDiagnosticsContext;
  compatibility: ResolvedAvatarCompatibility;
  capabilities: AvatarCapabilities;
  animationRegistry: LocalVrmaRegistry;
  getRuntimeState: () => AvatarDiagnosticsRuntimeState;
  isOpen: boolean;
  refreshToken?: number;
}

export function useAvatarDiagnosticsSnapshot({
  context,
  compatibility,
  capabilities,
  animationRegistry,
  getRuntimeState,
  isOpen,
  refreshToken = 0,
}: UseAvatarDiagnosticsSnapshotOptions) {
  const [snapshot, setSnapshot] = useState<AvatarDiagnosticsViewSnapshot | null>(null);

  const refresh = useCallback(() => {
    const runtime = getRuntimeState();
    const diagnostics = createAvatarCompatibilityDiagnostics(
      compatibility,
      capabilities,
      runtime.currentMotionState,
      runtime.activeAnimation,
      animationRegistry,
      runtime.proceduralFallback,
    );
    const next = { context, capturedAtMs: Date.now(), diagnostics } as AvatarDiagnosticsViewSnapshot;
    setSnapshot(next);
    return next;
  }, [animationRegistry, capabilities, compatibility, context, getRuntimeState]);

  useEffect(() => {
    if (!isOpen) return;
    const initialCapture = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(initialCapture);
  }, [isOpen, refresh, refreshToken]);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (interval) clearInterval(interval);
      interval = null;
    };
    const start = () => {
      stop();
      if (document.visibilityState !== 'visible') return;
      interval = setInterval(refresh, 1000);
    };
    const onVisibilityChange = () => start();
    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isOpen, refresh]);

  return useMemo(() => ({ snapshot, refresh }), [refresh, snapshot]);
}
