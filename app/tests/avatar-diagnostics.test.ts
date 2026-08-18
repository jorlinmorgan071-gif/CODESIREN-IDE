// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyAvatarDiagnosticWarning,
  classifyAvatarDiagnosticsSeverity,
  displayAvatarDiagnosticsUrl,
} from '@/lib/avatar-diagnostics-view';
import { resolveAvatarCompatibility, type AvatarCapabilities, type AvatarCompatibilityDiagnostics } from '@/lib/avatar-compatibility';
import { useAvatarDiagnosticsSnapshot, type AvatarDiagnosticsRuntimeState, type AvatarDiagnosticsViewSnapshot } from '@/hooks/useAvatarDiagnosticsSnapshot';
import { AvatarDiagnosticsPanel } from '@/components/avatar/AvatarDiagnosticsPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capabilities: AvatarCapabilities = {
  vrmVersion: '1.0', hasHumanoid: true, expressionManagerAvailable: true,
  expressionNames: ['blink', 'happy', 'aa', 'ih', 'ou', 'ee', 'oh'], hasLookAt: true,
  hasSpringBones: true, springBoneCount: 4, colliderCount: 2, vrmaCompatible: true,
  lipSyncCompatible: true, warnings: [],
};

function diagnostics(overrides: Partial<AvatarCompatibilityDiagnostics> = {}): AvatarCompatibilityDiagnostics {
  return {
    avatarUrl: '/models/avatars/default/model.vrm', requestedModelId: 'default', resolvedProfileId: 'default', profileSource: 'exact',
    vrmVersion: '1.0', humanoid: true, expressionCount: 7, expressionAliases: { blink: 'blink', happy: 'happy', mouthA: 'aa' },
    gaze: true, springBoneCount: 4, colliderCount: 2, vrmaCompatible: true, activeAnimation: null, currentMotionState: 'idle',
    vrmaMappings: [], proceduralFallback: false, warnings: [], ...overrides,
  };
}

function snapshot(overrides: Partial<AvatarCompatibilityDiagnostics> = {}): AvatarDiagnosticsViewSnapshot {
  return { context: 'face', capturedAtMs: 1_700_000_000_000, diagnostics: diagnostics(overrides) };
}

describe('Phase 3 avatar diagnostics view model', () => {
  it('classifies exact, safe fallback, and attention states deterministically', () => {
    expect(classifyAvatarDiagnosticsSeverity(diagnostics())).toBe('healthy');
    expect(classifyAvatarDiagnosticsSeverity(diagnostics({ profileSource: 'default-fallback' }))).toBe('notice');
    expect(classifyAvatarDiagnosticsSeverity(diagnostics({ profileSource: 'unknown-fallback' }))).toBe('attention');
    expect(classifyAvatarDiagnosticsSeverity(diagnostics({ expressionCount: 0 }))).toBe('attention');
    expect(classifyAvatarDiagnosticsSeverity(diagnostics({ currentMotionState: 'speaking', vrmaMappings: ['speaking'], proceduralFallback: true }))).toBe('attention');
  });

  it('keeps safe capability limits as notices and classifies only actionable warnings as attention', () => {
    const noGaze = diagnostics({ gaze: false });
    expect(classifyAvatarDiagnosticsSeverity(noGaze)).toBe('notice');
    expect(classifyAvatarDiagnosticWarning(noGaze, 'Look-at is unavailable; gaze is disabled safely.')).toBe('notice');
    expect(classifyAvatarDiagnosticWarning(diagnostics({ expressionCount: 0 }), 'Expression manager is unavailable; semantic expression writes are disabled.')).toBe('attention');
  });

  it('redacts blob URLs only for visual display and leaves normal URLs readable', () => {
    expect(displayAvatarDiagnosticsUrl('blob:secret-session-url')).toBe('blob:… (session-only)');
    expect(displayAvatarDiagnosticsUrl('/models/avatars/default/model.vrm')).toBe('/models/avatars/default/model.vrm');
  });

  it('renders the existing contract as a read-only diagnostics document', () => {
    const markup = renderToStaticMarkup(createElement(AvatarDiagnosticsPanel, { snapshot: snapshot({ warnings: ['No spring-bone joints were detected.'] }), onClose: () => {}, onRefresh: () => {} }));
    expect(markup).toContain('Runtime capabilities');
    expect(markup).toContain('Expression mapping');
    expect(markup).toContain('Motion and VRMA');
    expect(markup).toContain('Compatibility notices');
    expect(markup).toContain('Read-only runtime information');
    expect(markup).toContain('No spring-bone joints were detected.');
  });
});

