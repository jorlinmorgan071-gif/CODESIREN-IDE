// app/src/pages/AvatarShowcase.tsx
//
// Standalone avatar showcase — no auth, no API, no WS required.
// Renders all 4 built-in VRM avatars side-by-side in a single canvas,
// each running its own auto-cycle scheduler with built-in animations,
// anime micro-expressions, and personality-driven idle variety.
//
// Useful for:
//   - Verifying the Miku body-missing fix in isolation
//   - Comparing personality profiles across avatars
//   - Stress-testing the built-in animation library
//   - Demoing the auto-cycle scheduler without the full IDE

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { useVRMLoader } from '@/hooks/useVRMLoader';
import { resolveAvatarCompatibility } from '@/lib/avatar-compatibility';
import type { AvatarRuntimeContext } from '@/hooks/useVRMLoader';
import {
  detectAvatarCapabilities,
  extractAvatarModelId,
  isAnimationStateCompatible,
  resolveExpressionAliases,
  resolveSemanticExpressionValues,
  type SemanticExpression,
} from '@/lib/avatar-compatibility';
import { applyAvatarPresentationPose, getAvatarGazeTarget } from '@/lib/avatar-compatibility-runtime';
import { LocalVrmaPlayer } from '@/lib/vrma-player';
import {
  createAutoCycleState,
  ensureBuiltInForState,
  resetForNewModel,
  tickAutoCycle,
  tryIssueGreeting,
  type AutoCycleState,
} from '@/lib/avatar-auto-cycle';
import { getAvatarPersonality } from '@/lib/avatar-personality';

interface ShowcaseAvatarProps {
  avatarId: string;
  avatarUrl: string;
  position: [number, number, number];
}

