// app/src/pages/BrainView.tsx
// Brain Visualizer — 3D memory map.
// Renders REAL data from agent_memory via GET /api/memory.
// Uses THREE.InstancedMesh for scalable node rendering (1000+ nodes).
// Voice-reactive: core glow + node brightness react to VoiceSessionContext.amplitude.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import * as THREE from 'three';
import { useVoiceSession } from '@/store/VoiceSessionContext';
import { useApp } from '@/store/AppContext';
import { wsClient } from '@/lib/ws';
import { getToken } from '@/lib/auth';
import type { AgentEvent } from '@/types';
import { Brain, Trash2, X, Mic, MicOff, Loader2 } from 'lucide-react';

// ── Agent domain colors (from server/src/agents/*/index.ts) ───────────────

const AGENT_COLORS: Record<string, string> = {
  'architect-agent': '#EE1C1C',
  'backend-agent': '#22C55E',
  'code-review-agent': '#EE1C1C',
  'database-agent': '#F59E0B',
  'deployment-agent': '#D946EF',
  'devops-agent': '#8B5CF6',
  'documentation-agent': '#14B8A6',
  'extension-agent': '#06B6D4',
  'fabrication-agent': '#10B981',
  'frontend-agent': '#3B82F6',
  'memory-agent': '#A855F7',
  'operative-agent': '#F59E0B',
  'performance-agent': '#F97316',
  'prompt-engineer-agent': '#6366F1',
  'qa-tester-agent': '#EC4899',
  'research-agent': '#84CC16',
  'security-agent': '#EE1C1C',
  'sentinel-agent': '#8B5CF6',
  'terminal-agent': '#64748B',
  'ui-designer-agent': '#E11D48',
};
const DEFAULT_COLOR = '#8A8AA0';

function getAgentColor(agentId: string | null): string {
  return AGENT_COLORS[agentId ?? ''] ?? DEFAULT_COLOR;
}

// ── Types ────────────────────────────────────────────────────────────────

interface MemoryNode {
  id: string;
  content: string;
  agentId: string | null;
  sourceType: string | null;
  createdAt: number;
  // Runtime: position in 3D space
  position: [number, number, number];
  // Runtime: color as THREE.Color
  color: THREE.Color;
  // Runtime: drift offset for floating animation
  driftOffset: number;
  driftSpeed: number;
}

interface MemoryDetail {
  id: string;
  content: string;
  agentId: string | null;
  sourceType: string | null;
  createdAt: number;
}

// ── Galaxy background (distinct from Mission Control's code-rain) ─────────

function GalaxyBackground() {
  return (
    <>
      <Stars radius={300} depth={80} count={4000} factor={4} saturation={0.5} fade speed={1} />
      <fog attach="fog" args={['#07070B', 50, 300]} />
    </>
  );
}

// ── Central core sphere ──────────────────────────────────────────────────

function CoreSphere({ amplitude, searchPulse }: { amplitude: number; searchPulse: number }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;

    // Slow continuous rotation
    meshRef.current.rotation.y = t * 0.15;
    meshRef.current.rotation.x = t * 0.08;

    // Voice-reactive: glow intensity rises with amplitude
    const baseGlow = 0.3 + searchPulse * 0.7;
    const voiceGlow = amplitude * 0.5;
    const totalGlow = baseGlow + voiceGlow;

    if (glowRef.current) {
      const mat = glowRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = totalGlow * 0.4;
      const scale = 1 + totalGlow * 0.15;
      glowRef.current.scale.setScalar(scale);
    }

    // Core itself pulses slightly with amplitude
    const coreScale = 1 + amplitude * 0.08;
    meshRef.current.scale.setScalar(coreScale);
  });

  return (
    <group>
      {/* Inner solid sphere */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[3, 32, 32]} />
        <meshStandardMaterial
          color="#EE1C1C"
          emissive="#EE1C1C"
          emissiveIntensity={0.4 + amplitude * 0.4}
          roughness={0.3}
          metalness={0.7}
        />
      </mesh>
      {/* Outer glow shell */}
      <mesh ref={glowRef} scale={1.3}>
        <sphereGeometry args={[3, 32, 32]} />
        <meshBasicMaterial
          color="#EE1C1C"
          transparent
          opacity={0.15}
          side={THREE.BackSide}
        />
      </mesh>
      {/* Point light at core */}
      <pointLight color="#EE1C1C" intensity={2 + amplitude * 3} distance={50} decay={2} />
    </group>
  );
}

