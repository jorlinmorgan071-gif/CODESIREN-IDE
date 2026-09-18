// app/src/components/settings/AddCustomApiModal.tsx
// Phase 3 — "Add a custom API" wizard for the API Hub.
//
// Flow:
//   1. User clicks "Add a custom API" button in the API Hub
//   2. Modal opens with 4 fields:
//      - Display name (e.g. "My Custom News API")
//      - API URL (e.g. https://api.example.com/v1)
//      - API key (optional — some APIs don't require one)
//      - What does this API do? (5 options: model/tool/voice/image/info)
//   3. User clicks "Test API"
//      - Calls api.testCustomUrl({ apiUrl, apiKey, claimedCategory })
//      - Server probes the URL, returns detectedCategory + sampleResponse
//      - If detected != claimed, show a warning but allow save
//   4. User clicks "Save"
//      - Calls api.onboardProvider({ displayName, apiUrl, apiKey, whatDoesItDo })
//      - Server classifies + adds to registry
//      - Modal closes + parent refetches the provider list
//
// The modal is intentionally a single-step form (not a multi-step wizard) —
// all 4 fields are visible at once. The "Test API" button is optional; the
// user can skip it and go straight to "Save" (the server will probe on save).

import { useState } from 'react';
import { api } from '@/lib/api';
import type { OnboardingAnswer, ProviderCategory, TestUrlResult } from '@/types';
import { Loader2, X, FlaskConical, Save, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface AddCustomApiModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const CATEGORY_OPTIONS: { value: OnboardingAnswer; label: string; description: string; category: ProviderCategory }[] = [
  { value: 'generate-text',      label: 'Model API',         description: 'LLM chat / completion (OpenAI-compatible, OpenRouter, Anthropic, etc.)', category: 'llm' },
  { value: 'execute-tools',      label: 'Tool API',          description: 'MCP / tool execution (web search, code execution, custom tools)', category: 'tool' },
  { value: 'generate-speech',    label: 'Voice API',         description: 'Text-to-speech (ElevenLabs, OpenAI TTS, Kokoro, etc.)', category: 'tts' },
  { value: 'generate-images',    label: 'Image/Video API',   description: 'Image or video generation (DALL·E, Imagen, MiniMax, etc.)', category: 'image-video' },
  { value: 'fetch-information',   label: 'Information API',   description: 'Read-only data API (news, weather, stock, etc.)', category: 'information' },
];

export function AddCustomApiModal({ open, onClose, onSaved }: AddCustomApiModalProps) {
  const [displayName, setDisplayName] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [whatDoesItDo, setWhatDoesItDo] = useState<OnboardingAnswer>('fetch-information');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestUrlResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleTest = async () => {
    if (!apiUrl.trim()) {
      setError('Enter an API URL first.');
      return;
    }
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const claimedCategory = CATEGORY_OPTIONS.find((o) => o.value === whatDoesItDo)?.category;
      const result = await api.testCustomUrl({
        apiUrl: apiUrl.trim(),
        apiKey: apiKey || undefined,
        claimedCategory,
      });
      setTestResult(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!displayName.trim()) {
      setError('Enter a display name for this API.');
      return;
    }
    if (!apiUrl.trim() && whatDoesItDo !== 'generate-speech') {
      setError('Enter an API URL. (Voice providers may skip this.)');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.onboardProvider({
        displayName: displayName.trim(),
        apiUrl: apiUrl.trim(),
        apiKey: apiKey || undefined,
        whatDoesItDo,
      });
      // Reset form + close
      setDisplayName('');
      setApiUrl('');
      setApiKey('');
      setWhatDoesItDo('fetch-information');
      setTestResult(null);
      setError(null);
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const claimedCategory = CATEGORY_OPTIONS.find((o) => o.value === whatDoesItDo)?.category;
  const mismatch = testResult?.detectedCategory && testResult.detectedCategory !== claimedCategory;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-2xl rounded-lg shadow-2xl"
        style={{ backgroundColor: 'var(--surface-dark)', border: '1px solid var(--border-subtle)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div>
            <h3 className="text-[14px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
              Add a custom API
            </h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted-silver)' }}>
              Paste the API URL, pick what it does, test it, and save. The system will slot it into the matching category.
            </p>
          </div>
          <button onClick={onClose} style={{ color: 'var(--muted-silver)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Display name */}
          <div>
            <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
              Display name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. My Custom News API"
              className="w-full mt-1 px-3 py-2 rounded text-[12px]"
              style={{
                backgroundColor: 'var(--surface-raised)',
                color: 'var(--bright-silver)',
                border: '1px solid var(--border-subtle)',
              }}
            />
          </div>

          {/* API URL */}
          <div>
            <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
              API URL
            </label>
            <input
              type="text"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="w-full mt-1 px-3 py-2 rounded text-[12px] font-mono"
              style={{
                backgroundColor: 'var(--surface-raised)',
                color: 'var(--bright-silver)',
                border: '1px solid var(--border-subtle)',
              }}
            />
            <p className="text-[10px] mt-1" style={{ color: 'var(--muted-silver)' }}>
              The base URL of the API. For LLMs, include the version path (e.g. /v1).
            </p>
          </div>

          {/* API key */}
          <div>
            <label className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
              API key <span style={{ color: 'var(--muted-silver)' }}>(optional — some APIs don't require one)</span>
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full mt-1 px-3 py-2 rounded text-[12px] font-mono"
              style={{
                backgroundColor: 'var(--surface-raised)',
                color: 'var(--bright-silver)',
                border: '1px solid var(--border-subtle)',
              }}
            />
          </div>

          {/* What does this API do? */}
          <div>
            <label className="text-[10px] uppercase tracking-wider block mb-2" style={{ color: 'var(--steel-silver)' }}>
              What does this API do?
            </label>
            <div className="grid grid-cols-1 gap-1.5">
              {CATEGORY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setWhatDoesItDo(opt.value)}
                  className="flex items-start gap-3 px-3 py-2 rounded-md text-left transition-colors"
                  style={{
                    backgroundColor: whatDoesItDo === opt.value ? 'rgba(238, 28, 28, 0.08)' : 'var(--surface-raised)',
                    border: `1px solid ${whatDoesItDo === opt.value ? 'rgba(238, 28, 28, 0.3)' : 'var(--border-subtle)'}`,
                  }}
                >
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0 mt-0.5"
                    style={{
                      backgroundColor: whatDoesItDo === opt.value ? 'var(--siren-red)' : 'transparent',
                      border: `1px solid ${whatDoesItDo === opt.value ? 'var(--siren-red)' : 'var(--muted-silver)'}`,
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium" style={{ color: 'var(--bright-silver)' }}>
                      {opt.label}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted-silver)' }}>
                      {opt.description}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Test result */}
          {testResult && (
            <div
              className="px-3 py-2 rounded text-[11px]"
              style={{
                backgroundColor: testResult.success ? 'rgba(34, 197, 94, 0.06)' : 'rgba(238, 28, 28, 0.06)',
                border: `1px solid ${testResult.success ? 'rgba(34, 197, 94, 0.3)' : 'rgba(238, 28, 28, 0.3)'}`,
                color: testResult.success ? '#22C55E' : 'var(--siren-red)',
              }}
            >
              {testResult.success ? (
                <>
                  <div className="flex items-center gap-1.5 mb-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <strong>API responded</strong> in {testResult.durationMs}ms
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--steel-silver)' }}>
                    Detected shape: <span style={{ color: 'var(--bright-silver)' }}>{testResult.detectedShape}</span>
                  </div>
                  {mismatch && (
                    <div className="flex items-start gap-1.5 mt-1.5 px-2 py-1 rounded" style={{ backgroundColor: 'rgba(245, 158, 11, 0.08)' }}>
                      <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: '#F59E0B' }} />
                      <span className="text-[10px]" style={{ color: '#F59E0B' }}>
                        You said <strong>{claimedCategory}</strong> but the response looks like <strong>{testResult.detectedCategory}</strong>. Saving will use the detected category.
                      </span>
                    </div>
                  )}
                  {testResult.sampleResponse && (
                    <details className="mt-2">
                      <summary className="text-[10px] cursor-pointer" style={{ color: 'var(--steel-silver)' }}>
                        View sample response
                      </summary>
                      <pre
                        className="mt-1 p-2 rounded text-[10px] overflow-auto max-h-32 font-mono"
                        style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--muted-silver)' }}
                      >
                        {testResult.sampleResponse}
                      </pre>
                    </details>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 mb-1">
                    <AlertTriangle className="w-3 h-3" />
                    <strong>Test failed</strong> — {testResult.error}
                  </div>
                  {testResult.suggestedAction && (
                    <div className="text-[10px] mt-1" style={{ color: 'var(--steel-silver)' }}>
                      {testResult.suggestedAction}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              className="px-3 py-2 rounded text-[11px]"
              style={{
                backgroundColor: 'rgba(238, 28, 28, 0.06)',
                border: '1px solid rgba(238, 28, 28, 0.3)',
                color: 'var(--siren-red)',
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <button
            onClick={handleTest}
            disabled={testing || !apiUrl.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            style={{
              backgroundColor: 'var(--surface-raised)',
              color: 'var(--bright-silver)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
            Test API
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-md text-[12px] font-medium transition-colors hover:bg-white/5"
              style={{ color: 'var(--steel-silver)' }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !displayName.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-md text-[12px] font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--siren-red)', color: 'white' }}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save API
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
