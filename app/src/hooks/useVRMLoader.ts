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

export interface UseVRMLoaderResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- THREE.GLTF type isn't exported from @types/three; the gltf result has .scene + .userData
  gltf: any;
  vrm: VRM | undefined;
  groupRef: React.RefObject<THREE.Group>;
}

export function useVRMLoader(avatarUrl: string, onLoaded?: () => void): UseVRMLoaderResult {
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

    // ── Idle pose correction: rotate arms down from T-pose ──
    // VRM models load in T-pose (arms horizontal). Rotate upper arms down
    // to a relaxed resting pose (arms at sides, slightly out). Also apply
    // a slight shoulder raise and very subtle spine lean for natural posture.
    const humanoid = vrm.humanoid;
    if (humanoid) {
      const lArm = humanoid.getNormalizedBoneNode('leftUpperArm');
      const rArm = humanoid.getNormalizedBoneNode('rightUpperArm');
      const lShoulder = humanoid.getNormalizedBoneNode('leftShoulder');
      const rShoulder = humanoid.getNormalizedBoneNode('rightShoulder');
      const spine = humanoid.getNormalizedBoneNode('spine');
      if (lArm) lArm.rotation.z = 1.2;       // ~69° — arms down to sides
      if (rArm) rArm.rotation.z = -1.2;      // mirror
      if (lShoulder) lShoulder.rotation.z = 0.1;  // ~6° — natural shoulder
      if (rShoulder) rShoulder.rotation.z = -0.1;  // mirror
      if (spine) spine.rotation.x = 0.05;    // ~3° — slight relaxed lean
    }

    // ── Spring bone gravity fix: set gravity on zero-gravity joints ──
    // Some VRM files (notably Hatsune Miku) ship with gravityPower=0 on all
    // spring bone joints, causing hair/cloth to float unrealistically. Set
    // a moderate gravity on joints that currently have none. Joints that
    // already have non-zero gravity (tuned by the model author) are left
    // untouched.
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sbm: any = (vrm as any).springBoneManager;
      if (sbm && sbm.joints) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const jointsArr: any[] = Array.from(sbm.joints);
        for (const joint of jointsArr) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const s: any = joint.settings;
          if (s && s.gravityPower === 0) {
            s.gravityPower = 0.5;
            s.gravityDir.set(0, -1, 0);
          }
        }
      }
    }

    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    onLoaded?.();
  }, [gltf, onLoaded]);

  return {
    gltf,
    vrm: gltf?.userData?.vrm as VRM | undefined,
    groupRef,
  };
}
