// app/src/components/avatar/AvatarUploadDialog.tsx
// Phase B: Custom VRM upload dialog.
//
// Flow:
//   1. User clicks "Add Custom Model" → file picker opens
//   2. User selects .vrm file → client-side analysis runs (VRM loaded in temp Canvas)
//   3. Analysis shows: format, size, expression count, preset names, mesh/material/
//      bone/texture/triangle counts, hasLookAt/hasSpringBone/hasHumanoid, issues
//   4. Live 3D preview with OrbitControls — user can rotate/zoom to inspect
//   5. Rename input — user can change the display name
//   6. Name conflict check (debounced) — shows red error if name is taken
//   7. Confirm → uploads file + metadata + thumbnail to /api/avatar/custom
//   8. On success: calls onUploaded(newAvatar) → picker refreshes

import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { Upload, X, Loader2, AlertTriangle, Check, RotateCcw } from 'lucide-react';
import { analyzeVrmFile, disposeVrm, type VrmAnalysisResult } from '@/lib/vrm-analyzer';
import { getToken } from '@/lib/auth';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

interface UploadedAvatar {
  id: string;
  name: string;
  format: string;
  [key: string]: unknown;
}

interface AvatarUploadDialogProps {
  onClose: () => void;
  onUploaded: (avatar: UploadedAvatar) => void;
}

type Stage = 'select' | 'analyzing' | 'review' | 'uploading' | 'success' | 'error';

