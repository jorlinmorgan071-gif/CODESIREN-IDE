// app/src/components/settings/SidecarInstallPanel.tsx
// Phase 3+ — Shared install UI for local sidecars (Kokoro + Whisper).
//
// Renders one of three states based on the install state:
//   1. Ready: green badge + "Ready" label (no button)
//   2. Not installed: shows disk space estimate + "Download" button
//   3. Installing: progress bar + plain-language status + Cancel button
//   4. Error: red badge + plain-language error + Retry button
//
// Used by both Kokoro (TTS, Voice API card) and Whisper (ASR, Tool API card).
// The parent ProviderCard passes the sidecar name + display info; this
// component handles all the install flow internally.

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import type { InstallProgress, SidecarName } from '@/types';
import { Loader2, Download, CheckCircle, XCircle, AlertTriangle, HardDrive, X } from 'lucide-react';

interface SidecarInstallPanelProps {
  sidecar: SidecarName;
  displayName: string;  // e.g. "Kokoro voice engine"
  onReady?: () => void;  // callback when install completes (parent can refetch status)
}

export function SidecarInstallPanel({ sidecar, displayName, onReady }: SidecarInstallPanelProps) {
  const [installState, setInstallState] = useState<{
    venvExists: boolean;
    depsInstalled: boolean;
    modelDownloaded: boolean;
    ready: boolean;
    isInstalling: boolean;
  } | null>(null);
  const [estimate, setEstimate] = useState<{
    estimatedSizeHuman: string;
    freeHuman: string;
    sufficient: boolean;
    insufficientByHuman: string;
  } | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Poll install state + estimate on mount
  const refreshState = useCallback(async () => {
    try {
      const [state, est] = await Promise.all([
        api.getInstallState(sidecar),
        api.getInstallEstimate(sidecar),
      ]);
      setInstallState(state);
      setEstimate({
        estimatedSizeHuman: est.estimatedSizeHuman,
        freeHuman: est.freeHuman,
        sufficient: est.sufficient,
        insufficientByHuman: est.insufficientByHuman,
      });
    } catch (err: unknown) {
      // Non-fatal — just don't show the estimate
      console.warn(`[install-panel:${sidecar}] state fetch failed:`, err);
    }
  }, [sidecar]);

  useEffect(() => {
    refreshState();
    // Poll every 10s when not installing (to detect external installs)
    const handle = setInterval(refreshState, 10_000);
    return () => clearInterval(handle);
  }, [refreshState]);

  // Cleanup any in-flight install on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  const handleInstall = async () => {
    if (isInstalling) return;
    // Pre-check disk space
    if (estimate && !estimate.sufficient) {
      setError(`Not enough free disk space. ${displayName} needs about ${estimate.estimatedSizeHuman}, but only ${estimate.freeHuman} is available. Free up at least ${estimate.insufficientByHuman} and try again.`);
      return;
    }

    setIsInstalling(true);
    setError(null);
    setProgress({
      phase: 'pre-check',
      percent: 0,
      label: `Checking system requirements for ${displayName}...`,
    });

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      await api.streamInstall(sidecar, (p) => {
        setProgress(p);
        if (p.phase === 'error') {
          setError(p.error ?? 'Install failed');
        }
      }, abort.signal);

      // Install completed — refresh state
      await refreshState();
      if (onReady) onReady();
    } catch (err: unknown) {
      // If it's an abort, don't show as error — user cancelled intentionally
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        // User cancelled — just refresh state, don't show error
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
      }
    } finally {
      setIsInstalling(false);
      abortRef.current = null;
      // Final state refresh
      await refreshState();
    }
  };

  const handleCancel = async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    try {
      await api.cancelInstall(sidecar);
    } catch (err: unknown) {
      console.warn(`[install-panel:${sidecar}] cancel failed:`, err);
    }
  };

  // ── Render: Ready state ───────────────────────────────────────────────
  if (installState?.ready && !isInstalling) {
    return (
      <div
        className="mb-3 px-3 py-2 rounded flex items-center gap-2"
        style={{
          backgroundColor: 'rgba(34, 197, 94, 0.06)',
          border: '1px solid rgba(34, 197, 94, 0.3)',
          color: '#22C55E',
        }}
      >
        <CheckCircle className="w-3 h-3" />
        <span className="text-[11px] font-medium">Installed + ready</span>
        <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
          (offline — no cloud API needed)
        </span>
      </div>
    );
  }

  // ── Render: Installing state ──────────────────────────────────────────
  if (isInstalling && progress) {
    const isError = progress.phase === 'error';
    const isCancelled = progress.phase === 'cancelled';
    return (
      <div
        className="mb-3 px-3 py-3 rounded"
        style={{
          backgroundColor: isError ? 'rgba(238, 28, 28, 0.06)' : 'var(--surface-raised)',
          border: `1px solid ${isError ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
        }}
      >
        {/* Progress bar */}
        {!isError && !isCancelled && (
          <>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-medium flex items-center gap-1.5" style={{ color: 'var(--bright-silver)' }}>
                {progress.phase === 'verify' ? <CheckCircle className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
                {progress.label}
              </span>
              <span className="text-[10px] font-mono" style={{ color: 'var(--steel-silver)' }}>
                {progress.percent}%
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-dark)' }}>
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${progress.percent}%`,
                  backgroundColor: 'var(--siren-red)',
                }}
              />
            </div>
            {progress.detail && (
              <div className="mt-1.5 text-[10px] font-mono truncate" style={{ color: 'var(--muted-silver)' }}>
                {progress.detail}
              </div>
            )}
            <button
              onClick={handleCancel}
              className="mt-2 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors hover:bg-white/5"
              style={{ color: 'var(--steel-silver)', border: '1px solid var(--border-subtle)' }}
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
          </>
        )}

        {/* Error state */}
        {isError && (
          <>
            <div className="flex items-start gap-2 mb-2">
              <XCircle className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: 'var(--siren-red)' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium" style={{ color: 'var(--siren-red)' }}>
                  Install failed
                </div>
                <div className="text-[10px] mt-0.5" style={{ color: 'var(--steel-silver)' }}>
                  {progress.error ?? 'Unknown error'}
                </div>
              </div>
            </div>
            <button
              onClick={handleInstall}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-medium transition-colors"
              style={{ backgroundColor: 'var(--siren-red)', color: 'white' }}
            >
              <Download className="w-3 h-3" />
              Try again
            </button>
          </>
        )}
      </div>
    );
  }

  // ── Render: Error state (non-install error from state fetch) ─────────
  if (error && !isInstalling) {
    return (
      <div
        className="mb-3 px-3 py-2 rounded"
        style={{
          backgroundColor: 'rgba(238, 28, 28, 0.06)',
          border: '1px solid rgba(238, 28, 28, 0.3)',
        }}
      >
        <div className="flex items-start gap-2 mb-2">
          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: 'var(--siren-red)' }} />
          <div className="flex-1 min-w-0">
            <div className="text-[10px]" style={{ color: 'var(--siren-red)' }}>
              {error}
            </div>
          </div>
        </div>
        <button
          onClick={() => { setError(null); handleInstall(); }}
          className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-medium transition-colors"
          style={{ backgroundColor: 'var(--siren-red)', color: 'white' }}
        >
          <Download className="w-3 h-3" />
          Try again
        </button>
      </div>
    );
  }

  // ── Render: Not installed (default Download button + estimate) ──────
  return (
    <div
      className="mb-3 px-3 py-2 rounded"
      style={{
        backgroundColor: 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <HardDrive className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
          <span className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>
            Offline engine
          </span>
          <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(107, 114, 128, 0.1)', color: 'var(--muted-silver)' }}>
            Not installed
          </span>
        </div>
        <button
          onClick={handleInstall}
          disabled={isInstalling}
          className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ backgroundColor: 'var(--siren-red)', color: 'white' }}
        >
          {isInstalling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          {isInstalling ? 'Starting...' : 'Download'}
        </button>
      </div>
      <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
        {displayName} runs entirely offline once installed.
        {estimate && (
          <>
            {' '}
            <span style={{ color: estimate.sufficient ? 'var(--steel-silver)' : '#F59E0B' }}>
              Needs ~{estimate.estimatedSizeHuman}
              {estimate.freeHuman !== 'unknown' && ` (you have ${estimate.freeHuman} free)`}
              {!estimate.sufficient && ` — not enough space, need ${estimate.insufficientByHuman} more`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
