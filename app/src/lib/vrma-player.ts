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
import { LatestOperationGate } from './runtime-coordination';

const CROSSFADE_SECONDS = 0.22;

// Marker used to tag built-in clips (so we can avoid trying to revoke a blob
// URL or re-fetch them).
const BUILT_IN_CLIP_TAG = 'codesiren-built-in';

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

interface PreparedVrmaClip {
  session: LocalVrmaSession;
  clip: THREE.AnimationClip;
  metadata: LoadedVrmaClip;
  alreadyInstalled: boolean;
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
  private readonly syncGate = new LatestOperationGate();
  // Actions that are currently fading out (kept alive until weight hits 0).
  private readonly fadingOut = new Set<THREE.AnimationAction>();
  // Tracks built-in clip ids installed per state so the auto-cycle scheduler
  // can ask "what is currently playing?" without inspecting the mixer.
  private readonly builtInClipIds = new Map<AvatarMotionState, string>();
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

  private async prepare(session: LocalVrmaSession): Promise<PreparedVrmaClip> {
    const loadedUrl = this.sessionUrls.get(session.targetState);
    const loadedMetadata = this.loadedClipMetadata.get(session.targetState);
    const loadedAction = this.actions.get(session.targetState);
    if (loadedUrl === session.url && loadedMetadata && loadedAction) {
      return { session, clip: loadedAction.getClip(), metadata: loadedMetadata, alreadyInstalled: true };
    }

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    const gltf = await loader.loadAsync(session.url);
    const vrmAnimations = (gltf.userData as { vrmAnimations?: unknown[] }).vrmAnimations;
    const vrmAnimation = vrmAnimations?.[0];
    if (!vrmAnimation) {
      throw new Error('The selected file does not contain a VRM Animation track.');
    }

    const clip = createVRMAnimationClip(vrmAnimation as Parameters<typeof createVRMAnimationClip>[0], this.vrm);
    return {
      session,
      clip,
      metadata: { targetState: session.targetState, durationSeconds: clip.duration },
      alreadyInstalled: false,
    };
  }

  private install(prepared: PreparedVrmaClip): LoadedVrmaClip {
    const { session, clip, metadata } = prepared;
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
    const token = this.syncGate.begin();
    const desired = new Map(sessions.map((session) => [session.targetState, session]));
    for (const state of this.actions.keys()) {
      const session = desired.get(state as LocalVrmaSession['targetState']);
      if (!session || this.sessionUrls.get(state) !== session.url) this.remove(state);
    }

    const settled = await Promise.allSettled(sessions.map((session) => this.prepare(session)));
    if (!this.syncGate.isCurrent(token)) return [];
    const prepared = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    return prepared.map((entry) => entry.alreadyInstalled ? entry.metadata : this.install(entry));
  }

  hasClip(state: AvatarMotionState): boolean {
    return this.actions.has(state);
  }

  /**
   * Returns the built-in clip id currently installed for the given state,
   * or null if the state has no built-in clip (either no clip at all, or
   * a user-supplied .vrma file).
   */
  getBuiltInClipId(state: AvatarMotionState): string | null {
    return this.builtInClipIds.get(state) ?? null;
  }