// ── Instanced node field ─────────────────────────────────────────────────
// Uses THREE.InstancedMesh so 1000+ nodes render in a single draw call.

function NodeField({
  nodes,
  amplitude,
  onNodeClick,
  selectedId,
  deletingIds,
}: {
  nodes: MemoryNode[];
  amplitude: number;
  onNodeClick: (node: MemoryNode) => void;
  selectedId: string | null;
  deletingIds: Set<string>;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tempColor = useMemo(() => new THREE.Color(), []);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const isDeleting = deletingIds.has(node.id);
      const isSelected = node.id === selectedId;

      // Floating drift: each node drifts independently
      const driftY = Math.sin(t * node.driftSpeed + node.driftOffset) * 0.5;
      const driftX = Math.cos(t * node.driftSpeed * 0.7 + node.driftOffset) * 0.3;
      const driftZ = Math.sin(t * node.driftSpeed * 0.5 + node.driftOffset * 1.3) * 0.3;

      // Delete animation: shrink + fade
      let scale = isSelected ? 1.5 : 1.0;
      if (isDeleting) {
        const deleteProgress = Math.min(1, (Date.now() - (deletingIds.size > 0 ? Date.now() : Date.now())) / 500);
        scale = 1.0 * (1 - deleteProgress);
      }

      // Voice-reactive: nodes brighten with amplitude
      const brightnessBoost = amplitude * 0.3;

      dummy.position.set(
        node.position[0] + driftX,
        node.position[1] + driftY,
        node.position[2] + driftZ,
      );
      dummy.scale.setScalar(Math.max(0.01, scale));
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);

      // Color with brightness boost
      tempColor.copy(node.color);
      tempColor.multiplyScalar(1 + brightnessBoost);
      meshRef.current.setColorAt(i, tempColor);
    }

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
  });

  // Handle clicks on instanced mesh
  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const instanceId = e.instanceId;
    if (instanceId === undefined) return;
    const node = nodes[instanceId];
    if (node) onNodeClick(node);
  }, [nodes, onNodeClick]);

  if (nodes.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, nodes.length]}
      onClick={handleClick}
    >
      <sphereGeometry args={[0.3, 12, 12]} />
      <meshStandardMaterial
        emissive="#ffffff"
        emissiveIntensity={0.15}
        roughness={0.4}
        metalness={0.3}
      />
    </instancedMesh>
  );
}

// ── Random position generator (scattered around core) ────────────────────

function randomPosition(): [number, number, number] {
  const radius = 8 + Math.random() * 25;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  return [
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
  ];
}

function createNodeFromMemory(entry: {
  id: string;
  content: string;
  agentId: string | null;
  sourceType: string | null;
  createdAt: number;
}): MemoryNode {
  return {
    ...entry,
    position: randomPosition(),
    color: new THREE.Color(getAgentColor(entry.agentId)),
    driftOffset: Math.random() * Math.PI * 2,
    driftSpeed: 0.3 + Math.random() * 0.5,
  };
}

// ── Main BrainView component ─────────────────────────────────────────────

