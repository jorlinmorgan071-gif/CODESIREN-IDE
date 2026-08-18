import { useMemo } from 'react';
import { resolveAvatarCompatibility, type ResolvedAvatarCompatibility } from '@/lib/avatar-compatibility';

// Resolution is memoized per model URL. Presentation components consume this
// hook rather than reimplementing name or URL checks in render/frame loops.
export function useAvatarCompatibility(avatarUrl: string): ResolvedAvatarCompatibility {
  return useMemo(() => resolveAvatarCompatibility(avatarUrl), [avatarUrl]);
}