describe('useAvatarDiagnosticsSnapshot refresh lifecycle', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
  });

  function Harness({ open, refreshToken, runtime, onSnapshot }: { open: boolean; refreshToken: number; runtime: { current: AvatarDiagnosticsRuntimeState }; onSnapshot: (value: AvatarDiagnosticsViewSnapshot | null) => void }) {
    const getRuntimeState = () => runtime.current;
    const result = useAvatarDiagnosticsSnapshot({
      context: 'face', compatibility: resolveAvatarCompatibility('/models/avatars/default/model.vrm'), capabilities,
      animationRegistry: {}, getRuntimeState, isOpen: open, refreshToken,
    });
    useEffect(() => onSnapshot(result.snapshot), [onSnapshot, result.snapshot]);
    return null;
  }

  it('captures only when open, refreshes on the approved one-second cadence, and uses the existing factory inputs', () => {
    vi.useFakeTimers();
    const runtime = { current: { currentMotionState: 'idle' as const, activeAnimation: null, proceduralFallback: true } };
    let latest: AvatarDiagnosticsViewSnapshot | null = null;
    const onSnapshot = (value: AvatarDiagnosticsViewSnapshot | null) => { latest = value; };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(createElement(Harness, { open: false, refreshToken: 0, runtime, onSnapshot })));
    act(() => vi.advanceTimersByTime(1_100));
    expect(latest).toBeNull();

    act(() => root?.render(createElement(Harness, { open: true, refreshToken: 0, runtime, onSnapshot })));
    act(() => vi.advanceTimersByTime(0));
    expect(latest?.diagnostics.currentMotionState).toBe('idle');
    expect(latest?.diagnostics.proceduralFallback).toBe(true);

    runtime.current = { currentMotionState: 'speaking', activeAnimation: 'speaking', proceduralFallback: false };
    act(() => vi.advanceTimersByTime(1_000));
    expect(latest?.diagnostics.currentMotionState).toBe('speaking');
    expect(latest?.diagnostics.activeAnimation).toBe('speaking');
    expect(latest?.diagnostics.proceduralFallback).toBe(false);
  });
});

describe('Phase 3 integration and interaction safeguards', () => {
  const appRoot = resolve(import.meta.dirname, '..', 'src');

  it('keeps diagnostics creation out of R3F frame loops and supplies the shared local adapter in every presentation context', () => {
    const face = readFileSync(resolve(appRoot, 'pages/FaceView.tsx'), 'utf8');
    const pip = readFileSync(resolve(appRoot, 'components/avatar/AvatarOverlay.tsx'), 'utf8');
    const bubble = readFileSync(resolve(appRoot, 'components/voice/InteractionBubble.tsx'), 'utf8');
    for (const source of [face, pip, bubble]) {
      expect(source).toContain('useAvatarDiagnosticsSnapshot');
      expect(source).toContain('diagnosticsRuntimeRef.current');
      expect(source).not.toContain('createAvatarCompatibilityDiagnostics(');
    }
    expect(face).toContain('variant="drawer"');
    expect(pip).toContain('variant="sheet"');
    expect(bubble).toContain('variant="sheet"');
    expect(face).toContain('diagnosticsSnapshot?.diagnostics.avatarUrl === avatarUrl');
    expect(pip).toContain('diagnosticsSnapshot?.diagnostics.avatarUrl === avatarUrl');
    expect(bubble).toContain('diagnosticsSnapshot?.diagnostics.avatarUrl === bubbleAvatarUrl');
  });

  it('preserves PIP and Bubble interaction boundaries around the diagnostics triggers', () => {
    const pip = readFileSync(resolve(appRoot, 'components/avatar/AvatarOverlay.tsx'), 'utf8');
    const bubble = readFileSync(resolve(appRoot, 'components/voice/InteractionBubble.tsx'), 'utf8');
    expect(pip).toContain('onPointerDown={(event) => event.stopPropagation()}');
    expect(pip).toContain('onClick={onClose}');
    expect(bubble).toContain('if (didDragRef.current) return;');
    expect(bubble).toContain("CustomEvent('code-siren:open-bubble-settings')");
    expect(bubble).toContain('{expanded && (');
  });

  it('uses the built-in Sheet host for keyboard-dismissable responsive dialogs', () => {
    const host = readFileSync(resolve(appRoot, 'components/avatar/AvatarDiagnosticsSheetHost.tsx'), 'utf8');
    expect(host).toContain("from '@/components/ui/sheet'");
    expect(host).toContain("side={isDrawer ? 'right' : 'bottom'}");
    expect(host).toContain('onOpenChange={onOpenChange}');
  });
});
