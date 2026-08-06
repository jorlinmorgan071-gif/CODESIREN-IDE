// app/src/lib/vrm-analyzer.ts
// Phase B: Client-side VRM model analysis.
//
// Loads a .vrm File into memory, parses it with GLTFLoader + VRMLoaderPlugin,
// and extracts all the stats the user needs to inspect before confirming the
// upload:
//   - VRM format (0.x vs 1.0)
//   - Expression count + preset names
//   - Mesh / material / bone / texture counts
//   - Triangle count
//   - Has lookAt / springBone / humanoid
//   - Issues (missing textures, broken meshes, etc.)
//
// Also captures a thumbnail by rendering the model to a canvas.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMUtils as _VRMUtils } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';

export interface VrmAnalysisResult {
  format: '0.x' | '1.0';
  expressionCount: number;
  expressionPresets: string[];
  meshCount: number;
  materialCount: number;
  boneCount: number;
  textureCount: number;
  triangleCount: number;
  hasLookAt: boolean;
  hasSpringBone: boolean;
  hasHumanoid: boolean;
  issues: string[];
  thumbnail: Blob | null;  // PNG thumbnail, null if rendering failed
  vrm: VRM | null;         // the loaded VRM object (for preview rendering)
  scene: THREE.Group | null;
  gltf: any | null;
}

/**
 * Analyze a .vrm File. Returns all stats + a thumbnail.
 * The caller is responsible for disposing the VRM (via VRMUtils.deepDispose)
 * when done with the preview.
 */
export async function analyzeVrmFile(file: File): Promise<VrmAnalysisResult> {
  const arrayBuffer = await file.arrayBuffer();

  // Load via GLTFLoader + VRMLoaderPlugin
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      '',
      (gltf) => resolve(gltf),
      (err) => reject(err),
    );
  });

  const vrm: VRM | undefined = gltf.userData?.vrm;
  if (!vrm) {
    throw new Error('File is not a valid VRM — no VRM metadata found in the glTF.');
  }

  // Detect format: VRM 1.0 has vrm.meta?.metaVersion === '1' or similar;
  // VRM 0.x has vrm.meta?.metaVersion undefined or '0'.
  // @pixiv/three-vrm normalizes both, but we can check the original.
  const format: '0.x' | '1.0' = detectVrmFormat(vrm);

  // Expressions
  const expressionManager = vrm.expressionManager;
  const expressionPresets: string[] = [];
  if (expressionManager) {
    const expressions = expressionManager.expressions;
    for (const expr of expressions) {
      // expression.presetName gives 'happy', 'sad', 'aa', 'ee', etc.
      const preset = (expr as any).presetName ?? (expr as any).name ?? 'unknown';
      expressionPresets.push(preset);
    }
  }

  // Walk the scene to count meshes, materials, bones, textures, triangles
  const scene: THREE.Group = gltf.scene;
  let meshCount = 0;
  let materialCount = 0;
  let triangleCount = 0;
  const textures = new Set<THREE.Texture>();
  const bones = new Set<THREE.Bone>();

  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      meshCount++;
      const geom = obj.geometry;
      if (geom?.index) {
        triangleCount += geom.index.count / 3;
      } else if (geom?.attributes?.position) {
        triangleCount += geom.attributes.position.count / 3;
      }
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (mat) {
          materialCount++;
          // Collect textures from material maps
          for (const key of Object.keys(mat)) {
            const val = (mat as any)[key];
            if (val instanceof THREE.Texture) {
              textures.add(val);
            } else if (val && typeof val === 'object' && val.texture instanceof THREE.Texture) {
              textures.add(val.texture);
            }
          }
        }
      }
    }
    if (obj instanceof THREE.Bone) {
      bones.add(obj);
    }
  });

  // LookAt
  const hasLookAt = !!vrm.lookAt;

  // SpringBone — check if VRMSpringBonePlugin data exists
  // @pixiv/three-vrm-spring-bone would be loaded separately, but the VRM object
  // may have springBoneManager. We check the gltf extensions.
  const hasSpringBone = !!(gltf.userData?.vrmSpringBoneManager ?? (vrm as any).springBoneManager);

  // Humanoid
  const hasHumanoid = !!vrm.humanoid;

  // Issues detection
  const issues: string[] = [];
  if (meshCount === 0) issues.push('No meshes found — model may be empty or corrupted');
  if (materialCount === 0) issues.push('No materials found — model will render untextured');
  if (triangleCount === 0) issues.push('No triangles found — model has no renderable geometry');
  if (!hasHumanoid) issues.push('No humanoid rig — some animation features may not work');
  if (!hasLookAt) issues.push('No lookAt (eye tracking) — eye tracking will be disabled');
  if (expressionPresets.length === 0) issues.push('No expressions — lip sync and emotions will not work');
  if (file.size > 50 * 1024 * 1024) issues.push(`Large file (${(file.size / 1024 / 1024).toFixed(1)} MB) — may load slowly`);

  // Render thumbnail
  const thumbnail = await renderThumbnail(scene, vrm);

  return {
    format,
    expressionCount: expressionPresets.length,
    expressionPresets,
    meshCount,
    materialCount,
    boneCount: bones.size,
    textureCount: textures.size,
    triangleCount: Math.floor(triangleCount),
    hasLookAt,
    hasSpringBone,
    hasHumanoid,
    issues,
    thumbnail,
    vrm,
    scene,
    gltf,
  };
}

