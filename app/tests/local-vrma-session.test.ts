import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_LOCAL_VRMA_BYTES,
  createLocalVrmaSession,
  revokeLocalVrmaSession,
  validateLocalVrmaFile,
} from '../src/lib/local-vrma-session';
import { shouldUseProceduralMotion } from '../src/lib/vrma-player';

describe('session-only VRMA selection', () => {
  const createObjectURL = vi.fn(() => 'blob:local-vrma');
  const revokeObjectURL = vi.fn();

  afterEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.unstubAllGlobals();
  });

  it('creates a browser-local VRMA session with an explicit target state', () => {
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const file = new File(['motion'], 'idle.vrma', { type: 'model/gltf-binary' });
    const session = createLocalVrmaSession(file, 'idle');

    expect(session).toMatchObject({ url: 'blob:local-vrma', fileName: 'idle.vrma', targetState: 'idle' });
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });

  it('rejects invalid, empty, and oversized motion files before loading', () => {
    expect(validateLocalVrmaFile({ name: 'idle.vrm', size: 1 })).toContain('VRM Animation');
    expect(validateLocalVrmaFile({ name: 'idle.vrma', size: 0 })).toContain('empty');
    expect(validateLocalVrmaFile({ name: 'idle.vrma', size: MAX_LOCAL_VRMA_BYTES + 1 })).toContain('25 MiB');
  });

  it('releases a session object URL when the local animation is removed', () => {
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    revokeLocalVrmaSession({ url: 'blob:local-vrma', fileName: 'idle.vrma', sizeBytes: 1, targetState: 'idle' });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-vrma');
  });

  it('keeps procedural motion active until a clip exists for the current state', () => {
    const loadedStates = new Set(['idle'] as const);
    expect(shouldUseProceduralMotion('idle', loadedStates)).toBe(false);
    expect(shouldUseProceduralMotion('thinking', loadedStates)).toBe(true);
  });
});