  /**
   * Install a built-in (procedurally generated) clip into a motion-state slot.
   * Built-in clips don't require a .vrma file — they are pre-baked
   * THREE.AnimationClip objects produced by built-in-animations.ts.
   *
   * The clip's tracks are named after VRM humanoid bone names
   * (e.g. `hips.quaternion`, `leftUpperArm.quaternion`). The VRM scene's
   * actual bone nodes have different names (the glTF node names from the
   * original exporter, e.g. `J_Bip_C_Hips`). Before installing, we rewrite
   * each track's name to point at the actual node name resolved via
   * `vrm.humanoid.getNormalizedBoneNode(<boneName>)`.
   *
   * If `activate` is true, the clip is immediately crossfaded in (the
   * previously active action, if any, is faded out in parallel).
   */
  installBuiltInClip(
    state: AvatarMotionState,
    clip: THREE.AnimationClip,
    clipId: string,
    options: { crossfadeSeconds?: number; activate?: boolean } = {},
  ): void {
    const crossfadeSeconds = options.crossfadeSeconds ?? CROSSFADE_SECONDS;
    const activate = options.activate ?? false;

    // Rewrite track names from VRM humanoid bone names (e.g. 'hips')
    // to the actual scene node names (e.g. 'J_Bip_C_Hips').
    // We do this once per (clip, vrm) pair and cache the result by
    // stamping the clip's name with a marker so we don't rewrite twice.
    const rewrittenClip = this.rewriteClipTrackNames(clip, clipId);

    // If a different clip is already installed under this state, retire it
    // to the fading-out set so the crossfade overlaps.
    const previous = this.actions.get(state);
    if (previous) {
      if (previous.weight > 0) {
        previous.fadeOut(crossfadeSeconds);
        this.fadingOut.add(previous);
      } else {
        previous.stop();
        this.mixer.uncacheClip(previous.getClip());
      }
    }

    const action = this.mixer.clipAction(rewrittenClip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    this.actions.set(state, action);

    this.sessionUrls.set(state, `${BUILT_IN_CLIP_TAG}:${clipId}`);
    this.builtInClipIds.set(state, clipId);
    this.loadedClipMetadata.set(state, {
      targetState: state,
      durationSeconds: rewrittenClip.duration,
    });

    if (activate || this.activeState === state) {
      action.reset().fadeIn(crossfadeSeconds).play();
      this.activeState = state;
    }
  }

  /**
   * Rewrite a built-in clip's track names from VRM humanoid bone names
   * (e.g. `hips`, `leftUpperArm`, `head`) to the actual node names in the
   * VRM scene (e.g. `J_Bip_C_Hips`, `J_Bip_L_UpperArm`).
   *
   * This mirrors what `createVRMAnimationClip` from @pixiv/three-vrm-animation
   * does for .vrma files: it looks up each bone via
   * `humanoid.getNormalizedBoneNode(name)` and uses the resulting node's
   * `.name` property as the new track name prefix.
   *
   * Returns the same clip instance if no rewriting is needed (e.g. all
   * tracks already resolve, or the VRM has no humanoid rig). Otherwise
   * returns a new clip with rewritten track names. The original clip is
   * left untouched so it can be safely cached and reused for other VRMs.
   *
   * For VRM 0.x models, the X-axis of rotation tracks is negated to
   * account for the coordinate-system difference between VRM 0.x (Y-up,
   * Z-forward, left-handed) and VRM 1.0 (Y-up, Z-backward, right-handed).
   */
  private rewriteClipTrackNames(clip: THREE.AnimationClip, clipId: string): THREE.AnimationClip {
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return clip;

    // Detect VRM 0.x vs 1.0 from meta version. VRM 0.x needs X-axis negation.
    const meta = this.vrm.meta as { metaVersion?: string } | undefined;
    const metaVersion: '0' | '1' = meta?.metaVersion === '1' ? '1' : '0';

    // Build a lookup map: bone name (e.g. 'hips') → scene node name.
    // VRMHumanBoneName is a fixed union; we resolve only the bones our
    // built-in clips actually use.
    const BONES_USED = [
      'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
      'leftShoulder', 'rightShoulder',
      'leftUpperArm', 'rightUpperArm',
      'leftLowerArm', 'rightLowerArm',
      'leftHand', 'rightHand',
      'leftUpperLeg', 'rightUpperLeg',
      'leftLowerLeg', 'rightLowerLeg',
      'leftFoot', 'rightFoot',
      'leftToes', 'rightToes',
    ] as const;

    const boneNameToNodeName = new Map<string, string>();
    for (const bone of BONES_USED) {
      // Use the RAW bone node — the normalized bone node is a virtual
      // object managed by three-vrm-core for pose math, and is NOT
      // reachable from the mixer's root (vrm.scene). The mixer's
      // PropertyBinding searches scene descendants, so we need the
      // actual node that lives in vrm.scene.
      const node = humanoid.getRawBoneNode(bone);
      if (node?.name) {
        boneNameToNodeName.set(bone, node.name);
      }
    }

    // If we couldn't resolve any bones, return the original clip.
    if (boneNameToNodeName.size === 0) return clip;

    // Rewrite each track's name. Tracks that don't match a known bone
    // (e.g. `hips.position` where hips isn't a bone) are left alone —
    // they'll become no-ops at runtime, which is fine.
    const newTracks = clip.tracks.map((track) => {
      const dotIndex = track.name.lastIndexOf('.');
      if (dotIndex <= 0) return track;
      const boneName = track.name.substring(0, dotIndex);
      const property = track.name.substring(dotIndex + 1); // 'quaternion' or 'position'
      const nodeName = boneNameToNodeName.get(boneName);
      if (!nodeName) return track;

      // VRM 0.x: negate X component of rotation tracks (every 2nd value
      // starting from index 0 in a quaternion [x, y, z, w, x, y, z, w, ...]).
      // Also: VRM 0.x is left-handed, so positions need x and z negated.
      if (metaVersion === '0' && property === 'quaternion') {
        // Track values can be Float32Array or number[] — slice() returns
        // the same type. We mutate the cloned copy in place.
        const cloned = track.values.slice();
        for (let i = 0; i < cloned.length; i += 4) {
          cloned[i] = -cloned[i]; // negate x
        }
        const newTrack = track.clone();
        newTrack.name = `${nodeName}.quaternion`;
        newTrack.values = cloned;
        return newTrack;
      }

      if (metaVersion === '0' && property === 'position') {
        const cloned = track.values.slice();
        // Negate X and Z (every 1st and 3rd of every 3 values)
        for (let i = 0; i < cloned.length; i += 3) {
          cloned[i] = -cloned[i];     // x
          cloned[i + 2] = -cloned[i + 2]; // z
        }
        const newTrack = track.clone();
        newTrack.name = `${nodeName}.position`;
        newTrack.values = cloned;
        return newTrack;
      }

      // VRM 1.0 — just rename the track, no value negation.
      const newTrack = track.clone();
      newTrack.name = `${nodeName}.${property}`;
      return newTrack;
    });

    const newClip = new THREE.AnimationClip(
      `${BUILT_IN_CLIP_TAG}:${clipId}`,
      clip.duration,
      newTracks,
      clip.blendMode,
    );
    return newClip;
  }

  /**
   * Crossfade to a different motion state with a custom crossfade duration.
   * Identical to setState() but allows the caller to specify a smoother
   * (or sharper) transition than the default 0.22s.
   */
  setStateWithCrossfade(state: AvatarMotionState, crossfadeSeconds: number): void {
    if (this.activeState === state) return;
    const previous = this.activeState ? this.actions.get(this.activeState) : undefined;
    const next = this.actions.get(state);
    if (previous) {
      previous.fadeOut(crossfadeSeconds);
      this.fadingOut.add(previous);
    }
    if (next) next.reset().fadeIn(crossfadeSeconds).play();
    this.activeState = state;
  }

  /**
   * Smoothly swap the built-in clip for a given state to a new one, with
   * a longer crossfade. Used by the auto-cycle scheduler to swap idle
   * animations on a timer without a visible pop.
   *
   * The state itself does not change — only the clip playing inside it.
   * If the state is currently the active one, the new clip fades in
   * while the old one fades out in parallel.
   */
  swapBuiltInClip(
    state: AvatarMotionState,
    clip: THREE.AnimationClip,
    clipId: string,
    crossfadeSeconds: number,
  ): void {
    // Skip if the same clip id is already playing (avoid restart popping).
    if (this.builtInClipIds.get(state) === clipId) return;
    this.installBuiltInClip(state, clip, clipId, {
      crossfadeSeconds,
      activate: this.activeState === state,
    });
  }

  setState(state: AvatarMotionState): void {
    if (this.activeState === state) return;

    const previous = this.activeState ? this.actions.get(this.activeState) : undefined;
    const next = this.actions.get(state);
    if (previous) {
      previous.fadeOut(CROSSFADE_SECONDS);
      this.fadingOut.add(previous);
    }
    if (next) next.reset().fadeIn(CROSSFADE_SECONDS).play();
    this.activeState = state;
  }

  update(deltaSeconds: number): void {
    this.mixer.update(deltaSeconds);
    // Reap any faded-out actions.
    if (this.fadingOut.size > 0) {
      for (const action of this.fadingOut) {
        if (action.weight <= 0.001 || !action.isRunning()) {
          action.stop();
          this.mixer.uncacheClip(action.getClip());
          this.fadingOut.delete(action);
        }
      }
    }
  }

  dispose(): void {
    this.syncGate.invalidate();
    for (const action of this.actions.values()) {
      action.stop();
      this.mixer.uncacheClip(action.getClip());
    }
    for (const action of this.fadingOut) {
      action.stop();
      this.mixer.uncacheClip(action.getClip());
    }
    this.fadingOut.clear();
    this.actions.clear();
    this.sessionUrls.clear();
    this.loadedClipMetadata.clear();
    this.builtInClipIds.clear();
    this.mixer.stopAllAction();
    if (this.lookAtProxy) this.vrm.scene.remove(this.lookAtProxy);
  }
}
