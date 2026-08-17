import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAvatarRuntimeLoaderUrl } from '../src/hooks/useVRMLoader';

describe('Phase 4 avatar runtime lifecycle isolation', () => {
  it('creates one distinct loader cache key for every presentation context', () => {
    const avatarUrl = '/models/avatars/default/model.vrm';
    const keys = new Set([
      createAvatarRuntimeLoaderUrl(avatarUrl, 'face'),
      createAvatarRuntimeLoaderUrl(avatarUrl, 'pip'),
      createAvatarRuntimeLoaderUrl(avatarUrl, 'bubble'),
    ]);

    expect(keys).toEqual(new Set([
      '/models/avatars/default/model.vrm#codesiren-runtime=face',
      '/models/avatars/default/model.vrm#codesiren-runtime=pip',
      '/models/avatars/default/model.vrm#codesiren-runtime=bubble',
    ]));
  });

  it('preserves an existing fragment while appending the scoped cache discriminator', () => {
    expect(createAvatarRuntimeLoaderUrl('blob:https://codesiren.test/session#model', 'bubble'))
      .toBe('blob:https://codesiren.test/session#model&codesiren-runtime=bubble');
  });

  it('uses a distinct context key in every presentation runtime', () => {
    const face = readFileSync(join(process.cwd(), 'src/pages/FaceView.tsx'), 'utf8');
    const pip = readFileSync(join(process.cwd(), 'src/components/avatar/AvatarOverlay.tsx'), 'utf8');
    const bubble = readFileSync(join(process.cwd(), 'src/components/voice/InteractionBubble.tsx'), 'utf8');

    expect(face).toContain("useVRMLoader(avatarUrl, compatibility, 'face', onLoaded)");
    expect(pip).toContain("useVRMLoader(avatarUrl, compatibility, 'pip')");
    expect(bubble).toContain("useVRMLoader(avatarUrl, compatibility, 'bubble')");
  });

  it('cancels pending lip-sync creation and disconnects only its own connected node in every context', () => {
    const sources = [
      readFileSync(join(process.cwd(), 'src/pages/FaceView.tsx'), 'utf8'),
      readFileSync(join(process.cwd(), 'src/components/avatar/AvatarOverlay.tsx'), 'utf8'),
      readFileSync(join(process.cwd(), 'src/components/voice/InteractionBubble.tsx'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain('let cancelled = false;');
      expect(source).toContain('let connectedNode: WLipSyncAudioNode | null = null;');
      expect(source).toContain('if (cancelled) return;');
      expect(source).toContain('if (lipSyncNodeRef.current === connectedNode) lipSyncNodeRef.current = null;');
    }
  });
});
