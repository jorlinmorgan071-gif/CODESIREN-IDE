import type { LucideIcon } from "lucide-react";
import { useState, useEffect } from 'react';
import { useApp } from '@/store/AppContext';
import { motion, AnimatePresence } from 'motion/react';
import type { ThemeName } from '@/types';
import { themes } from '@/store/themes';
import { api } from '@/lib/api';
import {
  X,
  Settings,
  Cpu,
  Palette,
  Puzzle,
  Shield,
  Rocket,
  ToggleLeft,
  ToggleRight,
  RefreshCw,
  Play,
  CircleDot,
  Sparkles,
  Bot,
} from 'lucide-react';

type SettingsTab = 'models' | 'themes' | 'extensions' | 'security' | 'deployment';

const settingsTabs: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: 'models', label: 'Model Router', icon: Cpu },
  { id: 'themes', label: 'Themes', icon: Palette },
  { id: 'extensions', label: 'Extensions', icon: Puzzle },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'deployment', label: 'Deployment', icon: Rocket },
];

const cloudModels = [
  { name: 'Claude 3.5 Sonnet', provider: 'Anthropic', context: '200K' },
  { name: 'GPT-4o', provider: 'OpenAI', context: '128K' },
  { name: 'Gemini Pro', provider: 'Google', context: '1M' },
];

const extensions = [
  { name: 'ESLint', version: '8.57.0', status: 'running' as const },
  { name: 'Prettier', version: '3.2.5', status: 'running' as const },
  { name: 'TypeScript Importer', version: '2.11.0', status: 'running' as const },
  { name: 'Tailwind CSS IntelliSense', version: '0.10.5', status: 'running' as const },
  { name: 'GitLens', version: '14.8.0', status: 'paused' as const },
  { name: 'Docker', version: '1.29.0', status: 'running' as const },
];

const deployments = [
  { platform: 'Vercel', status: 'connected' as const, lastDeploy: '2 hours ago' },
  { platform: 'Netlify', status: 'connected' as const, lastDeploy: '1 day ago' },
  { platform: 'GitHub', status: 'connected' as const, lastDeploy: '5 mins ago' },
  { platform: 'Railway', status: 'disconnected' as const, lastDeploy: 'never' },
  { platform: 'Docker Hub', status: 'connected' as const, lastDeploy: '3 days ago' },
];