/**
 * Detect VRM format version.
 * VRM 0.x: meta.metaVersion is undefined or '0'
 * VRM 1.0: meta.metaVersion is '1' or '1.0'
 */
function detectVrmFormat(vrm: VRM): '0.x' | '1.0' {
  const meta = vrm.meta as any;
  if (!meta) return '0.x'; // assume 0.x if no meta
  const version = meta.metaVersion ?? meta.licenseUrl ?? '0';
  if (String(version) === '1' || String(version) === '1.0') return '1.0';
  return '0.x';
}

/**
 * Render a 256×256 thumbnail of the VRM model.
 * Creates a temporary scene + camera + renderer, positions the camera to frame
 * the model, renders, and captures as PNG.
 */
async function renderThumbnail(scene: THREE.Group, _vrm: VRM): Promise<Blob | null> {
  try {
    // Compute bounding box to frame the model
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = 30;
    const distance = (maxDim / 2) / Math.tan((fov * Math.PI) / 180 / 2) * 1.2;

    const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 1000);
    // Position camera in front of the model, slightly above center
    camera.position.set(0, center.y + 0.05, distance);
    camera.lookAt(0, center.y, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(256, 256);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);

    const tempScene = new THREE.Scene();
    tempScene.add(scene.clone(true));

    // Lights — same as FaceView for consistency
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    const key = new THREE.PointLight(0x00bfff, 1, 100);
    key.position.set(0, 2, 3);
    const fill = new THREE.PointLight(0x0088ff, 0.5, 100);
    fill.position.set(0, -2, 1);
    tempScene.add(ambient, key, fill);

    renderer.render(tempScene, camera);

    // Get PNG blob
    const blob: Blob | null = await new Promise((resolve) => {
      renderer.domElement.toBlob((b) => resolve(b), 'image/png');
    });

    // Cleanup
    renderer.dispose();
    // Dispose cloned scene geometries/materials
    tempScene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m?.dispose();
      }
    });

    return blob;
  } catch (err) {
    console.warn('[vrm-analyzer] thumbnail render failed:', err);
    return null;
  }
}

/**
 * Dispose a VRM and its GLTF scene. Must be called when the analysis preview
 * is unmounted to prevent GPU memory leaks.
 */
export function disposeVrm(analysis: VrmAnalysisResult): void {
  if (analysis.scene) {
    try {
      VRMUtils.deepDispose(analysis.scene);
    } catch {
      // already disposed
    }
  }
}
