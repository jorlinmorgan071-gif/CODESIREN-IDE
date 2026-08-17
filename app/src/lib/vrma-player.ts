import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VRM } from '@pixiv/three-vrm';
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
} from '@pixiv/three-vrm-animation';
import type { AvatarMotionState } from './avatar-motion';
import type { LocalVrmaSession } from './local-vrma-session';

const CROSSFADE_SECONDS = 0.22;

export function shouldUseProceduralMotion(
  state: AvatarMotionState,
  loadedStates: ReadonlySet<AvatarMotionState>,
): boolean {
  return !loadedStates.has(state);
}

export interface LoadedVrmaClip {
  targetState: AvatarMotionState;
  durationSeconds: number;
}

// Each instance belongs to one loaded VRM. The caller creates a fresh player
// whenever the avatar changes and disposes it with the model view.
export class LocalVrmaPlayer {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<AvatarMotionState, THREE.AnimationAction>();
  private readonly sessionUrls = new Map<AvatarMotionState, string>();
  private readonly loadedClipMetadata = new Map<AvatarMotionState, LoadedVrmaClip>();
  private readonly lookAtProxy: VRMLookAtQuaternionProxy | null;
  private readonly vrm: VRM;
  private activeState: AvatarMotionState | null = null;

  constructor(vrm: VRM) {
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.lookAtProxy = vrm.lookAt ? new VRMLookAtQuaternionProxy(vrm.lookAt) : null;
    if (this.lookAtProxy) {
      this.lookAtProxy.name = 'codesirenVrmaLookAtProxy';
      vrm.scene.add(this.lookAtProxy);
    }
  }

  async load(session: LocalVrmaSession): Promise<LoadedVrmaClip> {
    const loadedUrl = this.sessionUrls.get(session.targetState);
    const loadedMetadata = this.loadedClipMetadata.get(session.targetState);
    if (loadedUrl === session.url && loadedMetadata) return loadedMetadata;

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    const gltf = await loader.loadAsync(session.url);
    const vrmAnimations = (gltf.userData as { vrmAnimations?: unknown[] }).vrmAnimations;
    const vrmAnimation = vrmAnimations?.[0];
    if (!vrmAnimation) {
      throw new Error('The selected file does not contain a VRM Animation track.');
    }

    const clip = createVRMAnimationClip(vrmAnimation as Parameters<typeof createVRMAnimationClip>[0], this.vrm);
    const previous = this.actions.get(session.targetState);
    if (previous) {
      previous.stop();
      this.mixer.uncacheClip(previous.getClip());
    }

    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    this.actions.set(session.targetState, action);

    if (this.activeState === session.targetState) {
      action.reset().fadeIn(CROSSFADE_SECONDS).play();
    }

    const metadata = { targetState: session.targetState, durationSeconds: clip.duration };
    this.sessionUrls.set(session.targetState, session.url);
    this.loadedClipMetadata.set(session.targetState, metadata);
    return metadata;
  }

  remove(state: AvatarMotionState): void {
    const action = this.actions.get(state);
    if (action) {
      action.stop();
      this.mixer.uncacheClip(action.getClip());
    }
    this.actions.delete(state);
    this.sessionUrls.delete(state);
    this.loadedClipMetadata.delete(state);
    if (this.activeState === state) this.activeState = null;
  }

  async sync(sessions: readonly LocalVrmaSession[]): Promise<LoadedVrmaClip[]> {
    const desired = new Map(sessions.map((session) => [session.targetState, session]));
    for (const state of this.actions.keys()) {
      const session = desired.get(state as LocalVrmaSession['targetState']);
      if (!session || this.sessionUrls.get(state) !== session.url) this.remove(state);
    }
    return Promise.all(sessions.map((session) => this.load(session)));
  }

  hasClip(state: AvatarMotionState): boolean {
    return this.actions.has(state);
  }

  setState(state: AvatarMotionState): void {
    if (this.activeState === state) return;

    const previous = this.activeState ? this.actions.get(this.activeState) : undefined;
    const next = this.actions.get(state);
    if (previous) previous.fadeOut(CROSSFADE_SECONDS);
    if (next) next.reset().fadeIn(CROSSFADE_SECONDS).play();
    this.activeState = state;
  }

  update(deltaSeconds: number): void {
    this.mixer.update(deltaSeconds);
  }

  dispose(): void {
    for (const action of this.actions.values()) {
      action.stop();
      this.mixer.uncacheClip(action.getClip());
    }
    this.actions.clear();
    this.sessionUrls.clear();
    this.loadedClipMetadata.clear();
    this.mixer.stopAllAction();
    if (this.lookAtProxy) this.vrm.scene.remove(this.lookAtProxy);
  }
}
