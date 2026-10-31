// app/src/pages/ModelRouter.tsx
// Dedicated model router screen — shows all LLM providers with their models,
// test & load functionality, and model metadata (context window, free/paid,
// vision, tool-use, pricing notes).
//
// This is the screen the user sees when they want to configure which AI
// models Code Siren uses. It's accessible via the /models route and the
// Dock's "Router" button.
//
// The screen shows:
//   1. All LLM providers (OpenRouter, Anthropic, OpenAI, DeepSeek, etc.)
//   2. For each: API key field, "Test & load" button, model list
//   3. Each model shows: name, context window, free/paid badge, vision
//      icon, tool-use icon, pricing note
//   4. A "Test all" button that tests every provider with an API key

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { api } from '@/lib/api';
import type { ProviderEntry, ProviderModel } from '@/types';
import {
  Loader2, CheckCircle, RefreshCw, Eye, EyeOff,
  Zap, Activity, AlertTriangle,
  Cpu, ChevronRight, Code,
} from 'lucide-react';

export default function ModelRouter() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingAll, setTestingAll] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; error: string | null; durationMs: number }>>({});

  const fetchProviders = useCallback(async () => {
    try {
      const data = await api.listProviders();
      // Only show LLM providers on this screen
      const llmProviders = (data.providers ?? []).filter((p) => p.category === 'llm');
      setProviders(llmProviders);
    } catch (err) {
      console.warn('[model-router] failed to fetch providers:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleTest = async (providerId: string) => {
    setTestResults((prev) => ({ ...prev, [providerId]: { success: false, error: null, durationMs: 0 } }));
    try {
      const result = await api.testProvider(providerId);
      setTestResults((prev) => ({
        ...prev,
        [providerId]: { success: result.success, error: result.error, durationMs: result.durationMs },
      }));
      if (result.success) {
        fetchProviders(); // Reload to get the loaded models
      }
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [providerId]: { success: false, error: err instanceof Error ? err.message : String(err), durationMs: 0 },
      }));
    }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    const configured = providers.filter((p) => p.apiKeyIsSet || p.id === 'lmstudio');
    for (const p of configured) {
      await handleTest(p.id);
    }
    setTestingAll(false);
  };

  const handleSaveKey = async (providerId: string, key: string) => {
    try {
      await api.updateProvider(providerId, { apiKey: key });
      fetchProviders();
    } catch (err) {
      console.warn('[model-router] failed to save key:', err);
    }
  };

  const configuredCount = providers.filter((p) => p.apiKeyIsSet || p.id === 'lmstudio').length;
  const workingCount = providers.filter((p) => p.models.length > 0).length;
  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);
  const freeModels = providers.reduce((sum, p) => sum + p.models.filter((m) => m.costTier === 'free').length, 0);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--void-black)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-3">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            <Cpu className="w-6 h-6" style={{ color: 'var(--siren-red)' }} />
          </motion.div>
          <div>
            <h1 className="text-lg font-medium" style={{ color: 'var(--bright-silver)' }}>Model Router</h1>
            <p className="text-[11px]" style={{ color: 'var(--muted-silver)' }}>
              {configuredCount} configured · {workingCount} working · {totalModels} models ({freeModels} free)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleTestAll}
            disabled={testingAll || configuredCount === 0}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-[11px] transition-colors disabled:opacity-50"
            style={{
              backgroundColor: 'rgba(238, 28, 28, 0.1)',
              border: '1px solid rgba(238, 28, 28, 0.3)',
              color: 'var(--siren-red)',
            }}
          >
            {testingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
            Test all ({configuredCount})
          </button>
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[11px] transition-colors hover:bg-white/5"
            style={{ color: 'var(--steel-silver)', border: '1px solid var(--border-subtle)' }}
          >
            <ChevronRight className="w-3 h-3 rotate-180" />
            Back to IDE
          </button>
        </div>
      </div>

      {/* Provider list */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--siren-red)' }} />
          </div>
        ) : providers.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[12px]" style={{ color: 'var(--muted-silver)' }}>No LLM providers found.</p>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto space-y-4">
            {providers.map((provider) => (
              <ProviderRouterCard
                key={provider.id}
                provider={provider}
                testResult={testResults[provider.id]}
                onTest={() => handleTest(provider.id)}
                onSaveKey={(key) => handleSaveKey(provider.id, key)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Provider card (focused on model routing) ───────────────────────────

interface ProviderRouterCardProps {
  provider: ProviderEntry;
  testResult?: { success: boolean; error: string | null; durationMs: number };
  onTest: () => void;
  onSaveKey: (key: string) => void;
}

function ProviderRouterCard({ provider, testResult, onTest, onSaveKey }: ProviderRouterCardProps) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleTest = async () => {
    if (apiKey) {
      onSaveKey(apiKey);
      setApiKey('');
    }
    setTesting(true);
    await onTest();
    setTesting(false);
    setExpanded(true);
  };

  const statusColor = provider.models.length > 0
    ? '#22C55E'
    : provider.apiKeyIsSet
    ? '#F59E0B'
    : 'var(--muted-silver)';
  const statusLabel = provider.models.length > 0
    ? `${provider.models.length} models loaded`
    : provider.apiKeyIsSet
    ? 'Key set — not tested'
    : 'No API key';

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        backgroundColor: 'var(--surface-dark)',
        border: `1px solid ${provider.models.length > 0 ? 'rgba(34, 197, 94, 0.2)' : 'var(--border-subtle)'}`,
      }}
    >
      {/* Provider header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: statusColor }}
          />
          <div>
            <div className="text-[13px] font-medium" style={{ color: 'var(--bright-silver)' }}>
              {provider.displayName}
            </div>
            <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
              {statusLabel}
              {provider.lastError && ` · ${provider.lastError}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* API key input */}
          {!provider.apiKeyIsSet && provider.id !== 'lmstudio' && (
            <div className="flex items-center gap-1">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste API key..."
                className="px-2 py-1 text-[11px] rounded-md outline-none w-40"
                style={{
                  backgroundColor: 'var(--void-black)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--bright-silver)',
                }}
              />
              <button onClick={() => setShowKey(!showKey)} className="p-1" style={{ color: 'var(--muted-silver)' }}>
                {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
          )}
          {/* Test & load button */}
          <button
            onClick={handleTest}
            disabled={testing || (!provider.apiKeyIsSet && !apiKey && provider.id !== 'lmstudio')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] transition-colors disabled:opacity-40"
            style={{
              backgroundColor: provider.models.length > 0 ? 'rgba(34, 197, 94, 0.1)' : 'rgba(238, 28, 28, 0.08)',
              border: `1px solid ${provider.models.length > 0 ? 'rgba(34, 197, 94, 0.2)' : 'rgba(238, 28, 28, 0.2)'}`,
              color: provider.models.length > 0 ? '#22C55E' : 'var(--siren-red)',
            }}
          >
            {testing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : provider.models.length > 0 ? (
              <CheckCircle className="w-3 h-3" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            {provider.models.length > 0 ? 'Loaded' : 'Test & load'}
          </button>
          {/* Expand models */}
          {provider.models.length > 0 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1.5 rounded-md transition-colors hover:bg-white/5"
              style={{ color: 'var(--steel-silver)' }}
            >
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* Test result */}
      {testResult && !testResult.success && testResult.error && (
        <div className="px-4 py-2 text-[10px]" style={{ color: 'var(--siren-red)', backgroundColor: 'rgba(238, 28, 28, 0.05)' }}>
          <AlertTriangle className="w-3 h-3 inline mr-1" />
          {testResult.error}
        </div>
      )}

      {/* Model list */}
      <AnimatePresence>
        {expanded && provider.models.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            <div className="p-3 space-y-1.5">
              {provider.models.map((model) => (
                <ModelRow key={model.id} model={model} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Model row — shows metadata for each loaded model ────────────────────

function ModelRow({ model }: { model: ProviderModel }) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-md"
      style={{ backgroundColor: 'var(--void-black)' }}
    >
      {/* Free / Paid badge */}
      <span
        className="text-[9px] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
        style={{
          backgroundColor: model.costTier === 'free' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(238, 28, 28, 0.1)',
          color: model.costTier === 'free' ? '#22C55E' : 'var(--siren-red)',
        }}
      >
        {model.freeOrPaid === 'free' ? 'FREE' : 'PAID'}
      </span>

      {/* Model name */}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium truncate" style={{ color: 'var(--bright-silver)' }}>
          {model.name}
        </div>
        <div className="text-[9px] truncate" style={{ color: 'var(--muted-silver)' }}>
          {model.id}
        </div>
      </div>

      {/* Context window */}
      {model.contextWindow > 0 && (
        <div className="flex items-center gap-1 text-[9px] flex-shrink-0" style={{ color: 'var(--steel-silver)' }}>
          <Activity className="w-2.5 h-2.5" />
          {(model.contextWindow / 1000).toFixed(0)}K ctx
        </div>
      )}

      {/* Vision capability */}
      {model.supportsVision && (
        <div className="flex items-center gap-1 text-[9px] flex-shrink-0" style={{ color: '#3B82F6' }} title="Supports vision">
          <Eye className="w-2.5 h-2.5" />
        </div>
      )}

      {/* Tool use capability */}
      {model.supportsToolUse && (
        <div className="flex items-center gap-1 text-[9px] flex-shrink-0" style={{ color: '#22C55E' }} title="Supports tool use / function calling">
          <Code className="w-2.5 h-2.5" />
        </div>
      )}

      {/* Pricing note */}
      {model.pricingNote && (
        <div className="text-[9px] flex-shrink-0 max-w-[120px] truncate" style={{ color: 'var(--muted-silver)' }} title={model.pricingNote}>
          {model.pricingNote}
        </div>
      )}
    </div>
  );
}
