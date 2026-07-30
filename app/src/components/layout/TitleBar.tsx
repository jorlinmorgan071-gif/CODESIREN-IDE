import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '@/store/AppContext';
import { Cpu, Minus, Square, X, ChevronDown, Zap, LayoutDashboard } from 'lucide-react';

const models = [
  'Ollama 3',
  'Claude 3.5 Sonnet',
  'GPT-4o',
  'Gemini Pro',
  'DeepSeek Coder',
  'Llama 3.1',
  'Mistral Large',
];

export function TitleBar() {
  const { state, setModel } = useApp();
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const navigate = useNavigate();

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
          <Zap className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
          <span className="text-[11px]" style={{ color: 'var(--steel-silver)' }}>
            AI Online
          </span>
          <span className="w-1.5 h-1.5 rounded-full animate-agent-pulse" style={{ backgroundColor: '#22C55E' }} />
        </div>

        <div className="w-px h-3" style={{ backgroundColor: '#1E1E2A' }} />

        {/* Model Selector */}
        <div className="relative">
          <button
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors hover:bg-white/5"
            onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
            style={{ color: 'var(--bright-silver)' }}
          >
            <Cpu className="w-3 h-3" style={{ color: 'var(--siren-red)' }} />
            {state.currentModel}
            <ChevronDown className="w-3 h-3" style={{ color: 'var(--steel-silver)' }} />
          </button>

          {modelDropdownOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setModelDropdownOpen(false)} />
              <div
                className="absolute top-full left-0 mt-1 py-1 rounded-md z-50 min-w-[180px]"
                style={{
                  backgroundColor: '#15151E',
                  border: '1px solid #2A2A3C',
                  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.6)',
                }}
              >
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
                  Select Model
                </div>
                {models.map((model) => (
                  <button
                    key={model}
                    className="w-full text-left px-3 py-1.5 text-[11px] transition-colors hover:bg-white/5 flex items-center gap-2"
                    style={{ color: state.currentModel === model ? 'var(--siren-red)' : 'var(--bright-silver)' }}
                    onClick={() => {
                      setModel(model);
                      setModelDropdownOpen(false);
                    }}
                  >
                    {state.currentModel === model && (
                      <div className="w-1 h-1 rounded-full" style={{ backgroundColor: 'var(--siren-red)' }} />
                    )}
                    {model}
                  </button>
                ))}
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
