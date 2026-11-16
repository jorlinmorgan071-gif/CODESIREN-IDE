// app/src/pages/FaceView.tsx
// CHIMERA Avatar Engine — VRM-based avatar with expressions, lip sync, eye tracking.
//
// Replaces the old FBX + wireframe shader system with a VRM model loaded via
// @pixiv/three-vrm. VRM provides standardized blendshapes for expressions,
// spring bones for hair/cloth physics, and look-at bones for eye tracking.
// Lip sync is driven by wlipsync (MFCC-based WASM audio analysis).
//
// VRM blendshape names (standardized per VRM spec):
//   Mouth: aa, ee, ih, oh, ou (vowels for lip sync)
//   Emotions: happy, sad, angry, surprised, relaxed, neutral (expression presets)
//   Eyes: blink (left+right combined), lookAt (eye tracking via look-at bone)


import { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { ChevronDown, User, Check, Upload, Trash2, Pencil, AlertTriangle, PanelRightOpen } from 'lucide-react';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useApp } from '@/store/AppContext';
import { wsClient } from '@/lib/ws';
import { getToken } from '@/lib/auth';
import type { AgentEvent } from '@/types';
import { Mic, MicOff, PhoneOff, Loader2, Volume2 } from 'lucide-react';
import { createLocalVrmSession, revokeLocalVrmSession, type LocalVrmSession } from '@/lib/local-vrm-session';
import {
  getLocalVrmaRegistryEntries,
  LOCAL_VRMA_TARGET_STATES,
  type LocalVrmaTargetState,
} from '@/lib/local-vrma-session';
import { useLocalVrmaRegistry } from '@/store/LocalVrmaRegistryContext';
import type { AvatarDiagnosticsViewSnapshot } from '@/hooks/useAvatarDiagnosticsSnapshot';
import { AvatarDiagnosticsSheetHost } from '@/components/avatar/AvatarDiagnosticsSheetHost';
import { AvatarRuntimeErrorBoundary } from '@/components/avatar/AvatarRuntimeErrorBoundary';
import { LatestOperationGate } from '@/lib/runtime-coordination';
import { VRMModel } from '@/components/avatar/VRMModel';
import type { EmotionId } from '@/lib/avatar-emotions';

// Phase B: Lazy-load the upload dialog (heavy: Three.js + VRM analysis)
const AvatarUploadDialogLazy = lazy(() =>
  import('@/components/avatar/AvatarUploadDialog').then(m => ({ default: m.AvatarUploadDialog }))
);

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';


// ── Main FaceView component ──────────────────────────────────────────────

