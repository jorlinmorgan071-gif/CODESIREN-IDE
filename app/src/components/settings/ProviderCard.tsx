// app/src/components/settings/ProviderCard.tsx
// UPR Phase 1 Step 3 + Phase 2 Step 2a — data-driven settings-panel card.
//
// Renders: API URL field, API Key field, model/voice dropdown (populated from
// loaded models[] or voices[]), "Test & load" button, capability/voice line.
//
// For LLM category: shows model dropdown + context/output tokens capability line.
// For TTS category: shows voice dropdown + language/gender voice info + "Select"
//   button that calls api.selectVoice() to wire through system-wide.
//
// This is a SINGLE card component that renders any provider — not one
// hardcoded card per provider. The card reads from the ProviderRegistry on
// the server via api.listProviders() + api.testProvider().

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import type { ProviderEntry, ProviderModel, ProviderVoice, ProviderTool } from '@/types';
import { Loader2, CheckCircle, XCircle, RefreshCw, Eye, EyeOff, Volume2 } from 'lucide-react';

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
  // TTS-specific state
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [selectingVoice, setSelectingVoice] = useState(false);

  // Sync apiUrl when provider prop changes (e.g. after refetch)
  useEffect(() => {
    setApiUrl(provider.apiUrl);
  }, [provider.apiUrl]);

  // Auto-select the first model when models are loaded
  useEffect(() => {
    if (provider.models.length > 0 && !selectedModel) {
      setSelectedModel(provider.models[0].id);
    }
    // Fix #10: reset selectedModel if it's no longer in the models list
    // (e.g., after a re-test where the provider removed a model)
    if (selectedModel && provider.models.length > 0 && !provider.models.find((m) => m.id === selectedModel)) {
      setSelectedModel(provider.models[0].id);
    }
  }, [provider.models, selectedModel]);

  // TTS: auto-select the first voice when voices are loaded
  useEffect(() => {
    if (provider.category === 'tts' && provider.voices.length > 0) {
      // Use the server's selectedVoiceId if set, otherwise the first voice
      const voiceToSelect = provider.selectedVoiceId ?? provider.voices[0].id;
      if (selectedVoice !== voiceToSelect) {
        setSelectedVoice(voiceToSelect);
      }
    }
    // Reset if the selected voice is no longer in the list
    if (selectedVoice && provider.voices.length > 0 && !provider.voices.find((v) => v.id === selectedVoice)) {
      setSelectedVoice(provider.voices[0].id);
    }
  }, [provider.voices, provider.selectedVoiceId, selectedVoice, provider.category]);

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

  // TTS: select a voice system-wide — calls api.selectVoice() which calls
  // applyVoiceProvider() on the server to swap the active TTSProvider.
  const handleSelectVoice = async () => {
    if (!selectedVoice) return;
    setSelectingVoice(true);
    try {
      await api.selectVoice(provider.id, selectedVoice);
      onUpdated();  // refetch to get updated selectedVoiceId
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[provider-card] select voice failed for ${provider.id}:`, errorMsg);
    } finally {
      setSelectingVoice(false);
    }
  };

  // Find the selected model object for the capability line
  const selectedModelObj: ProviderModel | undefined = provider.models.find((m) => m.id === selectedModel);
  // Find the selected voice object for the voice info line
  const selectedVoiceObj: ProviderVoice | undefined = provider.voices.find((v) => v.id === selectedVoice);

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

      {/* Test & load button — label changes per category */}
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
              {provider.category === 'tts' ? 'Test & load voices' : 'Test & load models'}
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
            <>
              ✓ Loaded {provider.category === 'tts' ? provider.voiceCount : provider.modelCount}{' '}
              {provider.category === 'tts' ? 'voices' : 'models'} in {testResult.durationMs}ms
            </>
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

      {/* ── LLM: Model dropdown + capability line ─────────────────────── */}
      {provider.category === 'llm' && provider.models.length > 0 && (
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

      {/* LLM capability line — context/output tokens */}
      {provider.category === 'llm' && selectedModelObj && (
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

      {/* ── TTS: Voice dropdown + select button + voice info ──────────── */}
      {provider.category === 'tts' && provider.voices.length > 0 && (
        <div className="mb-3">
          <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
            Voice
          </label>
          <div className="flex items-center gap-2 mt-1">
            <select
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="flex-1 px-2 py-1.5 rounded text-[11px]"
              style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--bright-silver)', border: '1px solid var(--border-subtle)' }}
            >
              {provider.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} {v.language ? `(${v.language})` : ''}
                </option>
              ))}
            </select>
            <button
              onClick={handleSelectVoice}
              disabled={selectingVoice || !selectedVoice}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ backgroundColor: provider.selectedVoiceId === selectedVoice ? 'rgba(34, 197, 94, 0.1)' : 'var(--surface-raised)', color: provider.selectedVoiceId === selectedVoice ? '#22C55E' : 'var(--bright-silver)', border: '1px solid var(--border-subtle)' }}
            >
              {selectingVoice ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Volume2 className="w-3 h-3" />
              )}
              {provider.selectedVoiceId === selectedVoice ? 'Selected' : 'Select'}
            </button>
          </div>
        </div>
      )}

      {/* TTS voice info line — language/gender/accent for the selected voice */}
      {provider.category === 'tts' && selectedVoiceObj && (
        <div
          className="px-3 py-2 rounded text-[10px]"
          style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="flex items-center gap-4 flex-wrap">
            {selectedVoiceObj.language && (
              <span style={{ color: 'var(--steel-silver)' }}>
                Language: <strong style={{ color: 'var(--bright-silver)' }}>{selectedVoiceObj.language}</strong>
              </span>
            )}
            {selectedVoiceObj.gender && (
              <span style={{ color: 'var(--steel-silver)' }}>
                Gender: <strong style={{ color: 'var(--bright-silver)' }}>{selectedVoiceObj.gender}</strong>
              </span>
            )}
            {selectedVoiceObj.accent && (
              <span style={{ color: 'var(--steel-silver)' }}>
                Accent: <strong style={{ color: 'var(--bright-silver)' }}>{selectedVoiceObj.accent}</strong>
              </span>
            )}
            {provider.selectedVoiceId === selectedVoiceObj.id && (
              <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(34, 197, 94, 0.1)', color: '#22C55E' }}>
                Active system-wide
              </span>
            )}
          </div>
          {selectedVoiceObj.description && (
            <div className="mt-1" style={{ color: 'var(--muted-silver)' }}>
              {selectedVoiceObj.description}
            </div>
          )}
        </div>
      )}

      {/* TTS — no voices available (connection test only) */}
      {provider.category === 'tts' && provider.voices.length === 0 && provider.connectionTested && (
        <div className="px-3 py-2 rounded text-[10px]" style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--muted-silver)' }}>
          Connected. No voice list available — voices configured per-call.
        </div>
      )}

      {/* ── Tool: tool list + availability badges ─────────────────────── */}
      {provider.category === 'tool' && provider.tools.length > 0 && (
        <div className="mb-3">
          <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
            Available Tools ({provider.tools.length})
          </label>
          <div className="mt-1 space-y-1.5">
            {provider.tools.map((t: ProviderTool) => (
              <div
                key={t.name}
                className="flex items-start gap-2 px-3 py-2 rounded text-[10px]"
                style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium" style={{ color: 'var(--bright-silver)' }}>
                      {t.name}
                    </span>
                    {t.readOnly ? (
                      <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(34, 197, 94, 0.1)', color: '#22C55E' }}>
                        Read-only
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', color: '#F59E0B' }}>
                        Mutates
                      </span>
                    )}
                    {!t.available && (
                      <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(238, 28, 28, 0.1)', color: 'var(--siren-red)' }}>
                        Unavailable
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                    {t.description}
                  </div>
                  {t.unavailableReason && (
                    <div className="mt-0.5" style={{ color: 'var(--siren-red)' }}>
                      {t.unavailableReason}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
