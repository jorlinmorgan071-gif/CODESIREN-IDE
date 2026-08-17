import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_LOCAL_VRM_BYTES,
  createLocalVrmSession,
  revokeLocalVrmSession,
  validateLocalVrmFile,
} from '../src/lib/local-vrm-session';

describe('session-only local VRM selection', () => {
  const createObjectURL = vi.fn(() => 'blob:local-vrm');
  const revokeObjectURL = vi.fn();

  afterEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.unstubAllGlobals();
  });

  it('accepts a bounded .vrm file and only creates a browser-local object URL', () => {
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const file = new File(['avatar'], 'local-avatar.vrm', { type: 'model/gltf-binary' });
    const session = createLocalVrmSession(file);

    expect(session.url).toBe('blob:local-vrm');
    expect(session.fileName).toBe('local-avatar.vrm');
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });

  it('rejects non-VRM, empty, and oversized local selections before loading', () => {
    expect(validateLocalVrmFile({ name: 'avatar.glb', size: 1 })).toContain('VRM');
    expect(validateLocalVrmFile({ name: 'avatar.vrm', size: 0 })).toContain('empty');
    expect(validateLocalVrmFile({ name: 'avatar.vrm', size: MAX_LOCAL_VRM_BYTES + 1 })).toContain('100 MiB');
  });

  it('releases a local object URL when the session model is removed', () => {
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    revokeLocalVrmSession({ url: 'blob:local-vrm', fileName: 'local-avatar.vrm', sizeBytes: 1 });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-vrm');
  });
});

