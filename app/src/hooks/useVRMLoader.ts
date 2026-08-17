// app/src/hooks/useVRMLoader.ts
//
// Shared VRM loading hook — used by FaceView's VRMModel, AvatarOverlay's
// PipVRMModel, and InteractionBubble's VRMBubbleContent.
//
// Extracts the 4 genuinely-shared operations that were previously duplicated
// (and drifted) across all three contexts:
//   1. useLoader(GLTFLoader, avatarUrl, VRMLoaderPlugin)
//   2. Disposal with currentUrlRef fix (stale-closure bug fixed here once)
//   3. VRMUtils.removeUnnecessaryVertices + VRMUtils.rotateVRM0 (orientation
//      fix applied here once — was missing from PIP + Bubble)
//   4. Shadow setup (castShadow + receiveShadow traverse)
//
// What stays in each caller:
//   - useFrame animation loop (context-specific audio/emotion wiring)
//   - Lip-sync profile fetch + node creation (context-specific audio source)
//   - JSX: <Canvas>, lights, <Suspense>, error boundary, OrbitControls, blob shadow
//   - EMOTION_BLENDSHAPES mapping (small, slight per-context variations)
//
// onLoaded callback: optional. FaceView uses it to clear the loading spinner
// on avatar switch. PIP and Bubble don't pass it (they use <Suspense fallback>
// for loading state, no spinner to clear).

import { useRef, useEffect } from 'react';
import { useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { applyAvatarCompatibilityProfile } from '@/lib/avatar-compatibility-runtime';
import type { ResolvedAvatarCompatibility } from '@/lib/avatar-compatibility';

export interface UseVRMLoaderResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- THREE.GLTF type isn't exported from @types/three; the gltf result has .scene + .userData
  gltf: any;
  vrm: VRM | undefined;
  groupRef: React.RefObject<THREE.Group>;
}

export function useVRMLoader(
  avatarUrl: string,
  compatibility: ResolvedAvatarCompatibility,
  onLoaded?: () => void,
): UseVRMLoaderResult {
  // 1. Load VRM model via GLTFLoader with VRMLoaderPlugin
  const gltf = useLoader(GLTFLoader, avatarUrl, (loader: GLTFLoader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  });

  // 2. Disposal — leak-free switching with currentUrlRef fix.
  // The ref is updated DURING RENDER (not in a useEffect) because useLoader
  // suspends during render when the URL changes. If we used a useEffect to
  // update the ref, the effect would never run before the cleanup fires.
  const prevGltfRef = useRef<{ scene: THREE.Group; url: string } | null>(null);
  const currentUrlRef = useRef(avatarUrl);
  // eslint-disable-next-line react-hooks/refs -- intentional: ref must be current by the time disposal cleanup fires. useLoader suspends during render when avatarUrl changes, so a useEffect-based update would never run before the cleanup.
  currentUrlRef.current = avatarUrl;

  useEffect(() => {
    return () => {
      if (prevGltfRef.current && prevGltfRef.current.url !== currentUrlRef.current) {
        try {
          VRMUtils.deepDispose(prevGltfRef.current.scene);
        } catch {
          // deepDispose may fail if already disposed
        }
        try {
          useLoader.clear(GLTFLoader, prevGltfRef.current.url);
        } catch {
          // cache entry may already be removed
        }
      }
    };
  }, [avatarUrl]);

  useEffect(() => {
    if (gltf?.scene) {
      prevGltfRef.current = { scene: gltf.scene, url: avatarUrl };
    }
  }, [gltf, avatarUrl]);

  // 3. Load-time setup: removeUnnecessaryVertices + rotateVRM0 + shadows
  const groupRef = useRef<THREE.Group>(null!);

  useEffect(() => {
    if (!gltf) return;
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) return;

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.rotateVRM0(vrm);

    applyAvatarCompatibilityProfile(vrm, gltf.scene, compatibility.profile);

    onLoaded?.();
  }, [compatibility.profile, gltf, onLoaded]);

  return {
    gltf,
    vrm: gltf?.userData?.vrm as VRM | undefined,
    groupRef,
  };
}
