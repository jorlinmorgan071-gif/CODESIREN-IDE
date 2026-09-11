// app/src/components/settings/ProviderCard.tsx
// UPR Phase 1 Step 3 — data-driven settings-panel card for one provider.
//
// Renders: API URL field, API Key field, model dropdown (populated from loaded
// models[]), "Test & load models" button, capability line showing context/
// output tokens for the selected model.
//
// This is a SINGLE card component that renders any provider — not one
// hardcoded card per provider. The card reads from the ProviderRegistry on
// the server via api.listProviders() + api.testProvider().

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import type { ProviderEntry, ProviderModel } from '@/types';
import { Loader2, CheckCircle, XCircle, RefreshCw, Eye, EyeOff } from 'lucide-react';

interface ProviderCardProps {
  provider: ProviderEntry;
  onUpdated: () => void;  // callback to refetch the provider list
}

export function ProviderCard({ provider, onUpdated }: ProviderCardProps) {
  const [apiUrl, setApiUrl] = useState(provider.apiUrl);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [testResult, setTestResult] = useState<{ success: boolean; error: string | null; durationMs: number } | null>(null);

  // Sync apiUrl when provider prop changes (e.g. after refetch)
  useEffect(() => {
    setApiUrl(provider.apiUrl);
  }, [provider.apiUrl]);

  // Auto-select the first model when models are loaded
  useEffect(() => {
    if (provider.models.length > 0 && !selectedModel) {
      setSelectedModel(provider.models[0].id);
    }
  }, [provider.models, selectedModel]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Send the current form values (apiKey, apiUrl) along with the test
      // request so the user doesn't have to "save" before testing.
      const result = await api.testProvider(provider.id, {
        apiKey: apiKey || undefined,  // only send if user typed a new key
        apiUrl: apiUrl !== provider.apiUrl ? apiUrl : undefined,
      });
      setTestResult({
        success: result.success,
        error: result.error,
        durationMs: result.durationMs,
      });
      onUpdated();  // refetch the provider list to get updated models[]
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setTestResult({
        success: false,
        error: errorMsg,
        durationMs: 0,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      const patch: { apiUrl?: string; apiKey?: string } = {};
      if (apiUrl !== provider.apiUrl) patch.apiUrl = apiUrl;
      if (apiKey) patch.apiKey = apiKey;
      if (Object.keys(patch).length > 0) {
        await api.updateProvider(provider.id, patch);
        setApiKey('');  // clear the input after save
        onUpdated();
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[provider-card] save failed for ${provider.id}:`, errorMsg);
    }
  };

  // Find the selected model object for the capability line
  const selectedModelObj: ProviderModel | undefined = provider.models.find((m) => m.id === selectedModel);

  return (
    <div
      className="rounded-lg p-4"
      style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-[13px] font-medium" style={{ color: 'var(--bright-silver)' }}>
            {provider.displayName}
          </h4>
          <p className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
            {provider.category.toUpperCase()} provider
          </p>
        </div>
        <div className="flex items-center gap-2">
          {provider.connectionTested && (
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded" style={{ backgroundColor: 'rgba(34, 197, 94, 0.1)', color: '#22C55E' }}>
              <CheckCircle className="w-3 h-3" />
              Tested
            </span>
          )}
          {provider.lastError && (
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded" style={{ backgroundColor: 'rgba(238, 28, 28, 0.1)', color: 'var(--siren-red)' }}>
              <XCircle className="w-3 h-3" />
              Error
            </span>
          )}
          {provider.modelCount > 0 && (
            <span className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
              {provider.modelCount} models
            </span>
          )}
        </div>
      </div>

      {/* API URL field */}
      <div className="mb-2">
        <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
          API URL
        </label>
        <input
          type="text"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          className="w-full mt-1 px-2 py-1.5 rounded text-[11px] font-code"
          style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--bright-silver)', border: '1px solid var(--border-subtle)' }}
          placeholder={provider.defaultApiUrl}
        />
      </div>

      {/* API Key field */}
      <div className="mb-3">
        <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
          API Key
          {provider.apiKeyIsSet && !apiKey && (
            <span className="ml-2 text-[9px]" style={{ color: 'var(--muted-silver)' }}>
              (currently set — type a new key to replace)
            </span>
          )}
        </label>
        <div className="relative mt-1">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-2 py-1.5 pr-8 rounded text-[11px] font-code"
            style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--bright-silver)', border: '1px solid var(--border-subtle)' }}
            placeholder={provider.apiKeyIsSet ? '••••••••' : 'Enter API key'}
          />
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2"
            onClick={() => setShowKey(!showKey)}
            style={{ color: 'var(--muted-silver)' }}
          >
            {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Test & load models button */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={handleTest}
          disabled={testing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ backgroundColor: 'var(--siren-red)', color: 'white' }}
        >
          {testing ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Testing...
            </>
          ) : (
            <>
              <RefreshCw className="w-3 h-3" />
              Test &amp; load models
            </>
          )}
        </button>
        <button
          onClick={handleSave}
          className="px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:bg-white/5"
          style={{ color: 'var(--steel-silver)', border: '1px solid var(--border-subtle)' }}
        >
          Save
        </button>
      </div>

      {/* Test result / error display */}
      {testResult && (
        <div
          className="mb-3 px-3 py-2 rounded text-[10px]"
          style={{
            backgroundColor: testResult.success ? 'rgba(34, 197, 94, 0.06)' : 'rgba(238, 28, 28, 0.06)',
            border: `1px solid ${testResult.success ? 'rgba(34, 197, 94, 0.3)' : 'rgba(238, 28, 28, 0.3)'}`,
            color: testResult.success ? '#22C55E' : 'var(--siren-red)',
          }}
        >
          {testResult.success ? (
            <>✓ Loaded {provider.modelCount} models in {testResult.durationMs}ms</>
          ) : (
            <>✗ {testResult.error ?? 'Unknown error'}</>
          )}
        </div>
      )}

      {/* Persistent error from previous test (from server state) */}
      {!testResult && provider.lastError && (
        <div
          className="mb-3 px-3 py-2 rounded text-[10px]"
          style={{
            backgroundColor: 'rgba(238, 28, 28, 0.06)',
            border: '1px solid rgba(238, 28, 28, 0.3)',
            color: 'var(--siren-red)',
          }}
        >
          ✗ {provider.lastError}
        </div>
      )}

      {/* Model dropdown */}
      {provider.models.length > 0 && (
        <div className="mb-3">
          <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
            Model
          </label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full mt-1 px-2 py-1.5 rounded text-[11px]"
            style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--bright-silver)', border: '1px solid var(--border-subtle)' }}
          >
            {provider.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id}) {m.freeOrPaid === 'free' ? '— Free' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Capability line — context/output tokens for the selected model */}
      {selectedModelObj && (
        <div
          className="px-3 py-2 rounded text-[10px]"
          style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="flex items-center gap-4 flex-wrap">
            <span style={{ color: 'var(--steel-silver)' }}>
              Context: <strong style={{ color: 'var(--bright-silver)' }}>
                {selectedModelObj.contextWindow > 0
                  ? `${(selectedModelObj.contextWindow / 1000).toFixed(0)}K`
                  : 'not reported'}
              </strong>
            </span>
            <span style={{ color: 'var(--steel-silver)' }}>
              Output: <strong style={{ color: 'var(--bright-silver)' }}>
                {selectedModelObj.maxOutputTokens > 0
                  ? `${selectedModelObj.maxOutputTokens.toLocaleString()}`
                  : 'not reported'}
              </strong>
            </span>
            <span style={{ color: 'var(--steel-silver)' }}>
              Cost: <strong style={{ color: selectedModelObj.freeOrPaid === 'free' ? '#22C55E' : 'var(--bright-silver)' }}>
                {selectedModelObj.costTier}
              </strong>
            </span>
            {selectedModelObj.supportsVision && (
              <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(59, 130, 246, 0.1)', color: '#3B82F6' }}>
                Vision
              </span>
            )}
            {selectedModelObj.supportsToolUse && (
              <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(168, 85, 247, 0.1)', color: '#A855F7' }}>
                Tool-use
              </span>
            )}
          </div>
          {selectedModelObj.pricingNote && (
            <div className="mt-1" style={{ color: 'var(--muted-silver)' }}>
              {selectedModelObj.pricingNote}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
