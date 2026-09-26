// app/src/components/settings/ProviderCard.tsx
// Phase 3 — data-driven API Hub card.
//
// Renders: API URL field, API Key field, model/voice/tool/image/info dropdown,
// "Test & load" button, capability/voice line, "Reset key" button, "Delete"
// button (custom providers only), health-check status.
//
// Green badge = configured AND working (healthy=true).
// Yellow badge = configured but never tested.
// Red badge = configured but failing (lastError set OR healthy=false).
//
// The card reads from the API Hub on the server via api.listProviders() +
// api.testProvider(). The "Reset key" button calls api.resetProviderKey() —
// per the user's directive, "the key is fully gone and the system does not
// have any key until a new one is present."

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import type { ProviderEntry, ProviderModel, ProviderVoice, ProviderTool, ProviderImageModel, ProviderInfoEndpoint } from '@/types';
import { SidecarInstallPanel } from './SidecarInstallPanel';
import { Loader2, CheckCircle, XCircle, RefreshCw, Eye, EyeOff, Volume2, Trash2, KeyRound, Activity, AlertTriangle } from 'lucide-react';

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
  // Phase 3 — reset / delete / health-check state
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [healthChecking, setHealthChecking] = useState(false);

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

  // Phase 3 — Reset key: fully clears the API key + all loaded state.
  // Per the user's directive: "the key is fully gone and the system does not
  // have any key until a new one is present."
  const handleResetKey = async () => {
    if (!confirm(`Reset the API key for "${provider.displayName}"?\n\nThe key will be FULLY cleared. The system will have no key until you enter a new one and run "Test & load".`)) return;
    setResetting(true);
    try {
      await api.resetProviderKey(provider.id);
      setApiKey('');
      onUpdated();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[provider-card] reset key failed for ${provider.id}:`, errorMsg);
    } finally {
      setResetting(false);
    }
  };

  // Phase 3 — Delete custom provider (built-ins cannot be deleted).
  const handleDelete = async () => {
    if (!confirm(`Delete custom provider "${provider.displayName}"?\n\nThis cannot be undone. The provider will be removed from the API Hub entirely.`)) return;
    setDeleting(true);
    try {
      await api.deleteProvider(provider.id);
      onUpdated();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[provider-card] delete failed for ${provider.id}:`, errorMsg);
    } finally {
      setDeleting(false);
    }
  };

  // Phase 3 — Manually trigger a health check.
  const handleHealthCheck = async () => {
    setHealthChecking(true);
    try {
      await api.healthCheckProvider(provider.id);
      onUpdated();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[provider-card] health-check failed for ${provider.id}:`, errorMsg);
    } finally {
      setHealthChecking(false);
    }
  };

  // Find the selected model object for the capability line
  const selectedModelObj: ProviderModel | undefined = provider.models.find((m) => m.id === selectedModel);
  // Find the selected voice object for the voice info line
  const selectedVoiceObj: ProviderVoice | undefined = provider.voices.find((v) => v.id === selectedVoice);

  return (
    <div
      className="rounded-lg p-4"
      style={{
        backgroundColor: 'var(--surface-dark)',
        border: `1px solid ${provider.healthy ? 'rgba(34, 197, 94, 0.3)' : (provider.lastError ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)')}`,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h4 className="text-[13px] font-medium flex items-center gap-2" style={{ color: 'var(--bright-silver)' }}>
            {provider.displayName}
            {provider.isCustom && (
              <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(168, 85, 247, 0.1)', color: '#A855F7' }}>
                Custom
              </span>
            )}
          </h4>
          <p className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
            {provider.category.toUpperCase()} provider
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {/* Phase 3: Green = healthy, Yellow = untested, Red = failing */}
          {provider.healthy && (
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded" style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' }}>
              <CheckCircle className="w-3 h-3" />
              Working
            </span>
          )}
          {!provider.healthy && provider.connectionTested && !provider.lastError && (
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded" style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', color: '#F59E0B' }}>
              <AlertTriangle className="w-3 h-3" />
              Untested
            </span>
          )}
          {!provider.healthy && provider.lastError && (
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded" style={{ backgroundColor: 'rgba(238, 28, 28, 0.1)', color: 'var(--siren-red)' }}>
              <XCircle className="w-3 h-3" />
              Error
            </span>
          )}
          {!provider.apiKeyIsSet && provider.id !== 'kokoro' && provider.id !== 'code-siren-tools' && (
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded" style={{ backgroundColor: 'rgba(107, 114, 128, 0.1)', color: 'var(--muted-silver)' }}>
              No key
            </span>
          )}
          {provider.modelCount > 0 && (
            <span className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
              {provider.modelCount} models
            </span>
          )}
          {provider.voiceCount > 0 && (
            <span className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
              {provider.voiceCount} voices
            </span>
          )}
          {provider.toolCount > 0 && (
            <span className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
              {provider.toolCount} tools
            </span>
          )}
          {provider.imageModelCount > 0 && (
            <span className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
              {provider.imageModelCount} models
            </span>
          )}
          {provider.infoEndpointCount > 0 && (
            <span className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
              {provider.infoEndpointCount} endpoints
            </span>
          )}
        </div>
      </div>

      {/* Phase 3: Suggested action banner (shown when unhealthy + suggestedAction is set) */}
      {!provider.healthy && provider.suggestedAction && (
        <div
          className="mb-3 px-3 py-2 rounded text-[10px] flex items-start gap-2"
          style={{
            backgroundColor: 'rgba(245, 158, 11, 0.06)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            color: '#F59E0B',
          }}
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <strong>Suggested action:</strong> {provider.suggestedAction}
          </div>
        </div>
      )}

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

      {/* Action buttons — Test & load + Save + Phase 3: Reset key + Health check + Delete */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
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
              {provider.category === 'tts' ? 'Test & load voices' : 'Test & load'}
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
        {/* Phase 3 — Health check button */}
        <button
          onClick={handleHealthCheck}
          disabled={healthChecking}
          title="Run a health check now"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ color: 'var(--steel-silver)', border: '1px solid var(--border-subtle)' }}
        >
          {healthChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
          Check
        </button>
        {/* Phase 3 — Reset key (clears the key entirely per user's directive) */}
        <button
          onClick={handleResetKey}
          disabled={resetting}
          title="Clear the API key entirely — the system will have no key until you enter a new one"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ color: provider.apiKeyIsSet ? 'var(--siren-red)' : 'var(--muted-silver)', border: '1px solid var(--border-subtle)' }}
        >
          {resetting ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
          Reset key
        </button>
        {/* Phase 3 — Delete (custom providers only) */}
        {provider.isCustom && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            title="Delete this custom provider — cannot be undone"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed ml-auto"
            style={{ color: 'var(--siren-red)', border: '1px solid rgba(238, 28, 28, 0.3)' }}
          >
            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            Delete
          </button>
        )}
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

      {/* ── Phase 3+ — Local-model installer (Kokoro + Whisper) ──────────
          One button → venv created → deps installed → model downloaded → verified.
          Shared component handles all progress UI + resume + cancel. */}
      {(provider.id === 'kokoro' || provider.id === 'whisper') && (
        <SidecarInstallPanel
          sidecar={provider.id}
          displayName={provider.id === 'kokoro' ? 'Kokoro voice engine' : 'Whisper transcription engine'}
          onReady={onUpdated}
        />
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

      {/* ── Image/Video: model list + capability badges ─────────────── */}
      {provider.category === 'image-video' && provider.imageModels.length > 0 && (
        <div className="mb-3">
          <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
            Image/Video Models ({provider.imageModels.length})
          </label>
          <div className="mt-1 space-y-1.5">
            {provider.imageModels.map((m: ProviderImageModel) => (
              <div
                key={m.id}
                className="flex items-start gap-2 px-3 py-2 rounded text-[10px]"
                style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium" style={{ color: 'var(--bright-silver)' }}>
                      {m.name}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: m.outputType === 'video' ? 'rgba(168, 85, 247, 0.1)' : 'rgba(59, 130, 246, 0.1)', color: m.outputType === 'video' ? '#A855F7' : '#3B82F6' }}>
                      {m.outputType}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: m.costTier === 'free' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(245, 158, 11, 0.1)', color: m.costTier === 'free' ? '#22C55E' : '#F59E0B' }}>
                      {m.costTier}
                    </span>
                    {m.supportsImageToImage && (
                      <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(59, 130, 246, 0.1)', color: '#3B82F6' }}>
                        img2img
                      </span>
                    )}
                    {m.supportsVideo && (
                      <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ backgroundColor: 'rgba(168, 85, 247, 0.1)', color: '#A855F7' }}>
                        Video
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                    {m.id}
                    {m.resolutions.length > 0 && ` · ${m.resolutions.join(', ')}`}
                    {m.aspectRatios.length > 0 && ` · ${m.aspectRatios.join(', ')}`}
                  </div>
                  {m.pricingNote && (
                    <div className="mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                      {m.pricingNote}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Information: endpoint list + capability badges ───────────── */}
      {provider.category === 'information' && provider.infoEndpoints.length > 0 && (
        <div className="mb-3">
          <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
            Available Endpoints ({provider.infoEndpoints.length})
          </label>
          <div className="mt-1 space-y-1.5">
            {provider.infoEndpoints.map((ep: ProviderInfoEndpoint, idx: number) => (
              <div
                key={`${ep.path}-${idx}`}
                className="flex items-start gap-2 px-3 py-2 rounded text-[10px]"
                style={{ backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ backgroundColor: 'rgba(59, 130, 246, 0.1)', color: '#3B82F6' }}>
                      {ep.method}
                    </span>
                    <span className="font-mono font-medium" style={{ color: 'var(--bright-silver)' }}>
                      {ep.path}
                    </span>
                  </div>
                  <div className="mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                    {ep.description}
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 flex-wrap text-[9px]">
                    <span style={{ color: 'var(--steel-silver)' }}>
                      Required: <span style={{ color: 'var(--bright-silver)' }}>{ep.requiredParams.join(', ') || 'none'}</span>
                    </span>
                    {ep.optionalParams.length > 0 && (
                      <span style={{ color: 'var(--steel-silver)' }}>
                        Optional: <span style={{ color: 'var(--bright-silver)' }}>{ep.optionalParams.join(', ')}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