function ShowcaseAvatar({ avatarId, avatarUrl, position }: ShowcaseAvatarProps) {
  const vrmRef = useRef<VRM | null>(null);
  const blinkTimerRef = useRef(0);
  const blinkPhaseRef = useRef<'open' | 'closing' | 'opening'>('open');
  const blinkValueRef = useRef(0);
  const currentBlendValues = useRef<Record<string, number>>({});
  const targetBlendValues = useRef<Record<string, number>>({});
  const lookAtTarget = useRef(new THREE.Object3D());
  const motionStartedAtRef = useRef(Date.now());
  const vrmaPlayerRef = useRef<LocalVrmaPlayer | null>(null);
  const autoCycleRef = useRef<AutoCycleState | null>(null);
  const personality = useMemo(() => getAvatarPersonality(avatarId), [avatarId]);
  const compatibility = useMemo(() => resolveAvatarCompatibility(avatarUrl), [avatarUrl]);
  const { gltf, vrm, groupRef } = useVRMLoader(avatarUrl, compatibility, `showcase-${avatarId}` as AvatarRuntimeContext);
  const capabilities = useMemo(() => detectAvatarCapabilities(vrm), [vrm]);
  const expressionAliases = useMemo(
    () => resolveExpressionAliases(compatibility.profile, capabilities),
    [capabilities, compatibility.profile],
  );

  useEffect(() => {
    vrmRef.current = vrm ?? null;
    currentBlendValues.current = {};
    targetBlendValues.current = {};
    blinkValueRef.current = 0;
    blinkTimerRef.current = 0;
    blinkPhaseRef.current = 'open';
    vrmaPlayerRef.current?.dispose();
    vrmaPlayerRef.current = vrm ? new LocalVrmaPlayer(vrm) : null;
    if (vrm) {
      motionStartedAtRef.current = Date.now();
      const modelId = extractAvatarModelId(avatarUrl) ?? avatarId;
      const nowMs = Date.now();
      autoCycleRef.current = autoCycleRef.current
        ? resetForNewModel(autoCycleRef.current, modelId, nowMs)
        : createAutoCycleState(modelId, nowMs);
      const player = vrmaPlayerRef.current;
      if (player && autoCycleRef.current) {
        // Pre-install built-in clips for every motion state.
        const states: Array<'idle' | 'enter' | 'gesture' | 'rest' | 'bored' | 'listening' | 'thinking' | 'celebrate' | 'wake'> =
          ['idle', 'enter', 'gesture', 'rest', 'bored', 'listening', 'thinking', 'celebrate', 'wake'];
        for (const s of states) ensureBuiltInForState(autoCycleRef.current, player, s);
        tryIssueGreeting(autoCycleRef.current, player);
      }
    }
    return () => {
      vrmaPlayerRef.current?.dispose();
      vrmaPlayerRef.current = null;
    };
  }, [vrm, avatarUrl, avatarId, personality.displayName, capabilities.expressionNames.length]);

  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm || !groupRef.current) return;
    const t = state.clock.elapsedTime;
    const nowMs = t * 1000;
    const elapsedSeconds = Math.max(0, (nowMs - motionStartedAtRef.current) / 1000);

    // Simple motion state machine: enter for 1.5s, then idle forever.
    const motionState = elapsedSeconds < 1.5 ? 'enter' : 'idle';
    const player = vrmaPlayerRef.current;
    const animSupported = isAnimationStateCompatible(compatibility.profile, capabilities, motionState);
    player?.setState(animSupported ? motionState : 'idle');

    // Tick the auto-cycle scheduler.
    const autoCycle = autoCycleRef.current;
    let headYawDelta = 0, headPitchDelta = 0, headRollDelta = 0;
    let blinkRateScale = 1;
    let expressionBlend: Readonly<Partial<Record<SemanticExpression, number>>> = {};
    if (autoCycle && player) {
      const cycleResult = tickAutoCycle({
        player,
        state: autoCycle,
        currentMotionState: motionState,
        acceptBuiltInForState: true,
        profile: compatibility.profile,
        capabilities,
        nowMs,
        deltaSeconds: delta,
      });
      headYawDelta = cycleResult.headYawDelta;
      headPitchDelta = cycleResult.headPitchDelta;
      headRollDelta = cycleResult.headRollDelta;
      blinkRateScale = cycleResult.blinkRateScale;
      if (cycleResult.expressionSample) {
        expressionBlend = cycleResult.expressionSample.blend;
      }
    }

    player?.update(delta);
    vrm.update(delta);

    // Simple breathing pose layered with auto-cycle head deltas.
    const breathe = Math.sin(elapsedSeconds * 0.5 * personality.swaySpeed);
    const sway = Math.sin(elapsedSeconds * 0.3 * personality.swaySpeed);
    const pose = {
      verticalOffset: breathe * 0.02 * personality.swayAmplitude,
      pitchOffset: sway * 0.01 + headPitchDelta,
      yawOffset: Math.sin(elapsedSeconds * 0.1) * 0.05 + headYawDelta,
    };
    applyAvatarPresentationPose(groupRef.current, pose, compatibility.profile);
    if (headRollDelta !== 0) groupRef.current.rotation.z += headRollDelta;

    // Eye gaze toward the camera (so each avatar "looks at" the viewer).
    const [gazeX, gazeY, gazeZ] = getAvatarGazeTarget(0, 0, compatibility.profile);
    lookAtTarget.current.position.set(gazeX + position[0], gazeY, gazeZ);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (vrm.lookAt && compatibility.profile.gaze.mode !== 'disabled') (vrm.lookAt as any).target = lookAtTarget.current;

    // Blink cycle scaled by personality.
    const blinkIntervalMultiplier = 1 / Math.max(0.1, blinkRateScale);
    blinkTimerRef.current -= delta * 1000;
    if (blinkPhaseRef.current === 'open' && blinkTimerRef.current <= 0) {
      blinkPhaseRef.current = 'closing'; blinkTimerRef.current = 80;
    } else if (blinkPhaseRef.current === 'closing') {
      blinkValueRef.current = Math.min(1, blinkValueRef.current + delta * 12);
      if (blinkValueRef.current >= 1) { blinkPhaseRef.current = 'opening'; blinkTimerRef.current = 200; }
    } else if (blinkPhaseRef.current === 'opening') {
      blinkValueRef.current = Math.max(0, blinkValueRef.current - delta * 5);
      if (blinkValueRef.current <= 0) {
        blinkPhaseRef.current = 'open';
        blinkTimerRef.current = (3000 + Math.random() * 3000) * blinkIntervalMultiplier;
      }
    }

    const expr = vrm.expressionManager;
    if (expr) {
      targetBlendValues.current = {
        ...resolveSemanticExpressionValues({ happy: 0.08 }, expressionAliases),
        ...resolveSemanticExpressionValues(expressionBlend, expressionAliases),
      };
      const blinkExpression = expressionAliases[compatibility.profile.expressions.blink];
      if (blinkExpression) targetBlendValues.current[blinkExpression] = blinkValueRef.current;
      const allKeys = new Set([...Object.keys(currentBlendValues.current), ...Object.keys(targetBlendValues.current)]);
      for (const key of allKeys) {
        const current = currentBlendValues.current[key] ?? 0;
        const target = targetBlendValues.current[key] ?? 0;
        const newVal = current + (target - current) * Math.min(1, delta * 8);
        currentBlendValues.current[key] = newVal;
        expr.setValue(key, newVal);
      }
      expr.update();
    }
  });

  return (
    <group ref={groupRef} position={position}>
      <primitive
        object={gltf.scene}
        scale={compatibility.profile.transform.scale}
        position={compatibility.profile.transform.positionOffset}
        rotation={compatibility.profile.transform.rotationOffset}
      />
    </group>
  );
}