export default function FaceView() {
  const {
    isActive, isMuted, amplitude, sessionId, captions, visemeHint, voiceActivity,
    toggleMute,
    currentAudioSource, audioContext,
    startVoiceSession, endVoiceSession,
    error: voiceError,
  } = useVoiceSession();
  // Auth-gate fix (Bug A): the WS listeners effect below subscribes to
  // voice:* events which carry auth-context. Don't attach them until
  // AppContext.authReady is true (i.e. until the WS connection is up
  // and the JWT is stored). The user-triggered handleStart already
  // happens after auth completes (button click), but the WS listener
  // registration itself is a mount-time effect — gating it prevents
  // events from being received before the connection is authenticated.
  const { state: appState } = useApp();
  const authReady = appState.authReady;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Callback for VRMModel to signal when a model finishes loading. Must be
  // memoized (useCallback) so VRMModel's [gltf, onLoaded] effect only re-runs
  // when gltf changes (new model), not on every FaceView re-render.
  const handleModelLoaded = useCallback(() => setLoading(false), []);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentEmotion, setCurrentEmotion] = useState<EmotionId>('neutral');

  useEffect(() => {
    if (voiceActivity === 'thinking') {
      setIsProcessing(true);
      setCurrentEmotion('think');
    } else if (voiceActivity === 'speaking') {
      setIsProcessing(false);
      setCurrentEmotion('happy');
    } else if (voiceActivity === 'listening') {
      setIsProcessing(false);
      setCurrentEmotion('neutral');
    } else if (voiceActivity === 'error') {
      setIsProcessing(false);
      setCurrentEmotion('sad');
    } else {
      setIsProcessing(false);
    }
  }, [voiceActivity]);

  const isCurrentVoiceEvent = useCallback((event: AgentEvent) => {
    const payload = event.payload as { sessionId?: unknown };
    return typeof payload.sessionId === 'string' && payload.sessionId === sessionId;
  }, [sessionId]);

  // Phase B: Avatar picker state
  const [avatarUrl, setAvatarUrl] = useState('/models/avatars/default/model.vrm'); // default until settings load
  const [avatarList, setAvatarList] = useState<Array<{ id: string; name: string; thumbnail: string | null; format: string; expressionCount: number; isCustom?: boolean; issues?: string[] }>>([]);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [currentAvatarName, setCurrentAvatarName] = useState('Default Avatar');
  const [avatarSwitching, setAvatarSwitching] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [avatarToDelete, setAvatarToDelete] = useState<string | null>(null);
  const [avatarToRename, setAvatarToRename] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameConflict, setRenameConflict] = useState(false);
  const [localVrmSession, setLocalVrmSession] = useState<LocalVrmSession | null>(null);
  const localVrmInputRef = useRef<HTMLInputElement>(null);
  const avatarSelectionGateRef = useRef(new LatestOperationGate());
  const catalogAvatarFallbackRef = useRef({ url: '/models/avatars/default/model.vrm', name: 'Default Avatar' });
  const {
    animationRegistry: localVrmaRegistry,
    addOrReplaceLocalVrma,
    removeLocalVrma,
  } = useLocalVrmaRegistry();
  const [localVrmaTargetState, setLocalVrmaTargetState] = useState<LocalVrmaTargetState>('idle');
  const localVrmaInputRef = useRef<HTMLInputElement>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsRefreshToken, setDiagnosticsRefreshToken] = useState(0);
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<AvatarDiagnosticsViewSnapshot | null>(null);
  const visibleDiagnosticsSnapshot = useMemo(
    () => diagnosticsSnapshot?.diagnostics.avatarUrl === avatarUrl ? diagnosticsSnapshot : null,
    [avatarUrl, diagnosticsSnapshot],
  );

  // Phase B: Voice-to-Code-Written v1 — write confirmation state
  const [pendingWrite, setPendingWrite] = useState<{
    confirmId: string;
    proposedAction: string;
    intentType: 'write-route' | 'write-migration' | 'write-component';
    params: Record<string, unknown>;
    confidence: number;
  } | null>(null);
  const [writeResult, setWriteResult] = useState<{
    success: boolean;
    filePath: string | null;
    resultText: string;
  } | null>(null);

  // Phase B: Voice session logic (getUserMedia + MediaRecorder + silence
  // detection) has been lifted into VoiceSessionContext so the F6 hotkey
  // can trigger it from anywhere. FaceView's button calls the same shared
  // startVoiceSession/endVoiceSession — no duplication.
  const handleStart = useCallback(async () => {
    await startVoiceSession();
  }, [startVoiceSession]);

  const handleEnd = useCallback(async () => {
    await endVoiceSession();
  }, [endVoiceSession]);

  // ── Toggle mute ───────────────────────────────────────────────────────
  const handleMute = useCallback(async () => {
    toggleMute();
    if (sessionId) {
      try {
        const token = getToken();
        await fetch(`${API_BASE}/voice/live/${sessionId}/mute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ muted: !isMuted }),
        });
      } catch { /* */ }
    }
  }, [toggleMute, sessionId, isMuted]);

  // ── WS listeners for voice events ─────────────────────────────────────
  // Auth-gate fix (Bug A): don't attach WS listeners until authReady is
  // true. The handlers themselves don't fetch, but the WS connection is
  // only established after the JWT is stored, so attaching listeners
  // before that just registers dead handlers. Gating on authReady also
  // guarantees the user can never see stale events from a previous
  // session that were queued before auth completed.
  // Phase B: Fetch avatar settings + manifest on boot (after auth)
  useEffect(() => {
    if (!authReady) return;
    const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';
    const token = getToken() ?? '';
    const selectionToken = avatarSelectionGateRef.current.begin();

    // Fetch manifest (list of available avatars)
    fetch(`${API_BASE}/avatar/manifest`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.avatars && Array.isArray(data.avatars)) {
          setAvatarList(data.avatars.map((a: { id: string; name: string; thumbnail: string | null; format: string; expressionCount?: number; isCustom?: boolean; issues?: string[] }) => ({
            id: a.id,
            name: a.name,
            thumbnail: a.thumbnail,
            format: a.format,
            expressionCount: a.expressionCount ?? 0,
            isCustom: a.isCustom ?? false,
            issues: a.issues,
          })));
        }
      })
      .catch((err) => console.warn('[face] failed to fetch avatar manifest:', err));

    // Fetch persisted avatar settings
    fetch(`${API_BASE}/avatar/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (!avatarSelectionGateRef.current.isCurrent(selectionToken)) return;
        if (data.settings?.selectedAvatarId) {
          const id = data.settings.selectedAvatarId as string;
          const manifestEntry = avatarList.find((a) => a.id === id);
          // Build the URL — custom avatars served by API server, built-in by vite
          const isCustom = id.startsWith('custom-');
          const apiOrigin = API_BASE.replace(/\/api$/, '');
          const url = isCustom
            ? `${apiOrigin}/models/avatars/custom/${id}/model.vrm`
            : `/models/avatars/${id}/model.vrm`;
          setAvatarUrl(url);
          setCurrentAvatarName(manifestEntry?.name ?? id);
          console.log(`[face] loaded persisted avatar: ${id}`);
        }
      })
      .catch((err) => console.warn('[face] failed to fetch avatar settings:', err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady]);

  // A session-only model is represented by a revocable blob URL and is never
  // added to server settings, the built-in manifest, or custom avatar storage.
  useEffect(() => {
    return () => revokeLocalVrmSession(localVrmSession);
  }, [localVrmSession]);

  const handleSelectLocalVrm = useCallback((file: File) => {
    try {
      avatarSelectionGateRef.current.invalidate();
      const session = createLocalVrmSession(file);
      catalogAvatarFallbackRef.current = { url: avatarUrl, name: currentAvatarName };
      setLocalVrmSession(session);
      setAvatarSwitching(true);
      setShowAvatarPicker(false);
      setLoading(true);
      setAvatarUrl(session.url);
      setCurrentAvatarName(`${session.fileName} · local session`);
      setCurrentEmotion('neutral');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The local VRM could not be selected.');
    }
  }, [avatarUrl, currentAvatarName]);

  const handleClearLocalVrm = useCallback(() => {
    avatarSelectionGateRef.current.invalidate();
    setLocalVrmSession(null);
    setAvatarSwitching(true);
    setLoading(true);
    setAvatarUrl(catalogAvatarFallbackRef.current.url);
    setCurrentAvatarName(catalogAvatarFallbackRef.current.name);
    setCurrentEmotion('neutral');
  }, []);

  const handleSelectLocalVrma = useCallback((file: File) => {
    try {
      addOrReplaceLocalVrma(file, localVrmaTargetState);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The local animation could not be selected.');
    }
  }, [addOrReplaceLocalVrma, localVrmaTargetState]);

  const handleRemoveLocalVrma = useCallback((targetState: LocalVrmaTargetState) => {
    removeLocalVrma(targetState);
  }, [removeLocalVrma]);

  // Phase B: Handle avatar selection from picker
  const handleSelectAvatar = async (avatarId: string, name: string) => {
    // Custom avatars are served by the API server (not vite) because vite
    // doesn't reliably serve newly-created files in nested subdirectories.
    // Built-in avatars are served from vite's static public/ dir.
    const isCustom = avatarId.startsWith('custom-');
    const apiOrigin = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api').replace(/\/api$/, '');
    const newUrl = isCustom
      ? `${apiOrigin}/models/avatars/custom/${avatarId}/model.vrm`
      : `/models/avatars/${avatarId}/model.vrm`;
    if (newUrl === avatarUrl) {
      setShowAvatarPicker(false);
      return;
    }

    const selectionToken = avatarSelectionGateRef.current.begin();

    setAvatarSwitching(true);
    setShowAvatarPicker(false);
    setLocalVrmSession(null);

    // Persist to server
    const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';
    const token = getToken() ?? '';
    try {
      await fetch(`${API_BASE}/avatar/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ selectedAvatarId: avatarId }),
      });
    } catch (err) {
      console.warn('[face] failed to persist avatar selection:', err);
    }

    if (!avatarSelectionGateRef.current.isCurrent(selectionToken)) return;

    // Trigger the switch (useLoader will re-suspend with the new URL)
    setAvatarUrl(newUrl);
    setCurrentAvatarName(name);
    catalogAvatarFallbackRef.current = { url: newUrl, name };
    setLoading(true); // show loading spinner during switch

    // Reset state for new model
    setCurrentEmotion('neutral');
  };

  // Phase B: Refresh the avatar list from the server (after upload/delete/rename)
  const refreshAvatarList = useCallback(async () => {
    const token = getToken() ?? '';
    try {
      const res = await fetch(`${API_BASE}/avatar/manifest`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { avatars: Array<Record<string, unknown>> };
      if (data.avatars && Array.isArray(data.avatars)) {
        setAvatarList(data.avatars.map((a) => ({
          id: String(a.id),
          name: String(a.name),
          thumbnail: a.thumbnail as string | null,
          format: String(a.format),
          expressionCount: Number(a.expressionCount ?? 0),
          isCustom: Boolean(a.isCustom ?? false),
          issues: a.issues as string[] | undefined,
        })));
      }
    } catch (err) {
      console.warn('[face] failed to refresh avatar list:', err);
    }
  }, []);

  // Phase B: Handle custom avatar uploaded
  const handleAvatarUploaded = useCallback(async (newAvatar: { id: string; name: string }) => {
    setShowUploadDialog(false);
    await refreshAvatarList();
    // Auto-select the newly uploaded avatar
    if (newAvatar?.id) {
      handleSelectAvatar(newAvatar.id, newAvatar.name);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshAvatarList]);

  // Phase B: Handle custom avatar delete
  const handleDeleteAvatar = useCallback(async (avatarId: string) => {
    const token = getToken() ?? '';
    try {
      const res = await fetch(`${API_BASE}/avatar/custom/${avatarId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        throw new Error(data.error ?? `Delete failed (${res.status})`);
      }
      const data = await res.json() as { settingsReset?: boolean };
      setAvatarToDelete(null);
      await refreshAvatarList();
      // If the deleted avatar was selected, the server reset to default —
      // update the UI to reflect that
      if (data.settingsReset) {
        setAvatarUrl('/models/avatars/default/model.vrm');
        setCurrentAvatarName('Default Avatar');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[face] delete failed:', err);
      alert(`Failed to delete avatar: ${msg}`);
    }
  }, [refreshAvatarList]);

  // Phase B: Start rename flow
  const handleStartRename = useCallback((avatarId: string, currentName: string) => {
    setAvatarToRename(avatarId);
    setRenameValue(currentName);
    setRenameConflict(false);
  }, []);

  // Phase B: Confirm rename
  const handleConfirmRename = useCallback(async () => {
    if (!avatarToRename || !renameValue.trim()) return;
    const token = getToken() ?? '';
    try {
      const res = await fetch(`${API_BASE}/avatar/custom/${avatarToRename}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        if (res.status === 409) {
          setRenameConflict(true);
          return;
        }
        throw new Error(data.error ?? `Rename failed (${res.status})`);
      }
      setAvatarToRename(null);
      setRenameValue('');
      setRenameConflict(false);
      await refreshAvatarList();
      // If we renamed the currently-selected avatar, update the display name
      const renamed = avatarList.find(a => a.id === avatarToRename);
      if (renamed && avatarUrl === `/models/avatars/${avatarToRename}/model.vrm`) {
        setCurrentAvatarName(renameValue.trim());
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[face] rename failed:', err);
      alert(`Failed to rename avatar: ${msg}`);
    }
  }, [avatarToRename, renameValue, avatarList, avatarUrl, refreshAvatarList]);

  // Phase B: Debounced rename conflict check
  useEffect(() => {
    if (!avatarToRename || !renameValue.trim()) {
      setRenameConflict(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const token = getToken() ?? '';
        const res = await fetch(`${API_BASE}/avatar/custom/check-name?name=${encodeURIComponent(renameValue)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as { conflict: boolean };
        // Don't flag conflict if the name matches the avatar being renamed
        const currentAvatar = avatarList.find(a => a.id === avatarToRename);
        if (currentAvatar && currentAvatar.name.toLowerCase() === renameValue.trim().toLowerCase()) {
          setRenameConflict(false);
        } else {
          setRenameConflict(data.conflict);
        }
      } catch {
        // network error — don't block
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [renameValue, avatarToRename, avatarList]);

  // Phase B: Handle loading state during avatar switch
  useEffect(() => {
    if (avatarSwitching) {
      // Give the Suspense boundary time to catch + show the spinner
      const timer = setTimeout(() => setAvatarSwitching(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [avatarSwitching]);

  useEffect(() => {
    if (!authReady) return;
    // Phase B: Voice-to-Code-Written v1 — confirmation gate WS listeners
    const offConfirmWrite = wsClient.on('voice:confirm-write' as never, (evt: AgentEvent) => {
      if (!isCurrentVoiceEvent(evt)) return;
      const payload = evt.payload as {
        confirmId: string;
        proposedAction: string;
        intentType: 'write-route' | 'write-migration' | 'write-component';
        params: Record<string, unknown>;
        confidence: number;
      };
      setPendingWrite({
        confirmId: payload.confirmId,
        proposedAction: payload.proposedAction,
        intentType: payload.intentType,
        params: payload.params,
        confidence: payload.confidence,
      });
      setWriteResult(null);
    });

    const offWriteConfirmed = wsClient.on('voice:write-confirmed' as never, (evt: AgentEvent) => {
      if (!isCurrentVoiceEvent(evt)) return;
      setPendingWrite(null);  // hide the confirmation panel
    });

    const offWriteCancelled = wsClient.on('voice:write-cancelled' as never, (evt: AgentEvent) => {
      if (!isCurrentVoiceEvent(evt)) return;
      const payload = evt.payload as { reason: 'user-cancel' | 'timeout' };
      setPendingWrite(null);
      if (payload.reason === 'timeout') {
        setWriteResult({ success: false, filePath: null, resultText: 'Confirmation timed out — no file was written.' });
      }
    });

    const offWriteResult = wsClient.on('voice:write-result' as never, (evt: AgentEvent) => {
      if (!isCurrentVoiceEvent(evt)) return;
      const payload = evt.payload as {
        success: boolean;
        filePath: string | null;
        resultText: string;
      };
      setWriteResult({
        success: payload.success,
        filePath: payload.filePath,
        resultText: payload.resultText,
      });
    });

    return () => {
      offConfirmWrite();
      offWriteConfirmed();
      offWriteCancelled();
      offWriteResult();
    };
  }, [authReady, isCurrentVoiceEvent]);

  // ── Navigate back ─────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    if (isActive) handleEnd();
    window.history.back();
  }, [isActive, handleEnd]);

  return (
    <div className="h-screen w-screen flex flex-col" style={{ backgroundColor: '#07070B' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <button onClick={handleBack} className="p-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)]" style={{ color: 'var(--steel-silver)' }}>
          <PhoneOff className="w-4 h-4" />
        </button>
        <span className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
          Face Avatar {isActive && <span style={{ color: 'var(--siren-red)' }}>• LIVE</span>}
        </span>
        <button
          type="button"
          onClick={() => setDiagnosticsOpen(true)}
          title="Open avatar diagnostics"
          aria-label="Open avatar diagnostics"
          className="rounded-md p-1.5 transition-colors hover:bg-[var(--surface-raised)]"
          style={{ color: 'var(--steel-silver)' }}
        >
          <PanelRightOpen className="w-4 h-4" />
        </button>
      </div>

      {/* 3D Scene */}
      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--siren-red)' }} />
          </div>
        )}

        {(error || voiceError) && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 px-3 py-2 rounded-md text-[12px]"
            style={{ backgroundColor: 'rgba(238, 28, 28, 0.15)', border: '1px solid rgba(238, 28, 28, 0.4)', color: 'var(--siren-red)' }}>
            {error || voiceError}
            <button onClick={() => { setError(null); }} className="ml-2 underline">dismiss</button>
          </div>
        )}

        <Canvas
          camera={{ position: [0, 0, 3], fov: 45 }}
          gl={{ antialias: true, alpha: true }}
          onCreated={() => setLoading(false)}
        >
          <ambientLight intensity={0.6} />
          <directionalLight position={[0, 2, 3]} intensity={1.2} color="#FFFFFF" />
          <directionalLight position={[-2, 1, 2]} intensity={0.4} color="#FFFFFF" />

          {/* Fix 2 — Suspense boundary INSIDE the Canvas to catch the
              Promise that useLoader throws while the FBX is loading.
              fallback={null} means the Canvas shows nothing (transparent)
              during load — the existing loading spinner in FaceView
              already handles this. The FaceErrorBoundary catches any
              load errors (e.g. 404, malformed FBX), turns off the
              loading spinner, and surfaces a clear error message
              rather than crashing the Canvas silently. */}
          <Suspense fallback={null}>
            <AvatarRuntimeErrorBoundary
              avatarIdentity={avatarUrl}
              onError={(msg) => {
                setLoading(false);
                setError(`3D model failed to load: ${msg}`);
              }}
            >
              <VRMModel amplitude={amplitude} visemeHint={visemeHint} isActive={isActive} currentEmotion={currentEmotion} audioSource={currentAudioSource} audioContext={audioContext} avatarUrl={avatarUrl} animationRegistry={localVrmaRegistry} onLoaded={handleModelLoaded} onAnimationError={setError} diagnosticsOpen={diagnosticsOpen} diagnosticsRefreshToken={diagnosticsRefreshToken} onDiagnosticsSnapshot={setDiagnosticsSnapshot} />
            </AvatarRuntimeErrorBoundary>
          </Suspense>

          <OrbitControls enablePan={false} enableZoom={true} minDistance={1.5} maxDistance={6} />
        </Canvas>

        {/* Phase B: Avatar Picker — top-right corner, doesn't obscure the 3D render */}
        <div className="absolute top-3 right-3 z-20">
          <button
            onClick={() => setShowAvatarPicker(!showAvatarPicker)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] transition-colors"
            style={{
              backgroundColor: 'rgba(14, 14, 20, 0.8)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--bright-silver)',
            }}
          >
            <User className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
            <span>{currentAvatarName}</span>
            <ChevronDown className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
          </button>

          {showAvatarPicker && (
            <div
              className="absolute top-full right-0 mt-1 w-72 rounded-lg overflow-hidden shadow-xl max-h-[70vh] flex flex-col"
              style={{
                backgroundColor: 'rgba(14, 14, 20, 0.95)',
                backdropFilter: 'blur(12px)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {avatarList.length === 0 && (
                <div className="px-3 py-4 text-[11px] text-center" style={{ color: 'var(--steel-silver)' }}>
                  Loading avatars...
                </div>
              )}

              {/* Avatar list — scrollable */}
              <div className="overflow-y-auto flex-1">
                {avatarList.map((avatar) => {
                  // Selected check — handles both built-in (vite-served) and
                  // custom (API-served) avatar URL formats
                  const expectedUrl = avatar.isCustom
                    ? `${API_BASE.replace(/\/api$/, '')}/models/avatars/custom/${avatar.id}/model.vrm`
                    : `/models/avatars/${avatar.id}/model.vrm`;
                  const isSelected = avatarUrl === expectedUrl || avatarUrl === `/models/avatars/${avatar.id}/model.vrm`;
                  const isCustom = avatar.isCustom;
                  const isRenaming = avatarToRename === avatar.id;
                  return (
                    <div
                      key={avatar.id}
                      className="group relative"
                      style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    >
                      {isRenaming ? (
                        /* Inline rename input */
                        <div className="p-2.5 space-y-2">
                          <input
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            maxLength={60}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleConfirmRename();
                              if (e.key === 'Escape') { setAvatarToRename(null); setRenameValue(''); }
                            }}
                            className="w-full px-2 py-1 rounded text-[12px] outline-none"
                            style={{
                              backgroundColor: 'rgba(255,255,255,0.05)',
                              border: `1px solid ${renameConflict ? 'var(--siren-red)' : 'rgba(238, 28, 28, 0.3)'}`,
                              color: 'var(--bright-silver)',
                            }}
                          />
                          {renameConflict && (
                            <div className="text-[10px]" style={{ color: 'var(--siren-red)' }}>
                              Name already taken
                            </div>
                          )}
                          <div className="flex gap-1">
                            <button
                              onClick={handleConfirmRename}
                              disabled={!renameValue.trim() || renameConflict}
                              className="flex-1 px-2 py-1 rounded text-[11px] transition-colors disabled:opacity-40"
                              style={{ backgroundColor: 'rgba(238, 28, 28, 0.2)', color: 'var(--bright-silver)' }}
                            >
                              Save
                            </button>
                            <button
                              onClick={() => { setAvatarToRename(null); setRenameValue(''); }}
                              className="flex-1 px-2 py-1 rounded text-[11px] transition-colors"
                              style={{ backgroundColor: 'rgba(255,255,255,0.05)', color: 'var(--steel-silver)' }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleSelectAvatar(avatar.id, avatar.name)}
                          className="flex items-center gap-3 w-full px-3 py-2.5 text-left transition-colors hover:bg-white/5"
                        >
                          {/* Thumbnail — custom avatars get red border glow */}
                          {avatar.thumbnail ? (
                            <img
                              src={avatar.thumbnail}
                              alt={avatar.name}
                              className="w-10 h-10 rounded object-cover flex-shrink-0"
                              style={{
                                border: isCustom
                                  ? '1px solid rgba(238, 28, 28, 0.6)'
                                  : '1px solid var(--border-subtle)',
                                boxShadow: isCustom
                                  ? '0 0 8px rgba(238, 28, 28, 0.4)'
                                  : 'none',
                              }}
                            />
                          ) : (
                            <div
                              className="w-10 h-10 rounded flex items-center justify-center flex-shrink-0"
                              style={{
                                backgroundColor: 'var(--surface-raised)',
                                border: isCustom
                                  ? '1px solid rgba(238, 28, 28, 0.6)'
                                  : '1px solid var(--border-subtle)',
                                boxShadow: isCustom
                                  ? '0 0 8px rgba(238, 28, 28, 0.4)'
                                  : 'none',
                              }}
                            >
                              <User className="w-4 h-4" style={{ color: 'var(--steel-silver)' }} />
                            </div>
                          )}

                          {/* Name + metadata — custom avatars get red neon glow on name */}
                          <div className="flex-1 min-w-0">
                            <div
                              className="text-[12px] font-medium truncate"
                              style={{
                                color: isCustom ? '#ff4444' : 'var(--bright-silver)',
                                textShadow: isCustom
                                  ? '0 0 5px rgba(238, 28, 28, 0.8), 0 0 10px rgba(238, 28, 28, 0.6), 0 0 15px rgba(238, 28, 28, 0.4)'
                                  : 'none',
                              }}
                            >
                              {avatar.name}
                            </div>
                            <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                              VRM {avatar.format} · {avatar.expressionCount} expressions
                              {isCustom && <span style={{ color: 'rgba(238, 28, 28, 0.7)' }}> · custom</span>}
                            </div>
                            {/* Issues warning */}
                            {avatar.issues && avatar.issues.length > 0 && (
                              <div className="flex items-center gap-1 mt-0.5 text-[9px]" style={{ color: 'rgba(251, 191, 36, 0.8)' }}>
                                <AlertTriangle className="w-2.5 h-2.5" />
                                {avatar.issues.length} issue{avatar.issues.length === 1 ? '' : 's'}
                              </div>
                            )}
                          </div>

                          {/* Selected indicator */}
                          {isSelected && (
                            <Check className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--siren-red)' }} />
                          )}
                        </button>
                      )}

                      {/* Rename + Delete buttons for custom avatars (appear on hover) */}
                      {isCustom && !isRenaming && (
                        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartRename(avatar.id, avatar.name);
                            }}
                            className="p-1 rounded hover:bg-white/10"
                            title="Rename"
                          >
                            <Pencil className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setAvatarToDelete(avatar.id);
                            }}
                            className="p-1 rounded hover:bg-white/10"
                            title="Delete"
                          >
                            <Trash2 className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Session-only local model: no network request, manifest change, or persistence. */}
              <input
                ref={localVrmInputRef}
                type="file"
                accept=".vrm,model/gltf-binary"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) handleSelectLocalVrm(file);
                }}
              />
              <button
                onClick={() => localVrmInputRef.current?.click()}
                className="flex items-center justify-center gap-2 px-3 py-2.5 text-[12px] font-medium transition-colors hover:bg-white/5"
                style={{
                  borderTop: '1px solid rgba(255,255,255,0.08)',
                  backgroundColor: 'rgba(255,255,255,0.025)',
                  color: 'var(--bright-silver)',
                }}
              >
                <Upload className="w-3.5 h-3.5" style={{ color: 'var(--steel-silver)' }} />
                Use Local VRM This Session
              </button>
              {localVrmSession && (
                <button
                  onClick={handleClearLocalVrm}
                  className="px-3 py-2 text-[10px] text-left transition-colors hover:bg-white/5"
                  style={{ color: 'var(--steel-silver)', borderTop: '1px solid rgba(255,255,255,0.06)' }}
                >
                  Remove local model and restore catalog avatar
                </button>
              )}
              <div className="px-3 py-1.5 text-[9px]" style={{ color: 'var(--muted-silver)' }}>
                Local VRMs stay in this browser session only and are not uploaded, saved, or added to the catalog.
              </div>

              {/* Session-only VRMA: animation data is held in a revocable blob URL. */}
              <div className="px-3 py-2 space-y-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                <label className="block text-[9px]" style={{ color: 'var(--muted-silver)' }}>
                  Apply local animation to
                  <select
                    value={localVrmaTargetState}
                    onChange={(event) => setLocalVrmaTargetState(event.target.value as LocalVrmaTargetState)}
                    className="mt-1 w-full rounded px-2 py-1 text-[11px] outline-none"
                    style={{ backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-subtle)', color: 'var(--bright-silver)' }}
                  >
                    {LOCAL_VRMA_TARGET_STATES.map((state) => (
                      <option key={state} value={state}>{state}</option>
                    ))}
                  </select>
                </label>
                <input
                  ref={localVrmaInputRef}
                  type="file"
                  accept=".vrma,model/gltf-binary"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) handleSelectLocalVrma(file);
                  }}
                />
                <button
                  onClick={() => localVrmaInputRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 rounded px-2 py-1.5 text-[11px] transition-colors hover:bg-white/5"
                  style={{ backgroundColor: 'rgba(67, 56, 202, 0.14)', color: 'var(--bright-silver)' }}
                >
                  <Upload className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
                  Add or Replace Local .VRMA
                </button>
                {getLocalVrmaRegistryEntries(localVrmaRegistry).length > 0 && (
                  <div className="space-y-1 pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--muted-silver)' }}>Local animation library</div>
                    {getLocalVrmaRegistryEntries(localVrmaRegistry).map((session) => (
                      <div key={session.targetState} className="flex items-center gap-2 rounded px-2 py-1" style={{ backgroundColor: 'rgba(255,255,255,0.035)' }}>
                        <span className="min-w-0 flex-1 truncate text-[9px]" style={{ color: 'var(--bright-silver)' }}>
                          <span style={{ color: 'var(--steel-silver)' }}>{session.targetState}</span> · {session.fileName}
                        </span>
                        <button
                          onClick={() => handleRemoveLocalVrma(session.targetState)}
                          className="text-[9px] hover:underline"
                          style={{ color: 'var(--siren-red)' }}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[9px]" style={{ color: 'var(--muted-silver)' }}>
                  Local animations are not uploaded, saved, or added to the catalog. Replacing one state leaves other mappings active.
                </p>
              </div>

              {/* Footer: Add Custom Model button */}
              <button
                onClick={() => {
                  setShowAvatarPicker(false);
                  setShowUploadDialog(true);
                }}
                className="flex items-center justify-center gap-2 px-3 py-2.5 text-[12px] font-medium transition-colors hover:bg-white/5"
                style={{
                  borderTop: '1px solid rgba(238, 28, 28, 0.2)',
                  backgroundColor: 'rgba(238, 28, 28, 0.05)',
                  color: 'var(--bright-silver)',
                }}
              >
                <Upload className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
                Add Custom Model
              </button>
            </div>
          )}
        </div>

        {/* Phase B: Custom avatar upload dialog */}
        {showUploadDialog && (
          <Suspense fallback={null}>
            <AvatarUploadDialogLazy
              onClose={() => setShowUploadDialog(false)}
              onUploaded={handleAvatarUploaded}
            />
          </Suspense>
        )}

        {/* Phase B: Delete confirmation dialog */}
        {avatarToDelete && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
            onClick={() => setAvatarToDelete(null)}
          >
            <div
              className="w-[min(400px,90vw)] rounded-xl p-5"
              style={{
                backgroundColor: 'rgba(7, 7, 11, 0.95)',
                border: '1px solid rgba(238, 28, 28, 0.3)',
                boxShadow: '0 0 30px rgba(238, 28, 28, 0.2)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-5 h-5" style={{ color: 'var(--siren-red)' }} />
                <span className="text-[14px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                  Delete Custom Avatar?
                </span>
              </div>
              <p className="text-[12px] mb-4" style={{ color: 'var(--steel-silver)' }}>
                This will permanently delete the model file and remove it from your avatar list. This action cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setAvatarToDelete(null)}
                  className="flex-1 px-3 py-2 rounded-lg text-[12px] transition-colors"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--steel-silver)',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteAvatar(avatarToDelete)}
                  className="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors"
                  style={{
                    backgroundColor: 'rgba(238, 28, 28, 0.2)',
                    border: '1px solid rgba(238, 28, 28, 0.4)',
                    color: 'var(--bright-silver)',
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Avatar switching loading indicator */}
        {avatarSwitching && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20">
            <div className="text-[12px] px-4 py-2 rounded-lg" style={{
              backgroundColor: 'rgba(14, 14, 20, 0.9)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--steel-silver)',
            }}>
              Switching avatar...
            </div>
          </div>
        )}

        {/* Phase B: Voice-to-Code-Written v1 — Write confirmation panel */}
        {pendingWrite && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 w-full max-w-lg px-4 z-30">
            <div
              className="rounded-xl p-4 space-y-3"
              style={{
                backgroundColor: 'rgba(7, 7, 11, 0.95)',
                border: '1px solid rgba(238, 28, 28, 0.4)',
                boxShadow: '0 0 30px rgba(238, 28, 28, 0.15)',
                backdropFilter: 'blur(12px)',
              }}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
                <span className="text-[13px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                  Confirm {pendingWrite.intentType === 'write-route' ? 'Route Write' : pendingWrite.intentType === 'write-migration' ? 'Migration Write' : 'Component Write'}
                </span>
                <span className="text-[10px] ml-auto" style={{ color: 'var(--muted-silver)' }}>
                  {Math.round(pendingWrite.confidence * 100)}% confidence
                </span>
              </div>

              <p className="text-[12px]" style={{ color: 'var(--steel-silver)' }}>
                {pendingWrite.proposedAction}
              </p>

              <div className="text-[11px] p-2 rounded" style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}>
                <span style={{ color: 'var(--muted-silver)' }}>Type: </span>
                <span style={{ color: 'var(--bright-silver)' }}>{pendingWrite.intentType}</span>
                {pendingWrite.params.description ? (
                  <>
                    <span style={{ color: 'var(--muted-silver)' }}> · Description: </span>
                    <span style={{ color: 'var(--bright-silver)' }}>{String(pendingWrite.params.description)}</span>
                  </>
                ) : null}
              </div>

              <div className="text-[11px]" style={{ color: 'var(--muted-silver)' }}>
                Say "yes" or click Confirm. Say "cancel" or click Cancel. Auto-cancels in 5 min.
              </div>

              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    const token = getToken() ?? '';
                    const sid = sessionId ?? '';
                    if (!sid) return;
                    await fetch(`${API_BASE}/voice/live/${sid}/confirm-write`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ confirmId: pendingWrite.confirmId }),
                    });
                  }}
                  className="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-all"
                  style={{
                    backgroundColor: 'rgba(34, 197, 94, 0.15)',
                    border: '1px solid rgba(34, 197, 94, 0.4)',
                    color: '#22c55e',
                  }}
                >
                  ✓ Confirm
                </button>
                <button
                  onClick={async () => {
                    const token = getToken() ?? '';
                    const sid = sessionId ?? '';
                    if (!sid) return;
                    await fetch(`${API_BASE}/voice/live/${sid}/cancel-write`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ confirmId: pendingWrite.confirmId }),
                    });
                  }}
                  className="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-all"
                  style={{
                    backgroundColor: 'rgba(238, 28, 28, 0.15)',
                    border: '1px solid rgba(238, 28, 28, 0.4)',
                    color: 'var(--siren-red)',
                  }}
                >
                  ✗ Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Phase B: Voice-to-Code-Written v1 — Write result display */}
        {writeResult && !pendingWrite && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 w-full max-w-lg px-4 z-30">
            <div
              className="rounded-xl p-4 flex items-start gap-3"
              style={{
                backgroundColor: 'rgba(7, 7, 11, 0.95)',
                border: `1px solid ${writeResult.success ? 'rgba(34, 197, 94, 0.4)' : 'rgba(238, 28, 28, 0.4)'}`,
                backdropFilter: 'blur(12px)',
              }}
            >
              {writeResult.success ? (
                <Check className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: '#22c55e' }} />
              ) : (
                <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: 'var(--siren-red)' }} />
              )}
              <div className="flex-1">
                <div className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                  {writeResult.success ? 'File Written' : 'Write Failed'}
                </div>
                <div className="text-[11px] mt-1" style={{ color: 'var(--steel-silver)' }}>
                  {writeResult.resultText}
                </div>
              </div>
              <button
                onClick={() => setWriteResult(null)}
                className="text-[10px] underline"
                style={{ color: 'var(--muted-silver)' }}
              >
                dismiss
              </button>
            </div>
          </div>
        )}

        {/* Live captions */}
        {(captions.user || captions.agent) && (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 z-10 space-y-2">
            {captions.user && (
              <div className="text-[13px] p-2.5 rounded-lg" style={{ backgroundColor: 'rgba(14, 14, 20, 0.8)', backdropFilter: 'blur(8px)', border: '1px solid var(--border-subtle)' }}>
                <span className="text-[10px] uppercase tracking-wider mr-2" style={{ color: 'var(--steel-silver)' }}>You:</span>
                <span style={{ color: 'var(--bright-silver)' }}>{captions.user}</span>
              </div>
            )}
            {captions.agent && (
              <div className="text-[13px] p-2.5 rounded-lg" style={{ backgroundColor: 'rgba(14, 14, 20, 0.8)', backdropFilter: 'blur(8px)', border: '1px solid rgba(0, 191, 255, 0.3)' }}>
                <span className="text-[10px] uppercase tracking-wider mr-2" style={{ color: 'var(--steel-silver)' }}>AI:</span>
                <span style={{ color: 'var(--bright-silver)' }}>{captions.agent}</span>
                {isProcessing && <Loader2 className="inline-block w-3 h-3 ml-2 animate-spin" style={{ color: 'var(--siren-red)' }} />}
              </div>
            )}
          </div>
        )}

        {/* Session controls */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 z-10">
          {!isActive ? (
            <button
              onClick={handleStart}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-medium transition-all hover:scale-105"
              style={{ backgroundColor: 'var(--siren-red)', color: 'white', boxShadow: '0 4px 20px rgba(238, 28, 28, 0.4)' }}
            >
              <Mic className="w-4 h-4" />
              Start Voice Call
            </button>
          ) : (
            <>
              {/* Mute */}
              <button
                onClick={handleMute}
                className="flex items-center justify-center w-11 h-11 rounded-full transition-all hover:scale-105"
                style={{
                  backgroundColor: isMuted ? 'rgba(238, 28, 28, 0.2)' : 'var(--surface-raised)',
                  border: '1px solid var(--border-subtle)',
                  color: isMuted ? 'var(--siren-red)' : 'var(--steel-silver)',
                }}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>

              {/* End call */}
              <button
                onClick={handleEnd}
                className="flex items-center justify-center w-11 h-11 rounded-full transition-all hover:scale-105"
                style={{ backgroundColor: 'var(--siren-red)', color: 'white' }}
                title="End call"
              >
                <PhoneOff className="w-4 h-4" />
              </button>

              {/* Volume indicator */}
              <div className="flex items-center gap-1 px-3 py-2 rounded-full" style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
                <Volume2 className="w-3.5 h-3.5" style={{ color: 'var(--steel-silver)' }} />
                <div className="w-16 h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--border-subtle)' }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${amplitude * 100}%`, backgroundColor: 'var(--siren-red)' }} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <AvatarDiagnosticsSheetHost
        open={diagnosticsOpen}
        variant="drawer"
        snapshot={visibleDiagnosticsSnapshot}
        onOpenChange={setDiagnosticsOpen}
        onRefresh={() => setDiagnosticsRefreshToken((token) => token + 1)}
      />
    </div>
  );
}
