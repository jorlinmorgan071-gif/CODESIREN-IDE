import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '@/store/AppContext';
import { api } from '@/lib/api';
import { Cpu, Minus, Square, X, ChevronDown, Zap, LayoutDashboard } from 'lucide-react';

// D10 #4 closeout — previously this file hardcoded a `models` array of 7
// provider names ('Ollama 3', 'Claude 3.5 Sonnet', 'GPT-4o', 'Gemini Pro',
// 'DeepSeek Coder', 'Llama 3.1', 'Mistral Large') and showed a permanently
// pulsing "AI Online" green dot regardless of whether any model provider
// was actually configured. ChatInput.tsx and SettingsModal.tsx already
// fetched /api/models/engines for real availability, but TitleBar ignored it.
//
// Now TitleBar fetches the same /api/models/engines endpoint, renders the
// real engine list (name + availability), gates the "AI Online" badge on
// real availability of at least one non-stub engine, and shows "AI Offline"
// (gray dot, no pulse) when only the stub engine is available.

interface EngineInfo {
  id: string;
  name: string;
  available: boolean;
  models?: string[];
  activeModel?: string;
}

export function TitleBar() {
  const { state, setModel } = useApp();
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [preferredEngine, setPreferredEngine] = useState<string>('');
  const navigate = useNavigate();

  // Fetch real engine availability on mount and whenever the auth state changes.
  // Polls every 30s so the badge reflects provider config changes (e.g. user
  // adds an API key in SettingsModal → the badge turns green within 30s).
  useEffect(() => {
    if (!state.authToken) return;
    let cancelled = false;
    const fetchEngines = () => {
      api.listEngines()
        .then((response) => {
          if (cancelled) return;
          setEngines(response.engines);
          setPreferredEngine(response.preferredEngine);
        })
        .catch((error) => console.warn('[titlebar] engine list failed:', error instanceof Error ? error.message : error));
    };
    fetchEngines();
    const interval = setInterval(fetchEngines, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state.authToken]);

  // Real engines (exclude 'stub' from the "AI Online" determination — stub
  // is always available but means "no real LLM configured").
  const realEngines = engines.filter((e) => e.id !== 'stub');
  const anyRealEngineAvailable = realEngines.some((e) => e.available);
  const preferred = engines.find((e) => e.id === preferredEngine);
  // Display name: prefer the preferred engine's active model, fall back to
  // the engine name, fall back to 'No model configured'.
  const currentDisplayName = preferred?.activeModel
    ?? (preferred?.available ? preferred.name : undefined)
    ?? (anyRealEngineAvailable ? realEngines.find((e) => e.available)?.name : 'No model configured');

  return (
    <div
      className="h-9 flex items-center px-3 select-none"
      style={{
        backgroundColor: '#0A0A10',
        borderBottom: '1px solid #1E1E2A',
      }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 min-w-0 shrink-0">
        <div className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: 'var(--siren-red)' }}>
          <span className="text-white text-[10px] font-bold font-display">ZT</span>
        </div>
        <span className="text-xs font-medium" style={{ color: 'var(--bright-silver)' }}>
          Code Siren
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: '#1E1E2A', color: 'var(--steel-silver)' }}>
          v4.0
        </span>
        {/* Phase 4 — Control Center link */}
        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center gap-1 ml-2 px-2 py-0.5 rounded text-[11px] transition-colors hover:bg-white/5"
          style={{ color: 'var(--steel-silver)' }}
          title="Open Control Center (read-only dashboard)"
        >
          <LayoutDashboard className="w-3 h-3" />
          Dashboard
        </button>
      </div>

      {/* Center — Model & AI Status */}
      <div className="flex-1 flex items-center justify-center gap-3 min-w-0 overflow-hidden">
        <div className="flex items-center gap-1.5">
          <Zap
            className="w-3 h-3"
            style={{ color: anyRealEngineAvailable ? 'var(--siren-red)' : 'var(--muted-silver)' }}
          />
          <span className="text-[11px]" style={{ color: anyRealEngineAvailable ? 'var(--steel-silver)' : 'var(--muted-silver)' }}>
            {anyRealEngineAvailable ? 'AI Online' : 'AI Offline'}
          </span>
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              backgroundColor: anyRealEngineAvailable ? '#22C55E' : '#5A5A72',
              animation: anyRealEngineAvailable ? 'agent-pulse 2s ease-in-out infinite' : 'none',
            }}
          />
        </div>

        <div className="w-px h-3" style={{ backgroundColor: '#1E1E2A' }} />

        {/* Model Selector — real engine list, not hardcoded */}
        <div className="relative">
          <button
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors hover:bg-white/5"
            onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
            style={{ color: 'var(--bright-silver)' }}
          >
            <Cpu className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
            {currentDisplayName}
            <ChevronDown className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
          </button>

          {modelDropdownOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setModelDropdownOpen(false)} />
              <div
                className="absolute top-full left-0 mt-1 py-1 rounded-md z-50 min-w-[220px]"
                style={{
                  backgroundColor: '#15151E',
                  border: '1px solid #2A2A3C',
                  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.6)',
                }}
              >
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
                  Configured Engines
                </div>
                {engines.length === 0 && (
                  <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted-silver)' }}>
                    Loading engines…
                  </div>
                )}
                {engines.map((engine) => {
                  const isSelected = engine.available && (
                    engine.activeModel === state.currentModel ||
                    engine.name === state.currentModel ||
                    (engine.id === preferredEngine && !engine.activeModel)
                  );
                  return (
                    <button
                      key={engine.id}
                      className="w-full text-left px-3 py-1.5 text-[11px] transition-colors hover:bg-white/5 flex items-center gap-2"
                      style={{
                        color: isSelected ? 'var(--siren-red)' : (engine.available ? 'var(--bright-silver)' : 'var(--muted-silver)'),
                        opacity: engine.available ? 1 : 0.5,
                      }}
                      disabled={!engine.available}
                      onClick={() => {
                        // Prefer the active model name, fall back to engine name.
                        const chosen = engine.activeModel ?? engine.name;
                        setModel(chosen);
                        setModelDropdownOpen(false);
                      }}
                      title={engine.available ? undefined : 'Configure this engine in Settings → Models'}
                    >
                      {isSelected && (
                        <div className="w-1 h-1 rounded-full" style={{ backgroundColor: 'var(--siren-red)' }} />
                      )}
                      <span className="flex-1 truncate">
                        {engine.activeModel ?? engine.name}
                      </span>
                      {engine.id === 'stub' && (
                        <span className="text-[9px] px-1 rounded" style={{ backgroundColor: '#2A2A3C', color: 'var(--muted-silver)' }}>
                          fallback
                        </span>
                      )}
                      {!engine.available && engine.id !== 'stub' && (
                        <span className="text-[9px]" style={{ color: 'var(--muted-silver)' }}>
                          unavailable
                        </span>
                      )}
                    </button>
                  );
                })}
                <div className="px-3 py-1 mt-1 text-[10px] border-t" style={{ borderColor: '#2A2A3C', color: 'var(--muted-silver)' }}>
                  Add API keys in Settings → Models
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Window Controls */}
      <div className="flex items-center gap-0 min-w-0 shrink-0 justify-end">
        <button
          className="w-10 h-9 flex items-center justify-center transition-colors hover:bg-white/5"
          style={{ color: 'var(--steel-silver)' }}
        >
          <Minus className="w-3 h-3" />
        </button>
        <button
          className="w-10 h-9 flex items-center justify-center transition-colors hover:bg-white/5"
          style={{ color: 'var(--steel-silver)' }}
        >
          <Square className="w-3 h-3" />
        </button>
        <button
          className="w-10 h-9 flex items-center justify-center transition-colors hover:bg-red-600/20 hover:text-red-500"
          style={{ color: 'var(--steel-silver)' }}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
