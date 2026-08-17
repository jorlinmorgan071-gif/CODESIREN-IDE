import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AvatarRuntimeErrorBoundary } from '../src/components/avatar/AvatarRuntimeErrorBoundary';
import { LocalVrmaPlayer } from '../src/lib/vrma-player';
import {
  canAttachLipSyncNode,
  isCurrentAudioNode,
  LatestOperationGate,
} from '../src/lib/runtime-coordination';

vi.mock('@pixiv/three-vrm-animation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pixiv/three-vrm-animation')>();
  return {
    ...actual,
    createVRMAnimationClip: vi.fn((animation: { name: string; duration: number }) =>
      new THREE.AnimationClip(animation.name, animation.duration, []),
    ),
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function vrmaGltf(name: string) {
  return { userData: { vrmAnimations: [{ name, duration: 1.25 }] } } as never;
}

describe('Phase 5 runtime coordination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps VRMA B installed when stale load A resolves after B', async () => {
    const loads = new Map<string, Deferred<ReturnType<typeof vrmaGltf>>>([
      ['blob:a', deferred()],
      ['blob:b', deferred()],
    ]);
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation((url: string) => loads.get(url)!.promise);
    const vrm = { scene: new THREE.Group(), lookAt: null } as never;
    const player = new LocalVrmaPlayer(vrm);
    const sessionA = { id: 'a', name: 'A', targetState: 'idle' as const, url: 'blob:a', createdAt: 1 };
    const sessionB = { id: 'b', name: 'B', targetState: 'idle' as const, url: 'blob:b', createdAt: 2 };

    const syncA = player.sync([sessionA]);
    const syncB = player.sync([sessionB]);
    loads.get('blob:b')!.resolve(vrmaGltf('B'));
    await syncB;
    loads.get('blob:a')!.resolve(vrmaGltf('A'));
    await syncA;

    const installed = (player as unknown as { actions: Map<string, THREE.AnimationAction> }).actions.get('idle');
    expect(installed?.getClip().name).toBe('B');
    player.dispose();
  });

  it('recovers a presentation-local boundary from invalid A when identity changes to valid B', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const Thrower = ({ fail }: { fail: boolean }) => {
      if (fail) throw new Error('invalid avatar');
      return createElement('span', null, 'valid avatar B');
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => root.render(createElement(
      AvatarRuntimeErrorBoundary,
      { avatarIdentity: 'A' },
      createElement(Thrower, { fail: true }),
    )));
    expect(container.textContent).toBe('');

    act(() => root.render(createElement(
      AvatarRuntimeErrorBoundary,
      { avatarIdentity: 'B' },
      createElement(Thrower, { fail: false }),
    )));
    expect(container.textContent).toBe('valid avatar B');

    root.unmount();
    container.remove();
    errorSpy.mockRestore();
  });

  it('lets only the latest avatar-selection completion apply', () => {
    const gate = new LatestOperationGate();
    let activeAvatar = 'default';
    const selectionA = gate.begin();
    const selectionB = gate.begin();
    if (gate.isCurrent(selectionB)) activeAvatar = 'B';
    if (gate.isCurrent(selectionA)) activeAvatar = 'A';
    expect(activeAvatar).toBe('B');
  });

  it('attaches lip sync when a profile becomes available for an already-active source', () => {
    const source = {} as AudioNode;
    const context = {} as AudioContext;
    expect(canAttachLipSyncNode(source, context, null)).toBe(false);
    expect(canAttachLipSyncNode(source, context, { mfccs: [] })).toBe(true);
  });

  it('does not clear current source B when stale TTS source A finishes', () => {
    const sourceA = {} as AudioNode;
    const sourceB = {} as AudioNode;
    let current: AudioNode | null = sourceB;
    if (isCurrentAudioNode(current, sourceA)) current = null;
    expect(current).toBe(sourceB);
  });

  it('keeps Bubble operation B authoritative when stale operation A completes', () => {
    const gate = new LatestOperationGate();
    let mode = 'idle';
    const operationA = gate.begin();
    const operationB = gate.begin();
    if (gate.isCurrent(operationB)) mode = 'voice-call';
    if (gate.isCurrent(operationA)) mode = 'idle';
    expect(mode).toBe('voice-call');
  });

  it('prevents an obsolete voice startup path from cleaning or replacing the newer session', () => {
    const gate = new LatestOperationGate();
    let activeSession = 'none';
    const startA = gate.begin();
    const startB = gate.begin();
    if (gate.isCurrent(startB)) activeSession = 'B';
    if (gate.isCurrent(startA)) activeSession = 'A-failure-cleanup';
    expect(activeSession).toBe('B');
  });
});
