// app/src/components/voice/ScreenIntelligence.tsx
// Phase B: Screen Intelligence — screen share + drag-and-drop image analysis.
//
// Three input paths, all feeding POST /api/orchestrator/vision:
//   1. Screen share button — getDisplayMedia(), capture one frame as PNG
//   2. Drag-and-drop — drop an image file anywhere on the page
//   3. Paste — Ctrl+V an image from clipboard
//
// Response displayed in InlineAI panel (same pattern as Explain).
// In-app "sharing active" indicator (supplementary to browser's native one).
//
// Privacy: no image retention. The frame is sent to the endpoint and
// discarded. The endpoint explicitly does not log image content.

import { useState, useEffect, useCallback, useRef } from 'react';
import { Monitor, Image as ImageIcon, Loader2 } from 'lucide-react';
import { getToken } from '@/lib/auth';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

export function ScreenIntelligence() {
  const [isSharing, setIsSharing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [dragOverlay, setDragOverlay] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);

  // Send image to the vision endpoint + dispatch result to InlineAI
  const analyzeImage = useCallback(async (dataUri: string, prompt: string) => {
    setIsAnalyzing(true);
    try {
      const token = getToken() ?? '';
      const res = await fetch(`${API_BASE}/orchestrator/vision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ image: dataUri, prompt }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Request failed' })) as { error: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as { analysis: string };

      // Dispatch to InlineAI panel (same pattern as explain)
      window.dispatchEvent(new CustomEvent('code-siren:vision-result', {
        detail: { analysis: data.analysis },
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      window.dispatchEvent(new CustomEvent('code-siren:vision-result', {
        detail: { error: msg },
      }));
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  // Screen share — getDisplayMedia + capture one frame
  const handleScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 }, // we only need one frame
        audio: false,
      });
      streamRef.current = stream;
      setIsSharing(true);

      // Wait for the track to be ready, then capture one frame
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();

      // Small delay to ensure the frame is rendered
      await new Promise(r => setTimeout(r, 300));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0);
      const dataUri = canvas.toDataURL('image/png');

      // Stop the stream immediately — we only needed one frame
      stream.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      setIsSharing(false);

      // Send to vision endpoint
      await analyzeImage(dataUri, 'Explain what is on screen. If there is an error message, identify it and suggest how to fix it.');
    } catch (err: unknown) {
      setIsSharing(false);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      // User cancelled the picker — don't show an error
      if (err instanceof Error && err.name === 'NotAllowedError') return;
      console.error('[screen-intelligence] screen share failed:', err);
    }
  }, [analyzeImage]);

  // Drag-and-drop handler — registered on window
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        setDragOverlay(true);
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) {
        setDragOverlay(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      const file = e.dataTransfer.files[0];
      if (!file.type.startsWith('image/')) return;

      e.preventDefault();
      setDragOverlay(false);

      const reader = new FileReader();
      reader.onload = async () => {
        const dataUri = reader.result as string;
        await analyzeImage(dataUri, 'Explain what is in this image. If there is an error message, identify it and suggest how to fix it.');
      };
      reader.readAsDataURL(file);
    };

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [analyzeImage]);

  // Paste handler — registered on window
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;

          e.preventDefault();
          const reader = new FileReader();
          reader.onload = async () => {
            const dataUri = reader.result as string;
            await analyzeImage(dataUri, 'Explain what is in this image. If there is an error message, identify it and suggest how to fix it.');
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [analyzeImage]);

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return (
    <>
      {/* Screen share button — bottom-right, next to the InlineAI FAB */}
      <button
        onClick={handleScreenShare}
        disabled={isAnalyzing}
        className="fixed bottom-4 right-16 w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-110 z-40"
        style={{
          backgroundColor: isSharing ? 'rgba(238, 28, 28, 0.2)' : 'rgba(14, 14, 20, 0.8)',
          border: `1px solid ${isSharing ? 'rgba(238, 28, 28, 0.4)' : 'var(--border-subtle)'}`,
          backdropFilter: 'blur(8px)',
          color: isSharing ? 'var(--siren-red)' : 'var(--steel-silver)',
        }}
        title="Share screen for analysis"
      >
        {isAnalyzing ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Monitor className="w-4 h-4" />
        )}
      </button>

      {/* In-app "sharing active" indicator */}
      {isSharing && (
        <div
          className="fixed top-12 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-1.5 rounded-full animate-pulse"
          style={{
            backgroundColor: 'rgba(238, 28, 28, 0.2)',
            border: '1px solid rgba(238, 28, 28, 0.5)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <Monitor className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>
            Screen sharing active
          </span>
        </div>
      )}

      {/* Drag-and-drop overlay */}
      {dragOverlay && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none"
          style={{
            backgroundColor: 'rgba(7, 7, 11, 0.8)',
            border: '2px dashed rgba(238, 28, 28, 0.4)',
          }}
        >
          <div className="flex flex-col items-center gap-3">
            <ImageIcon className="w-12 h-12" style={{ color: 'var(--siren-red)' }} />
            <span className="text-[14px] font-medium" style={{ color: 'var(--bright-silver)' }}>
              Drop image to analyze
            </span>
          </div>
        </div>
      )}
    </>
  );
}