export default function BrainView() {
  const { isActive, isMuted, amplitude, startSession, endSession, toggleMute } = useVoiceSession();
  // Auth-gate fix (Bug A): wait for AppContext.authReady before firing any
  // authenticated fetch. Without this, GET /api/memory fires before the
  // auto-login useEffect in AppContext has stored the JWT, gets a 401, and
  // surfaces "Failed to fetch" to the user.
  const { state: appState } = useApp();
  const authReady = appState.authReady;
  const [nodes, setNodes] = useState<MemoryNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [searchPulse, setSearchPulse] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const searchPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

  // ── Load initial memories ─────────────────────────────────────────────
  // Auth-gate fix (Bug A): do not fire GET /api/memory until authReady is
  // true (i.e. until the auto-login in AppContext has stored the JWT).
  // While waiting, leave loading=true so the UI shows a spinner, not an
  // error. Once authReady flips to true, the effect re-runs and fetches.
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    (async () => {
      try {
        const token = getToken();
        const res = await fetch(`${API_BASE}/memory?limit=500`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { entries: Array<{ id: string; content: string; agentId: string | null; sourceType: string | null; createdAt: number }> };
        if (cancelled) return;
        const newNodes = body.entries.map(createNodeFromMemory);
        setNodes(newNodes);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [API_BASE, authReady]);

  // ── WS listeners: memory:created, memory:deleted, memory:searched ────
  useEffect(() => {
    const offCreated = wsClient.on('memory:created' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { id: string; agentId: string | null; sourceType: string; contentPreview: string; createdAt: number };
      // Fetch the full entry to get all fields
      (async () => {
        try {
          const token = getToken();
          const res = await fetch(`${API_BASE}/memory/${payload.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return;
          const entry = await res.json() as { id: string; content: string; agentId: string | null; sourceType: string | null; createdAt: number };
          const newNode = createNodeFromMemory(entry);
          setNodes(prev => [...prev, newNode]);
        } catch { /* ignore fetch errors for live updates */ }
      })();
    });

    const offDeleted = wsClient.on('memory:deleted' as never, (evt: AgentEvent) => {
      const payload = evt.payload as { id: string };
      setNodes(prev => prev.filter(n => n.id !== payload.id));
      setDeletingIds(prev => { const s = new Set(prev); s.delete(payload.id); return s; });
      if (selectedNode?.id === payload.id) {
        setSelectedNode(null);
        setDetail(null);
      }
    });

    const offSearched = wsClient.on('memory:searched' as never, () => {
      // Pulse the core glow
      setSearchPulse(1);
      if (searchPulseTimer.current) clearTimeout(searchPulseTimer.current);
      searchPulseTimer.current = setTimeout(() => setSearchPulse(0), 800);
    });

    return () => { offCreated(); offDeleted(); offSearched(); };
  }, [API_BASE, selectedNode]);

  // ── Node click → fetch detail ─────────────────────────────────────────
  const handleNodeClick = useCallback(async (node: MemoryNode) => {
    setSelectedNode(node);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/memory/${node.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setDetail(await res.json());
      } else {
        // Fallback to node data if detail fetch fails (in-memory mode)
        setDetail({
          id: node.id,
          content: node.content,
          agentId: node.agentId,
          sourceType: node.sourceType,
          createdAt: node.createdAt,
        });
      }
    } catch {
      setDetail({
        id: node.id,
        content: node.content,
        agentId: node.agentId,
        sourceType: node.sourceType,
        createdAt: node.createdAt,
      });
    }
  }, [API_BASE]);

  // ── Delete memory ─────────────────────────────────────────────────────
  const handleDelete = useCallback(async (id: string) => {
    setDeleteConfirm(null);
    setDeletingIds(prev => new Set(prev).add(id));
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/memory/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // The memory:deleted WS event will remove the node from the scene.
      // But also remove locally in case WS doesn't reach us.
      setTimeout(() => {
        setNodes(prev => prev.filter(n => n.id !== id));
        setDeletingIds(prev => { const s = new Set(prev); s.delete(id); return s; });
        if (selectedNode?.id === id) {
          setSelectedNode(null);
          setDetail(null);
        }
      }, 500); // wait for shrink animation
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeletingIds(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, [API_BASE, selectedNode]);

  // ── Navigate back ─────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    window.history.back();
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col" style={{ backgroundColor: '#07070B' }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 shrink-0"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={handleBack}
            className="p-1.5 rounded-md transition-colors hover:bg-[var(--surface-raised)]"
            style={{ color: 'var(--steel-silver)' }}
          >
            <X className="w-4 h-4" />
          </button>
          <Brain className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
            Memory Brain
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--steel-silver)' }}>
            {nodes.length} nodes
          </span>
        </div>

        {/* Voice session controls (persistent — Section 6) */}
        <div className="flex items-center gap-2">
          {isActive && (
            <span className="text-[10px] flex items-center gap-1" style={{ color: 'var(--siren-red)' }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--siren-red)' }} />
              Voice session active
            </span>
          )}
          <button
            onClick={() => isActive ? endSession() : startSession('brain-session')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-colors"
            style={{
              backgroundColor: isActive ? 'rgba(238, 28, 28, 0.15)' : 'var(--surface-raised)',
              border: '1px solid var(--border-subtle)',
              color: isActive ? 'var(--siren-red)' : 'var(--steel-silver)',
            }}
          >
            {isActive ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
            {isActive ? 'End' : 'Start'} Voice
          </button>
          {isActive && (
            <button
              onClick={toggleMute}
              className="p-1.5 rounded-md transition-colors"
              style={{
                backgroundColor: isMuted ? 'rgba(238, 28, 28, 0.1)' : 'var(--surface-raised)',
                color: isMuted ? 'var(--siren-red)' : 'var(--steel-silver)',
              }}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* 3D Scene */}
      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--siren-red)' }} />
          </div>
        )}

        {error && (
          <div
            className="absolute top-4 left-1/2 -translate-x-1/2 z-10 px-3 py-2 rounded-md text-[12px]"
            style={{ backgroundColor: 'rgba(238, 28, 28, 0.15)', border: '1px solid rgba(238, 28, 28, 0.4)', color: 'var(--siren-red)' }}
          >
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
          </div>
        )}

        <Canvas
          camera={{ position: [0, 0, 40], fov: 60, near: 0.1, far: 500 }}
          gl={{ antialias: true, alpha: false }}
        >
          <color attach="background" args={['#07070B']} />
          <ambientLight intensity={0.15} />
          <GalaxyBackground />
          <CoreSphere amplitude={amplitude} searchPulse={searchPulse} />
          <NodeField
            nodes={nodes}
            amplitude={amplitude}
            onNodeClick={handleNodeClick}
            selectedId={selectedNode?.id ?? null}
            deletingIds={deletingIds}
          />
          <OrbitControls
            enablePan={true}
            enableZoom={true}
            enableRotate={true}
            minDistance={8}
            maxDistance={120}
            autoRotate={!isActive}
            autoRotateSpeed={0.3}
          />
        </Canvas>

        {/* Detail panel (slides in from right when a node is selected) */}
        {detail && (
          <div
            className="absolute top-0 right-0 h-full w-80 overflow-y-auto z-20"
            style={{
              backgroundColor: 'rgba(14, 14, 20, 0.9)',
              backdropFilter: 'blur(12px)',
              borderLeft: '1px solid var(--border-subtle)',
              padding: '16px',
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[12px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                Memory Detail
              </span>
              <button
                onClick={() => { setSelectedNode(null); setDetail(null); }}
                className="p-1 rounded transition-colors hover:bg-[var(--surface-raised)]"
                style={{ color: 'var(--muted-silver)' }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Agent color indicator */}
            <div className="flex items-center gap-2 mb-3">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: getAgentColor(detail.agentId) }}
              />
              <span className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                {detail.agentId ?? 'unknown agent'}
              </span>
            </div>

            {/* Fields */}
            <div className="space-y-2 text-[11px]">
              <div>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--muted-silver)' }}>ID</div>
                <div className="font-mono truncate" style={{ color: 'var(--steel-silver)' }}>{detail.id}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--muted-silver)' }}>Source Type</div>
                <div style={{ color: 'var(--steel-silver)' }}>{detail.sourceType ?? '—'}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--muted-silver)' }}>Created</div>
                <div style={{ color: 'var(--steel-silver)' }}>{new Date(detail.createdAt).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--muted-silver)' }}>Content</div>
                <div
                  className="mt-1 p-2.5 rounded-md text-[12px]"
                  style={{
                    backgroundColor: 'var(--void-black)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--bright-silver)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 300,
                    overflowY: 'auto',
                  }}
                >
                  {detail.content}
                </div>
              </div>
            </div>

            {/* Delete button */}
            <button
              onClick={() => setDeleteConfirm(detail.id)}
              className="w-full mt-4 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[11px] transition-colors"
              style={{
                backgroundColor: 'rgba(238, 28, 28, 0.1)',
                border: '1px solid rgba(238, 28, 28, 0.3)',
                color: 'var(--siren-red)',
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Memory
            </button>
          </div>
        )}

        {/* Delete confirmation dialog */}
        {deleteConfirm && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)' }}
          >
            <div
              className="rounded-lg p-5 max-w-sm"
              style={{
                backgroundColor: 'var(--surface-dark)',
                border: '1px solid var(--siren-red)',
                boxShadow: '0 0 40px rgba(238, 28, 28, 0.3)',
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Trash2 className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
                <span className="text-[13px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                  Delete this memory?
                </span>
              </div>
              <p className="text-[11px] mb-4" style={{ color: 'var(--steel-silver)' }}>
                This is permanent. The agent will no longer be able to recall this memory.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="px-3 py-1.5 rounded-md text-[11px] transition-colors"
                  style={{ border: '1px solid var(--border-subtle)', color: 'var(--steel-silver)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(deleteConfirm)}
                  className="px-3 py-1.5 rounded-md text-[11px] transition-colors"
                  style={{ backgroundColor: 'var(--siren-red)', color: 'white' }}
                >
                  Delete Permanently
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
