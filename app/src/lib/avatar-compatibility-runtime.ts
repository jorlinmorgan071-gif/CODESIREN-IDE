import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { AvatarMotionPose } from './avatar-motion';
import type { AvatarCompatibilityProfile } from './avatar-compatibility';

export function applyAvatarCompatibilityProfile(vrm: VRM, scene: THREE.Object3D, profile: AvatarCompatibilityProfile): void {
  const humanoid = vrm.humanoid;
  if (humanoid) {
    for (const correction of profile.transform.humanoidPose) {
      humanoid.getNormalizedBoneNode(correction.bone)?.rotation.set(...correction.rotation);
    }
  }

  const springBoneManager = (vrm as unknown as { springBoneManager?: { joints?: Iterable<{ settings?: { gravityPower?: number; gravityDir?: THREE.Vector3; dragForce?: number } }> } }).springBoneManager;
  const repair = profile.springBones.zeroGravityRepair;
  if (profile.springBones.enabled !== 'disabled' && repair.enabled && springBoneManager?.joints) {
    for (const joint of springBoneManager.joints) {
      const settings = joint.settings;
      if (!settings || (repair.onlyWhenZeroGravity && settings.gravityPower !== 0)) continue;
      settings.gravityPower = repair.gravityPower;
      settings.gravityDir?.set(...repair.gravityDirection);
      if (settings.dragForce === 0) settings.dragForce = repair.dragForce;
    }
  }

  scene.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const enabled = profile.rendering.meshShadows !== 'disabled';
      child.castShadow = enabled;
      child.receiveShadow = enabled;
    }
  });
}

export function applyAvatarPresentationPose(group: THREE.Group, pose: AvatarMotionPose, profile: AvatarCompatibilityProfile): void {
  group.position.set(pose.verticalOffset, 0, 0);
  group.rotation.set(
    pose.pitchOffset + profile.transform.rotationOffset[0],
    pose.yawOffset + profile.transform.rotationOffset[1],
    profile.transform.rotationOffset[2],
  );
  group.scale.setScalar(profile.rendering.renderScale);
}

export function getAvatarGazeTarget(mouseX: number, mouseY: number, profile: AvatarCompatibilityProfile): Vec3 {
  return [
    mouseX * profile.gaze.horizontalScale + profile.gaze.offset[0],
    mouseY * profile.gaze.verticalScale + 1 + profile.gaze.offset[1],
    3 + profile.gaze.offset[2],
  ];
}

type Vec3 = readonly [number, number, number];
