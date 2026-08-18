import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const wsHarness = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown) => void>();
  return { handlers };
});

vi.mock('../src/lib/ws', () => ({
  wsClient: {
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      wsHarness.handlers.set(event, handler);
      return () => wsHarness.handlers.delete(event);
    }),
    send: vi.fn(),
  },
}));

vi.mock('../src/lib/auth', () => ({ getToken: () => 'test-token' }));

import { VoiceSessionProvider, useVoiceSession } from '../src/store/VoiceSessionContext';

class FakeAnalyser {
  fftSize = 0;
  smoothingTimeConstant = 0;
  frequencyBinCount = 16;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteFrequencyData = vi.fn((buffer: Uint8Array) => buffer.fill(0));
}

class FakeAudioContext {
  analyser = new FakeAnalyser();
  close = vi.fn(async () => undefined);
  createAnalyser = vi.fn(() => this.analyser);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('VoiceSessionContext shutdown ownership', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let session: ReturnType<typeof useVoiceSession> | null = null;

  function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    function Probe() {
      const currentSession = useVoiceSession();
      useEffect(() => { session = currentSession; }, [currentSession]);
      return null;
    }
    act(() => root!.render(createElement(VoiceSessionProvider, null, createElement(Probe))));
  }

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    session = null;
    wsHarness.handlers.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects a late session A event immediately after STOP begins', async () => {
    const remoteEnd = deferred<Response>();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('fetch', vi.fn(() => remoteEnd.promise));
    mount();

    await act(async () => { session!.startSession('voice-a'); });
    const stop = session!.endVoiceSession();
    await act(async () => {
      wsHarness.handlers.get('voice:agent-response')?.({ payload: { sessionId: 'voice-a', text: 'late A', audioBase64: null } });
    });
    expect(session!.captions.agent).toBe('');

    remoteEnd.resolve({} as Response);
    await act(async () => { await stop; });
  });

  it('keeps session B authoritative when A completes after STOP → START', async () => {
    const remoteEnd = deferred<Response>();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('fetch', vi.fn(() => remoteEnd.promise));
    mount();

    await act(async () => { session!.startSession('voice-a'); });
    const stopA = session!.endVoiceSession();
    await act(async () => { session!.startSession('voice-b'); });
    await act(async () => {
      wsHarness.handlers.get('voice:agent-response')?.({ payload: { sessionId: 'voice-a', text: 'late A', audioBase64: null } });
    });
    expect(session!.sessionId).toBe('voice-b');
    expect(session!.captions.agent).toBe('');

    remoteEnd.resolve({} as Response);
    await act(async () => { await stopA; });
    expect(session!.sessionId).toBe('voice-b');
  });

  it('releases owned audio resources and requests remote termination when an active provider unmounts', async () => {
    const audioContext = new FakeAudioContext();
    const source = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
    const AudioContextConstructor = function () { return audioContext; } as unknown as typeof AudioContext;
    vi.stubGlobal('AudioContext', AudioContextConstructor);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const fetchMock = vi.fn(async () => ({} as Response));
    vi.stubGlobal('fetch', fetchMock);
    mount();

    await act(async () => { session!.startSession('voice-a'); });
    await act(async () => { session!.setAudioSource(source); });
    act(() => root!.unmount());
    root = null;

    expect(source.disconnect).toHaveBeenCalled();
    expect(audioContext.close).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/voice/live/voice-a/end'), expect.any(Object));
  });
});