export function AvatarUploadDialog({ onClose, onUploaded }: AvatarUploadDialogProps) {
  const [stage, setStage] = useState<Stage>('select');
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<VrmAnalysisResult | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [nameConflict, setNameConflict] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle file selection
  const handleFileSelect = useCallback(async (selectedFile: File) => {
    if (!selectedFile.name.toLowerCase().endsWith('.vrm')) {
      setErrorMsg('File must be a .vrm file');
      setStage('error');
      return;
    }

    setFile(selectedFile);
    setStage('analyzing');
    setErrorMsg('');

    try {
      const result = await analyzeVrmFile(selectedFile);
      setAnalysis(result);
      // Default name = filename without extension
      const baseName = selectedFile.name.replace(/\.vrm$/i, '');
      setDisplayName(baseName);
      setStage('review');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[avatar-upload] analysis failed:', err);
      setErrorMsg(msg ?? 'Failed to analyze VRM file');
      setStage('error');
    }
  }, []);

  // Debounced name conflict check
  useEffect(() => {
    if (stage !== 'review' || !displayName.trim()) {
      setNameConflict(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const token = getToken() ?? '';
        const res = await fetch(`${API_BASE}/avatar/custom/check-name?name=${encodeURIComponent(displayName)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as { conflict: boolean };
        setNameConflict(data.conflict);
      } catch {
        // network error — don't block, let the upload attempt catch it
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [displayName, stage]);

  // Upload to server
  const handleConfirm = useCallback(async () => {
    if (!file || !analysis) return;
    if (!displayName.trim()) {
      setErrorMsg('Name is required');
      return;
    }
    if (nameConflict) {
      setErrorMsg(`Name "${displayName}" is already taken`);
      return;
    }

    setStage('uploading');
    setErrorMsg('');

    try {
      const token = getToken() ?? '';
      const formData = new FormData();
      formData.append('file', file);

      // Capture thumbnail from analysis (convert Blob to File)
      if (analysis.thumbnail) {
        const thumbFile = new File([analysis.thumbnail], 'thumbnail.png', { type: 'image/png' });
        formData.append('thumbnail', thumbFile);
      }

      const metadata = {
        name: displayName.trim(),
        format: analysis.format,
        expressionCount: analysis.expressionCount,
        expressionPresets: analysis.expressionPresets,
        meshCount: analysis.meshCount,
        materialCount: analysis.materialCount,
        boneCount: analysis.boneCount,
        textureCount: analysis.textureCount,
        triangleCount: analysis.triangleCount,
        hasLookAt: analysis.hasLookAt,
        hasSpringBone: analysis.hasSpringBone,
        hasHumanoid: analysis.hasHumanoid,
        issues: analysis.issues,
      };
      formData.append('metadata', JSON.stringify(metadata));

      const res = await fetch(`${API_BASE}/avatar/custom`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json() as { error: string };
        throw new Error(data.error ?? `Upload failed (${res.status})`);
      }

      const data = await res.json() as { avatar: UploadedAvatar };
      setStage('success');
      setTimeout(() => {
        onUploaded(data.avatar);
      }, 800);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[avatar-upload] upload failed:', err);
      setErrorMsg(msg);
      setStage('error');
    }
  }, [file, analysis, displayName, nameConflict, onUploaded]);

  // Cleanup analysis VRM on unmount
  useEffect(() => {
    return () => {
      if (analysis) {
        disposeVrm(analysis);
      }
    };
  }, [analysis]);

  // Reset to select stage
  const handleReset = useCallback(() => {
    if (analysis) {
      disposeVrm(analysis);
    }
    setFile(null);
    setAnalysis(null);
    setDisplayName('');
    setNameConflict(false);
    setErrorMsg('');
    setStage('select');
  }, [analysis]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="relative w-[min(900px,95vw)] max-h-[90vh] rounded-2xl overflow-hidden flex flex-col"
        style={{
          backgroundColor: 'rgba(7, 7, 11, 0.95)',
          border: '1px solid rgba(238, 28, 28, 0.3)',
          boxShadow: '0 0 40px rgba(238, 28, 28, 0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'rgba(238, 28, 28, 0.2)' }}>
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
            <span className="text-[14px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
              Add Custom VRM Model
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 transition-colors">
            <X className="w-4 h-4" style={{ color: 'var(--steel-silver)' }} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {stage === 'select' && (
            <SelectStage onFileSelect={handleFileSelect} fileInputRef={fileInputRef} />
          )}

          {stage === 'analyzing' && (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--siren-red)' }} />
              <p className="mt-4 text-[13px]" style={{ color: 'var(--steel-silver)' }}>
                Analyzing VRM model...
              </p>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--muted-silver)' }}>
                Loading meshes, expressions, bones, and rendering preview
              </p>
            </div>
          )}

          {stage === 'review' && analysis && (
            <ReviewStage
              analysis={analysis}
              fileName={file?.name ?? ''}
              displayName={displayName}
              onDisplayNameChange={setDisplayName}
              nameConflict={nameConflict}
              onConfirm={handleConfirm}
              onReset={handleReset}
            />
          )}

          {stage === 'uploading' && (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--siren-red)' }} />
              <p className="mt-4 text-[13px]" style={{ color: 'var(--steel-silver)' }}>
                Uploading model...
              </p>
            </div>
          )}

          {stage === 'success' && (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)' }}>
                <Check className="w-6 h-6" style={{ color: '#22c55e' }} />
              </div>
              <p className="mt-4 text-[13px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                Model added successfully
              </p>
            </div>
          )}

          {stage === 'error' && (
            <div className="flex flex-col items-center justify-center py-20 px-8">
              <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ backgroundColor: 'rgba(238, 28, 28, 0.15)' }}>
                <AlertTriangle className="w-6 h-6" style={{ color: 'var(--siren-red)' }} />
              </div>
              <p className="mt-4 text-[13px] font-medium text-center" style={{ color: 'var(--bright-silver)' }}>
                {errorMsg}
              </p>
              <button
                onClick={handleReset}
                className="mt-5 px-4 py-2 rounded-lg text-[12px] transition-colors"
                style={{
                  backgroundColor: 'rgba(238, 28, 28, 0.15)',
                  border: '1px solid rgba(238, 28, 28, 0.3)',
                  color: 'var(--bright-silver)',
                }}
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Select stage ───────────────────────────────────────────────────────────
function SelectStage({ onFileSelect, fileInputRef }: { onFileSelect: (f: File) => void; fileInputRef: React.RefObject<HTMLInputElement | null> }) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div className="p-8">
      <input
        ref={fileInputRef}
        type="file"
        accept=".vrm"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFileSelect(f);
        }}
      />
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFileSelect(f);
        }}
        className="flex flex-col items-center justify-center py-16 rounded-xl cursor-pointer transition-all"
        style={{
          border: `2px dashed ${dragOver ? 'var(--siren-red)' : 'rgba(238, 28, 28, 0.3)'}`,
          backgroundColor: dragOver ? 'rgba(238, 28, 28, 0.05)' : 'rgba(255, 255, 255, 0.02)',
        }}
      >
        <Upload className="w-10 h-10" style={{ color: 'var(--siren-red)' }} />
        <p className="mt-4 text-[14px] font-medium" style={{ color: 'var(--bright-silver)' }}>
          Drop your .vrm file here, or click to browse
        </p>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--muted-silver)' }}>
          Max 100 MB · VRM 0.x and VRM 1.0 supported
        </p>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3 text-[11px]" style={{ color: 'var(--steel-silver)' }}>
        <div className="p-3 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}>
          <div className="font-medium mb-1" style={{ color: 'var(--bright-silver)' }}>Auto-analysis</div>
          <div>Loads the model client-side to count meshes, expressions, bones, and detect issues</div>
        </div>
        <div className="p-3 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}>
          <div className="font-medium mb-1" style={{ color: 'var(--bright-silver)' }}>Live preview</div>
          <div>Rotate and zoom to inspect the model before confirming the upload</div>
        </div>
        <div className="p-3 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}>
          <div className="font-medium mb-1" style={{ color: 'var(--bright-silver)' }}>Full integration</div>
          <div>Lip sync, expressions, blink, eye tracking — all work just like built-in avatars</div>
        </div>
      </div>
    </div>
  );
}

// ── Review stage ───────────────────────────────────────────────────────────
function ReviewStage({
  analysis,
  fileName,
  displayName,
  onDisplayNameChange,
  nameConflict,
  onConfirm,
  onReset,
}: {
  analysis: VrmAnalysisResult;
  fileName: string;
  displayName: string;
  onDisplayNameChange: (s: string) => void;
  nameConflict: boolean;
  onConfirm: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col md:flex-row" style={{ minHeight: '400px' }}>
      {/* Left: 3D preview */}
      <div className="flex-1 relative" style={{ minHeight: '350px', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <AnalysisPreview analysis={analysis} />
        <div className="absolute bottom-2 left-2 text-[10px] px-2 py-1 rounded" style={{ backgroundColor: 'rgba(0,0,0,0.6)', color: 'var(--muted-silver)' }}>
          Drag to rotate · Scroll to zoom
        </div>
      </div>

      {/* Right: stats + rename + confirm */}
      <div className="md:w-[340px] flex flex-col" style={{ borderLeft: '1px solid rgba(238, 28, 28, 0.15)' }}>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* File info */}
          <div>
            <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--muted-silver)' }}>Source File</div>
            <div className="text-[12px] font-medium truncate" style={{ color: 'var(--bright-silver)' }} title={fileName}>
              {fileName}
            </div>
          </div>

          {/* Rename input */}
          <div>
            <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--muted-silver)' }}>Display Name</div>
            <input
              type="text"
              value={displayName}
              onChange={(e) => onDisplayNameChange(e.target.value)}
              maxLength={60}
              placeholder="Enter a name..."
              className="w-full px-3 py-2 rounded-lg text-[13px] outline-none transition-colors"
              style={{
                backgroundColor: 'rgba(255,255,255,0.05)',
                border: `1px solid ${nameConflict ? 'var(--siren-red)' : 'rgba(238, 28, 28, 0.2)'}`,
                color: 'var(--bright-silver)',
              }}
            />
            {nameConflict && (
              <div className="mt-1 flex items-center gap-1 text-[11px]" style={{ color: 'var(--siren-red)' }}>
                <AlertTriangle className="w-3 h-3" />
                Name already taken — choose another
              </div>
            )}
            <div className="mt-1 text-[10px]" style={{ color: 'var(--muted-silver)' }}>
              Custom models get a red neon glow in the picker
            </div>
          </div>

          {/* Stats grid */}
          <div>
            <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>Model Stats</div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <Stat label="Format" value={`VRM ${analysis.format}`} />
              <Stat label="Expressions" value={String(analysis.expressionCount)} />
              <Stat label="Meshes" value={String(analysis.meshCount)} />
              <Stat label="Materials" value={String(analysis.materialCount)} />
              <Stat label="Bones" value={String(analysis.boneCount)} />
              <Stat label="Textures" value={String(analysis.textureCount)} />
              <Stat label="Triangles" value={analysis.triangleCount.toLocaleString()} />
              <Stat label="Spring Bone" value={analysis.hasSpringBone ? 'Yes' : 'No'} />
              <Stat label="Humanoid Rig" value={analysis.hasHumanoid ? 'Yes' : 'No'} />
              <Stat label="Eye Tracking" value={analysis.hasLookAt ? 'Yes' : 'No'} />
            </div>
          </div>

          {/* Expression presets */}
          {analysis.expressionPresets.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted-silver)' }}>
                Expression Presets ({analysis.expressionPresets.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {analysis.expressionPresets.map((preset) => (
                  <span
                    key={preset}
                    className="px-2 py-0.5 rounded text-[10px]"
                    style={{
                      backgroundColor: 'rgba(238, 28, 28, 0.1)',
                      border: '1px solid rgba(238, 28, 28, 0.2)',
                      color: 'var(--bright-silver)',
                    }}
                  >
                    {preset}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Issues */}
          {analysis.issues.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--siren-red)' }}>
                Issues Detected ({analysis.issues.length})
              </div>
              <div className="space-y-1">
                {analysis.issues.map((issue, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                    <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: 'var(--siren-red)' }} />
                    <span>{issue}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer: confirm / reset */}
        <div className="p-4 flex gap-2" style={{ borderTop: '1px solid rgba(238, 28, 28, 0.15)' }}>
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] transition-colors"
            style={{
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--steel-silver)',
            }}
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
          <button
            onClick={onConfirm}
            disabled={!displayName.trim() || nameConflict}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              backgroundColor: 'rgba(238, 28, 28, 0.2)',
              border: '1px solid rgba(238, 28, 28, 0.4)',
              color: 'var(--bright-silver)',
            }}
          >
            <Upload className="w-3 h-3" />
            Add Model
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2 rounded" style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}>
      <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>{label}</div>
      <div className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>{value}</div>
    </div>
  );
}

// ── 3D preview animator (MUST be inside <Canvas> — useFrame needs R3F context) ──
function PreviewAnimator({ vrm, groupRef }: { vrm: VRM | null; groupRef: React.RefObject<THREE.Group> }) {
  useFrame((state) => {
    if (!vrm) return;
    const delta = state.clock.getDelta();
    vrm.update(delta);
    // Simple breathing
    if (groupRef.current) {
      const tt = state.clock.elapsedTime;
      groupRef.current.position.y += Math.sin(tt * 0.5) * 0.001;
      // Blink
      const expr = vrm.expressionManager;
      if (expr) {
        const blink = (Math.sin(tt * 2) > 0.95) ? 1 : 0;
        expr.setValue('blink', blink);
        expr.update();
      }
    }
  });
  return null;
}

// ── 3D preview (reuses the analysis VRM, no re-load) ──────────────────────
function AnalysisPreview({ analysis }: { analysis: VrmAnalysisResult }) {
  const groupRef = useRef<THREE.Group>(null!);

  // Center + scale the model to fit the view
  useEffect(() => {
    if (!analysis.scene || !groupRef.current) return;
    const box = new THREE.Box3().setFromObject(analysis.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? 2 / maxDim : 1;
    analysis.scene.scale.setScalar(scale);
    analysis.scene.position.set(-center.x * scale, -center.y * scale + 0.5, -center.z * scale);
  }, [analysis.scene]);

  // useFrame is now in PreviewAnimator (inside the Canvas below).
  // Previously it was called here — OUTSIDE the Canvas — which threw
  // "R3F: Hooks can only be used within the Canvas component!" on every
  // render and crashed the WebGL context on dialog unmount.

  return (
    <Canvas camera={{ position: [0, 0.5, 3], fov: 35 }} gl={{ antialias: true, alpha: true }}>
      <ambientLight intensity={0.4} />
      <pointLight position={[0, 2, 3]} intensity={1} color="#00BFFF" />
      <pointLight position={[0, -2, 1]} intensity={0.5} color="#0088FF" />
      <Suspense fallback={null}>
        {analysis.scene && (
          <group ref={groupRef}>
            <primitive object={analysis.scene} />
            <PreviewAnimator vrm={analysis.vrm ?? null} groupRef={groupRef} />
          </group>
        )}
      </Suspense>
      <OrbitControls enablePan={false} enableZoom={true} minDistance={1.5} maxDistance={6} />
    </Canvas>
  );
}