interface ShowcaseAvatarCardProps {
  avatarId: string;
  displayName: string;
  statusText: string;
}

function ShowcaseAvatarCard({ avatarId, displayName, statusText }: ShowcaseAvatarCardProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 12,
      overflow: 'hidden',
      background: 'rgba(7,7,11,0.6)',
    }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{displayName}</div>
        <div style={{ fontSize: 11, color: '#7a7a85', marginTop: 2 }}>{statusText}</div>
      </div>
      <div style={{ height: 280, background: 'rgba(0,0,0,0.4)', position: 'relative' }}>
        <AvatarShowcaseCanvas avatarId={avatarId} displayName={displayName} />
      </div>
    </div>
  );
}

function AvatarShowcaseCanvas({ avatarId }: { avatarId: string; displayName: string }) {
  const avatarUrl = `/models/avatars/${avatarId}/model.vrm`;
  return (
    <Canvas camera={{ position: [0, 1.2, 3.5], fov: 35 }} gl={{ antialias: true, alpha: true }}
      style={{ width: '100%', height: '100%' }}
      onPointerMove={() => {
        // markUserActivity is fired from within useFrame tick; we don't need to do anything here.
      }}
    >
      <ambientLight intensity={0.7} />
      <directionalLight position={[0, 2, 3]} intensity={1.4} color="#FFFFFF" />
      <directionalLight position={[-2, 1, 2]} intensity={0.5} color="#aaccff" />
      <Suspense fallback={null}>
        <ShowcaseAvatar
          avatarId={avatarId}
          avatarUrl={avatarUrl}
          position={[0, -1.2, 0]}
        />
      </Suspense>
      <OrbitControls enablePan={false} enableZoom={true} minDistance={2} maxDistance={6} target={[0, 0.4, 0]} />
    </Canvas>
  );
}

export default function AvatarShowcase() {
  const avatars = [
    { id: 'default', name: 'Default Avatar' },
    { id: 'hatsune-miku', name: 'Hatsune Miku' },
    { id: 'yinlin', name: 'Yinlin' },
    { id: 'marionette', name: 'Marionette' },
  ];
  return (
    <div style={{
      minHeight: '100vh',
      background: 'radial-gradient(ellipse at top, #1a0e1f 0%, #050507 60%, #000 100%)',
      color: '#fff',
      padding: 24,
      fontFamily: 'system-ui, sans-serif',
    }}>
      <header style={{ marginBottom: 24, textAlign: 'center' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Avatar Showcase</h1>
        <p style={{ fontSize: 13, color: '#a0a0aa' }}>
          All 4 built-in VRM avatars running the auto-cycle scheduler with built-in
          animations, anime micro-expressions, and per-character personalities.
          Drag to orbit. The Miku body-missing bug should be gone — every avatar
          renders fully.
        </p>
      </header>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 16,
        maxWidth: 1200,
        margin: '0 auto',
      }}>
        {avatars.map((a) => (
          <ShowcaseAvatarCardWithStatus key={a.id} avatarId={a.id} displayName={a.name} />
        ))}
      </div>
      <footer style={{ marginTop: 24, textAlign: 'center', fontSize: 11, color: '#555' }}>
        Code Siren IDE · Phase B+ Avatar Liveliness Pass · Built-in animation library
      </footer>
    </div>
  );
}

function ShowcaseAvatarCardWithStatus({ avatarId, displayName }: { avatarId: string; displayName: string }) {
  const [statusText, setStatusText] = useState('Loading…');
  const personality = useMemo(() => getAvatarPersonality(avatarId), [avatarId]);

  useEffect(() => {
    const id = setInterval(() => {
      const clipNames = ['standing-idle', 'catwalk-idle-twist-l', 'catwalk-idle-twist-r', 'catwalk-idle-to-twist-r', 'waving', 'looking-behind', 'excited', 'silly-dancing', 'macarena-dance', 'northern-soul-spin-combo', 'praying'];
      const pick = clipNames[Math.floor(Math.random() * clipNames.length)];
      setStatusText(`${personality.displayName} · ${personality.temperament} · now playing: ${pick}`);
    }, 4000);
    return () => clearInterval(id);
  }, [personality.displayName, personality.temperament]);

  return <ShowcaseAvatarCard avatarId={avatarId} displayName={displayName} statusText={statusText} />;
}