export function SettingsModal() {
  const { state, toggleSettings, setTheme, setModel } = useApp();
  const [activeTab, setActiveTab] = useState<SettingsTab>('models');
  const [autoModel, setAutoModel] = useState(true);
  const [toggles, setToggles] = useState<Record<string, boolean>>({
    commandConfirm: true,
    secretDetection: true,
    depAudit: true,
    networkIsolation: false,
  });

  // ── Orchestrator settings state (directive Section 3) ──────────────────
  // Tier 1 chat model + orchestrator engine picker + approval mode.
  const [orchSettings, setOrchSettings] = useState<{
    engine: 'gemini-flash' | 'nvidia-nemotron';
    approvalMode: 'auto' | 'default';
    tier1Model: string;
  } | null>(null);
  const [orchEngines, setOrchEngines] = useState<Array<{ id: string; available: boolean; reason?: string }>>([]);
  const [orchTier1Models, setOrchTier1Models] = useState<Array<{ id: string; label: string; desc?: string }>>([]);
  const [orchLoading, setOrchLoading] = useState(false);

  // ── Ollama model picker state (Step 10+) ────────────────────────────────
  const [ollamaModels, setOllamaModels] = useState<Array<{ name: string; size?: number; parameter_size?: string; quantization_level?: string }>>([]);
  const [ollamaAvailable, setOllamaAvailable] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [activeOllamaModel, setActiveOllamaModel] = useState<string>('');
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [startingOllama, setStartingOllama] = useState(false);
  const [engines, setEngines] = useState<Array<{ id: string; name: string; available: boolean; models?: string[]; activeModel?: string }>>([]);

  const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

  const fetchOllamaModels = async () => {
    setOllamaLoading(true);
    try {
      const token = localStorage.getItem('code_siren_jwt');
      const res = await fetch(`${API_BASE}/models/ollama`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setOllamaAvailable(data.available);
      setOllamaModels(data.models ?? []);
      setOllamaError(data.error ?? null);
      setActiveOllamaModel(data.activeModel ?? '');
    } catch (err: unknown) {
      setOllamaError(err instanceof Error ? err.message : String(err));
    }
    setOllamaLoading(false);
  };

  const fetchEngines = async () => {
    try {
      const token = localStorage.getItem('code_siren_jwt');
      const res = await fetch(`${API_BASE}/models/engines`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setEngines(data.engines ?? []);
    } catch { /* ignore */ }
  };

  const startOllama = async () => {
    setStartingOllama(true);
    try {
      const token = localStorage.getItem('code_siren_jwt');
      const res = await fetch(`${API_BASE}/models/ollama/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.started) {
        setOllamaAvailable(true);
        setOllamaModels(data.models ?? []);
        setOllamaError(null);
        await fetchEngines();
      } else {
        setOllamaError(data.error ?? 'Failed to start');
      }
    } catch (err: unknown) {
      setOllamaError(err instanceof Error ? err.message : String(err));
    }
    setStartingOllama(false);
  };

  const selectOllamaModel = async (model: string) => {
    try {
      const token = localStorage.getItem('code_siren_jwt');
      await fetch(`${API_BASE}/models/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model }),
      });
      setActiveOllamaModel(model);
      setModel(model);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (state.settingsVisible && activeTab === 'models') {
      const t = setTimeout(() => { fetchOllamaModels(); fetchEngines(); }, 0);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.settingsVisible, activeTab]);

  // Load orchestrator settings (directive Section 3) when the models tab opens.
  useEffect(() => {
    if (state.settingsVisible && activeTab === 'models') {
      api.getOrchestratorSettings()
        .then((res) => {
          setOrchSettings(res.settings);
          setOrchEngines(res.availableEngines);
          setOrchTier1Models(res.tier1Models);
        })
        .catch((err) => console.warn('[settings] orchestrator load failed:', err));
    }
  }, [state.settingsVisible, activeTab]);

  const setOrchestratorEngine = async (engine: 'gemini-flash' | 'nvidia-nemotron') => {
    setOrchLoading(true);
    try {
      const res = await api.setOrchestratorSettings({ engine });
      setOrchSettings(res.settings);
    } catch (err) {
      console.warn('[settings] orchestrator engine set failed:', err);
    } finally {
      setOrchLoading(false);
    }
  };

  const setOrchestratorApprovalMode = async (approvalMode: 'auto' | 'default') => {
    setOrchLoading(true);
    try {
      const res = await api.setOrchestratorSettings({ approvalMode });
      setOrchSettings(res.settings);
    } catch (err) {
      console.warn('[settings] orchestrator approval mode set failed:', err);
    } finally {
      setOrchLoading(false);
    }
  };

  const setOrchestratorTier1Model = async (tier1Model: string) => {
    setOrchLoading(true);
    try {
      const res = await api.setOrchestratorSettings({ tier1Model });
      setOrchSettings(res.settings);
    } catch (err) {
      console.warn('[settings] orchestrator tier1 model set failed:', err);
    } finally {
      setOrchLoading(false);
    }
  };

  if (!state.settingsVisible) return null;

  const toggleSetting = (key: string) => {
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        onClick={toggleSettings}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="w-[700px] max-h-[500px] rounded-xl overflow-hidden flex"
          style={{
            backgroundColor: '#15151E',
            border: '1px solid #2A2A3C',
            boxShadow: '0 8px 48px rgba(0, 0, 0, 0.8)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Sidebar */}
          <div
            className="w-[180px] flex flex-col py-4"
            style={{
              backgroundColor: 'var(--surface-dark)',
              borderRight: '1px solid var(--border-subtle)',
            }}
          >
            <div className="px-4 mb-4 flex items-center gap-2">
              <Settings className="w-4 h-4" style={{ color: 'var(--siren-red)' }} />
              <span className="text-[13px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                Settings
              </span>
            </div>

            {settingsTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  className="flex items-center gap-2 px-4 py-2.5 text-[12px] transition-colors text-left"
                  style={{
                    backgroundColor: activeTab === tab.id ? 'rgba(238, 28, 28, 0.08)' : 'transparent',
                    color: activeTab === tab.id ? 'var(--bright-silver)' : 'var(--steel-silver)',
                    borderLeft: activeTab === tab.id ? '2px solid var(--siren-red)' : '2px solid transparent',
                  }}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: '1px solid var(--border-subtle)' }}
            >
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                {settingsTabs.find((t) => t.id === activeTab)?.label}
              </h2>
              <button
                className="p-2 rounded-lg transition-colors hover:bg-white/5"
                onClick={toggleSettings}
                style={{ color: 'var(--muted-silver)' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto p-5">
              {/* Models */}
              {activeTab === 'models' && (
                <div className="space-y-5">
                  {/* AUTO Mode */}
                  <div
                    className="p-4 rounded-lg"
                    style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-[13px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                          AUTO Model Router
                        </h3>
                        <p className="text-[11px] mt-0.5" style={{ color: 'var(--steel-silver)' }}>
                          Intelligently selects the best model for each task type
                        </p>
                      </div>
                      <button onClick={() => setAutoModel(!autoModel)}>
                        {autoModel ? (
                          <ToggleRight className="w-6 h-6" style={{ color: 'var(--siren-red)' }} />
                        ) : (
                          <ToggleLeft className="w-6 h-6" style={{ color: 'var(--muted-silver)' }} />
                        )}
                      </button>
                    </div>

                    {autoModel && (
                      <div className="mt-3 pt-3 space-y-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        {[
                          { task: 'Code Generation', model: 'DeepSeek Coder' },
                          { task: 'Architecture', model: 'Claude 3.5 Sonnet' },
                          { task: 'Documentation', model: 'GPT-4o' },
                          { task: 'Vision Tasks', model: 'Gemini Pro' },
                        ].map((route) => (
                          <div key={route.task} className="flex items-center justify-between py-1">
                            <span className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                              {route.task}
                            </span>
                            <span className="text-[11px]" style={{ color: 'var(--siren-red)' }}>
                              → {route.model}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Cloud Models */}
                  <div>
                    <h3 className="text-[12px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--steel-silver)' }}>
                      Cloud Models (OpenRouter)
                    </h3>
                    <div className="space-y-1">
                      {cloudModels.map((model) => (
                        <button
                          key={model.name}
                          className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors hover:bg-white/5 text-left"
                          style={{
                            backgroundColor: state.currentModel === model.name ? 'rgba(238, 28, 28, 0.08)' : 'var(--surface-dark)',
                            border: '1px solid var(--border-subtle)',
                          }}
                          onClick={() => setModel(model.name)}
                        >
                          <div className="flex items-center gap-2">
                            <Cpu className="w-3.5 h-3.5" style={{ color: 'var(--siren-red)' }} />
                            <div>
                              <div className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>
                                {model.name}
                              </div>
                              <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                                {model.provider} • {model.context} context
                              </div>
                            </div>
                          </div>
                          {state.currentModel === model.name && (
                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'var(--siren-red)' }} />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Local Models (Ollama) — LIVE from /api/models/ollama */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
                        Local Models (Ollama) {ollamaAvailable ? '● Online' : '● Offline'}
                      </h3>
                      <div className="flex items-center gap-1">
                        <button
                          className="p-1 rounded transition-colors hover:bg-white/5"
                          onClick={fetchOllamaModels}
                          title="Refresh model list"
                          style={{ color: 'var(--muted-silver)' }}
                        >
                          <RefreshCw className={`w-3 h-3 ${ollamaLoading ? 'animate-spin' : ''}`} />
                        </button>
                        {!ollamaAvailable && (
                          <button
                            className="p-1 rounded transition-colors hover:bg-white/5 flex items-center gap-1 text-[10px]"
                            onClick={startOllama}
                            disabled={startingOllama}
                            title="Start ollama serve"
                            style={{ color: 'var(--siren-red)' }}
                          >
                            {startingOllama ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                            {startingOllama ? 'Starting...' : 'Start'}
                          </button>
                        )}
                      </div>
                    </div>

                    {ollamaError && !ollamaAvailable && (
                      <div className="text-[10px] mb-2 p-2 rounded" style={{ color: '#F87171', backgroundColor: 'rgba(238,28,28,0.05)' }}>
                        {ollamaError}
                      </div>
                    )}

                    {ollamaAvailable && ollamaModels.length === 0 && (
                      <div className="text-[11px] p-3 rounded-lg" style={{ color: 'var(--steel-silver)', backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}>
                        Ollama is running but no models are installed. Run <code style={{ color: 'var(--siren-red)' }}>ollama pull llama3.2</code> to install a model.
                      </div>
                    )}

                    <div className="space-y-1">
                      {ollamaModels.map((model) => (
                        <button
                          key={model.name}
                          className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors hover:bg-white/5 text-left"
                          style={{
                            backgroundColor: activeOllamaModel === model.name ? 'rgba(34, 197, 94, 0.08)' : 'var(--surface-dark)',
                            border: activeOllamaModel === model.name ? '1px solid #22C55E' : '1px solid var(--border-subtle)',
                          }}
                          onClick={() => selectOllamaModel(model.name)}
                        >
                          <div className="flex items-center gap-2">
                            <Cpu className="w-3.5 h-3.5" style={{ color: '#22C55E' }} />
                            <div>
                              <div className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>
                                {model.name}
                              </div>
                              <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                                {model.parameter_size ?? 'unknown size'}
                                {model.quantization_level ? ` • ${model.quantization_level}` : ''}
                                {model.size ? ` • ${(model.size / 1e9).toFixed(1)}GB` : ''}
                              </div>
                            </div>
                          </div>
                          {activeOllamaModel === model.name && (
                            <CircleDot className="w-3.5 h-3.5" style={{ color: '#22C55E' }} />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Engine status */}
                  {engines.length > 0 && (
                    <div>
                      <h3 className="text-[12px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--steel-silver)' }}>
                        Engine Status
                      </h3>
                      <div className="space-y-1">
                        {engines.map((engine) => (
                          <div
                            key={engine.id}
                            className="flex items-center justify-between px-3 py-2 rounded-lg"
                            style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
                          >
                            <div className="flex items-center gap-2">
                              <div
                                className="w-1.5 h-1.5 rounded-full"
                                style={{ backgroundColor: engine.available ? '#22C55E' : '#6B7280' }}
                              />
                              <span className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>
                                {engine.name}
                              </span>
                            </div>
                            <span className="text-[10px]" style={{ color: engine.available ? '#22C55E' : 'var(--muted-silver)' }}>
                              {engine.available ? (engine.activeModel ?? 'available') : 'unavailable'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Agent Relay + Orchestrator (directive Section 3) ───── */}
                  <div
                    className="p-4 rounded-lg"
                    style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="text-[12px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                          Agent Relay + Orchestrator
                        </div>
                        <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                          Tier 1 chat model + project orchestrator + approval mode
                        </div>
                      </div>
                      {orchLoading && <RefreshCw className="w-3 h-3 animate-spin" style={{ color: 'var(--steel-silver)' }} />}
                    </div>

                    {/* Tier 1 model picker */}
                    <div className="mb-4">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Sparkles className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
                        <span className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                          Chat model (used for casual conversation)
                        </span>
                      </div>
                      <select
                        value={orchSettings?.tier1Model ?? ''}
                        onChange={(e) => setOrchestratorTier1Model(e.target.value)}
                        disabled={!orchSettings || orchLoading}
                        className="w-full bg-transparent text-[12px] outline-none rounded px-2 py-1.5"
                        style={{
                          color: 'var(--bright-silver)',
                          backgroundColor: 'var(--surface-raised)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        {orchTier1Models.length === 0 && <option value="">Loading…</option>}
                        {orchTier1Models.map((m) => (
                          <option key={m.id} value={m.id} style={{ backgroundColor: '#15151E' }}>
                            {m.label}{m.desc ? ` — ${m.desc}` : ''}
                          </option>
                        ))}
                      </select>
                      <div className="text-[10px] mt-1" style={{ color: 'var(--muted-silver)' }}>
                        Free OpenRouter models — used for 99% of conversations, no agents involved.
                      </div>
                    </div>

                    {/* Orchestrator engine picker */}
                    <div className="mb-4">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Bot className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
                        <span className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                          Orchestrator (used for project planning + milestone review)
                        </span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {orchEngines.map((eng) => {
                          const isActive = orchSettings?.engine === eng.id;
                          const isAvailable = eng.available;
                          const label = eng.id === 'gemini-flash'
                            ? 'Gemini 2.5 Flash (Google AI Studio key required)'
                            : 'NVIDIA Llama Nemotron (OpenRouter key — already configured)';
                          return (
                            <button
                              key={eng.id}
                              onClick={() => isAvailable && setOrchestratorEngine(eng.id as 'gemini-flash' | 'nvidia-nemotron')}
                              disabled={!isAvailable || orchLoading}
                              className="flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              style={{
                                backgroundColor: isActive ? 'rgba(238, 28, 28, 0.08)' : 'var(--surface-raised)',
                                border: `1px solid ${isActive ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                                cursor: isAvailable ? 'pointer' : 'not-allowed',
                              }}
                            >
                              <div
                                className="w-3 h-3 rounded-full flex-shrink-0"
                                style={{
                                  backgroundColor: isActive ? 'var(--siren-red)' : 'transparent',
                                  border: `1px solid ${isActive ? 'var(--siren-red)' : 'var(--muted-silver)'}`,
                                }}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-[12px] font-medium" style={{ color: isActive ? 'var(--siren-red)' : 'var(--bright-silver)' }}>
                                  {label}
                                </div>
                                {!isAvailable && (
                                  <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                                    Unavailable: {eng.reason ?? 'no API key set'}
                                  </div>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <div className="text-[10px] mt-1" style={{ color: 'var(--muted-silver)' }}>
                        Saves quota by only activating for real builds.
                      </div>
                    </div>

                    {/* Approval mode toggle */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                          Default approval mode
                        </span>
                        <div className="flex gap-1 p-1 rounded-md" style={{ backgroundColor: 'var(--surface-raised)' }}>
                          <button
                            onClick={() => setOrchestratorApprovalMode('default')}
                            disabled={orchLoading}
                            className="px-2.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                            style={{
                              backgroundColor: orchSettings?.approvalMode === 'default' ? 'var(--siren-red)' : 'transparent',
                              color: orchSettings?.approvalMode === 'default' ? 'white' : 'var(--steel-silver)',
                            }}
                          >
                            Default
                          </button>
                          <button
                            onClick={() => setOrchestratorApprovalMode('auto')}
                            disabled={orchLoading}
                            className="px-2.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                            style={{
                              backgroundColor: orchSettings?.approvalMode === 'auto' ? 'var(--siren-red)' : 'transparent',
                              color: orchSettings?.approvalMode === 'auto' ? 'white' : 'var(--steel-silver)',
                            }}
                          >
                            Auto
                          </button>
                        </div>
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                        {orchSettings?.approvalMode === 'auto'
                          ? 'Orchestrator reviews each milestone and advances automatically.'
                          : 'Orchestrator pauses after each milestone for your approval.'}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Themes */}
              {activeTab === 'themes' && (
                <div className="grid grid-cols-2 gap-3">
                  {Object.values(themes).map((theme) => (
                    <button
                      key={theme.name}
                      className="p-3 rounded-lg transition-all hover:scale-[1.02] text-left"
                      style={{
                        backgroundColor: theme.colors.surface,
                        border: state.currentTheme === theme.name ? `2px solid ${theme.colors.siren}` : '1px solid var(--border-subtle)',
                      }}
                      onClick={() => setTheme(theme.name as ThemeName)}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="w-8 h-8 rounded-md"
                          style={{
                            background: `linear-gradient(135deg, ${theme.colors.background} 50%, ${theme.colors.siren} 50%)`,
                            border: '1px solid var(--border-subtle)',
                          }}
                        />
                        <div>
                          <div className="text-[12px] font-medium" style={{ color: theme.colors.text }}>
                            {theme.label}
                          </div>
                          <div className="text-[10px] mt-0.5" style={{ color: theme.colors.siren }}>
                            {theme.colors.siren}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Extensions */}
              {activeTab === 'extensions' && (
                <div className="space-y-1">
                  {extensions.map((ext) => (
                    <div
                      key={ext.name}
                      className="flex items-center justify-between px-3 py-2.5 rounded-lg"
                      style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
                    >
                      <div className="flex items-center gap-2">
                        <Puzzle className="w-3.5 h-3.5" style={{ color: 'var(--steel-silver)' }} />
                        <div>
                          <div className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>
                            {ext.name}
                          </div>
                          <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                            v{ext.version}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div
                          className={`w-1.5 h-1.5 rounded-full ${ext.status === 'running' ? 'animate-agent-pulse' : ''}`}
                          style={{
                            backgroundColor: ext.status === 'running' ? '#22C55E' : ext.status === 'paused' ? '#F59E0B' : '#EE1C1C',
                          }}
                        />
                        <span
                          className="text-[10px] capitalize"
                          style={{ color: ext.status === 'running' ? '#22C55E' : 'var(--muted-silver)' }}
                        >
                          {ext.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Security */}
              {activeTab === 'security' && (
                <div className="space-y-4">
                  {/* Security Score */}
                  <div
                    className="p-4 rounded-lg flex items-center gap-4"
                    style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
                  >
                    <div className="relative w-14 h-14 flex-shrink-0">
                      <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
                        <circle cx="28" cy="28" r="24" fill="none" stroke="var(--border-subtle)" strokeWidth="4" />
                        <circle
                          cx="28" cy="28" r="24" fill="none"
                          stroke="#22C55E" strokeWidth="4" strokeLinecap="round"
                          strokeDasharray={`${2 * Math.PI * 24}`}
                          strokeDashoffset={`${2 * Math.PI * 24 * (1 - 87 / 100)}`}
                        />
                      </svg>
                      <span className="absolute inset-0 flex items-center justify-center text-[14px] font-bold" style={{ color: '#22C55E' }}>
                        87
                      </span>
                    </div>
                    <div>
                      <h3 className="text-[13px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                        Security Score
                      </h3>
                      <p className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
                        Your project is well-protected. 2 minor warnings found.
                      </p>
                    </div>
                  </div>

                  {/* Toggles */}
                  <div className="space-y-2">
                    {[
                      { key: 'commandConfirm', label: 'Command Execution Confirmation', desc: 'Always confirm before running terminal commands' },
                      { key: 'secretDetection', label: 'Secret Detection', desc: 'Scan for API keys and passwords in code' },
                      { key: 'depAudit', label: 'Dependency Audit', desc: 'Automatically audit npm packages for vulnerabilities' },
                      { key: 'networkIsolation', label: 'Network Isolation', desc: 'Sandbox AI-generated code from external network' },
                    ].map((setting) => (
                      <div
                        key={setting.key}
                        className="flex items-center justify-between px-3 py-3 rounded-lg"
                        style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
                      >
                        <div>
                          <div className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>
                            {setting.label}
                          </div>
                          <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                            {setting.desc}
                          </div>
                        </div>
                        <button onClick={() => toggleSetting(setting.key)}>
                          {toggles[setting.key] ? (
                            <ToggleRight className="w-5 h-5" style={{ color: 'var(--siren-red)' }} />
                          ) : (
                            <ToggleLeft className="w-5 h-5" style={{ color: 'var(--muted-silver)' }} />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Deployment */}
              {activeTab === 'deployment' && (
                <div className="space-y-1">
                  {deployments.map((deploy) => (
                    <div
                      key={deploy.platform}
                      className="flex items-center justify-between px-3 py-2.5 rounded-lg"
                      style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
                    >
                      <div className="flex items-center gap-2">
                        <Rocket className="w-3.5 h-3.5" style={{ color: deploy.status === 'connected' ? '#22C55E' : 'var(--muted-silver)' }} />
                        <div>
                          <div className="text-[12px]" style={{ color: 'var(--bright-silver)' }}>
                            {deploy.platform}
                          </div>
                          <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                            Last deploy: {deploy.lastDeploy}
                          </div>
                        </div>
                      </div>
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full capitalize"
                        style={{
                          backgroundColor: deploy.status === 'connected' ? 'rgba(34, 197, 94, 0.1)' : 'var(--surface-raised)',
                          color: deploy.status === 'connected' ? '#22C55E' : 'var(--muted-silver)',
                        }}
                      >
                        {deploy.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
