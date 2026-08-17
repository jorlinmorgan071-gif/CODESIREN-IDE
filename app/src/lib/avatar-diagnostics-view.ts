// Phase 3 diagnostics view model: derives read-only presentation severity from
// the existing AvatarCompatibilityDiagnostics contract only.
import type { AvatarCompatibilityDiagnostics } from './avatar-compatibility';

export type AvatarDiagnosticsSeverity = 'healthy' | 'notice' | 'attention' | 'error';

export const DIAGNOSTICS_SEVERITY_META: Record<AvatarDiagnosticsSeverity, { label: string; color: string; background: string }> = {
  healthy: { label: 'Healthy', color: '#86efac', background: 'rgba(34, 197, 94, 0.13)' },
  notice: { label: 'Notice', color: '#7dd3fc', background: 'rgba(56, 189, 248, 0.13)' },
  attention: { label: 'Attention', color: '#fcd34d', background: 'rgba(245, 158, 11, 0.13)' },
  error: { label: 'Error', color: '#fca5a5', background: 'rgba(239, 68, 68, 0.13)' },
};

export function classifyAvatarDiagnosticsSeverity(diagnostics: AvatarCompatibilityDiagnostics): AvatarDiagnosticsSeverity {
  if (diagnostics.profileSource === 'unknown-fallback') return 'attention';
  if (!diagnostics.humanoid && diagnostics.vrmaMappings.length > 0) return 'attention';
  if (diagnostics.expressionCount === 0) return 'attention';
  if (diagnostics.proceduralFallback && diagnostics.vrmaMappings.includes(diagnostics.currentMotionState)) return 'attention';
  if (
    diagnostics.profileSource === 'default-fallback'
    || !diagnostics.gaze
    || diagnostics.springBoneCount === 0
    || diagnostics.proceduralFallback
    || diagnostics.warnings.length > 0
  ) return 'notice';
  return 'healthy';
}

export function classifyAvatarDiagnosticWarning(
  diagnostics: AvatarCompatibilityDiagnostics,
  warning: string,
): AvatarDiagnosticsSeverity {
  if (diagnostics.profileSource === 'unknown-fallback') return 'attention';
  if (/humanoid rig is unavailable/i.test(warning) && diagnostics.vrmaMappings.length > 0) return 'attention';
  if (/expression manager is unavailable/i.test(warning)) return 'attention';
  return 'notice';
}

export function displayAvatarDiagnosticsUrl(url: string): string {
  if (url.startsWith('blob:')) return 'blob:… (session-only)';
  return url.length > 72 ? `${url.slice(0, 69)}…` : url;
}
