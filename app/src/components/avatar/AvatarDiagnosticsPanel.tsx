// Phase 3 diagnostics presentation: a read-only renderer for the existing
// AvatarCompatibilityDiagnostics contract, with no compatibility mutation.
import { useMemo, useState } from 'react';
import { Check, ChevronDown, Clipboard, Info, RefreshCw, TriangleAlert, X } from 'lucide-react';
import type { SemanticExpression } from '@/lib/avatar-compatibility';
import type { AvatarDiagnosticsViewSnapshot } from '@/hooks/useAvatarDiagnosticsSnapshot';
import {
  classifyAvatarDiagnosticWarning,
  classifyAvatarDiagnosticsSeverity,
  DIAGNOSTICS_SEVERITY_META,
  displayAvatarDiagnosticsUrl,
  type AvatarDiagnosticsSeverity,
} from '@/lib/avatar-diagnostics-view';

const FACE_EXPRESSIONS: readonly SemanticExpression[] = ['blink', 'happy', 'sad', 'angry', 'surprised', 'relaxed', 'neutral'];
const MOUTH_EXPRESSIONS: readonly SemanticExpression[] = ['mouthA', 'mouthI', 'mouthU', 'mouthE', 'mouthO'];

function Section({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--steel-silver)' }}>{title}</span>
        <ChevronDown className="w-4 h-4 transition-transform" style={{ color: 'var(--muted-silver)', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

function SeverityBadge({ severity }: { severity: AvatarDiagnosticsSeverity }) {
  const meta = DIAGNOSTICS_SEVERITY_META[severity];
  return <span className="rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: meta.color, backgroundColor: meta.background }}>{meta.label}</span>;
}

function Capability({ label, value, positive = true }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="rounded-md px-2.5 py-2" style={{ backgroundColor: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--muted-silver)' }}>{label}</div>
      <div className="mt-1 text-[11px] font-medium" style={{ color: positive ? '#bbf7d0' : 'var(--steel-silver)' }}>{value}</div>
    </div>
  );
}

export function AvatarDiagnosticsPanel({
  snapshot,
  onClose,
  onRefresh,
  showClose = true,
}: {
  snapshot: AvatarDiagnosticsViewSnapshot | null;
  onClose: () => void;
  onRefresh: () => void;
  showClose?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const diagnostics = snapshot?.diagnostics;
  const severity = useMemo(() => diagnostics ? classifyAvatarDiagnosticsSeverity(diagnostics) : 'notice', [diagnostics]);

  const copyRawDiagnostics = async () => {
    if (!diagnostics || !navigator.clipboard) return;
    await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  if (!diagnostics || !snapshot) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-center text-[12px]" style={{ color: 'var(--steel-silver)' }}>
        Capturing the current avatar runtime snapshot…
      </div>
    );
  }

  const warningDefaultOpen = diagnostics.warnings.length > 0;
  const contextLabel = snapshot.context === 'face' ? 'Face View' : snapshot.context === 'pip' ? 'Avatar PIP' : 'Interaction Bubble';
  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#0b0b12', color: 'var(--bright-silver)' }}>
      <header className="shrink-0 px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'rgba(14,14,20,0.98)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--muted-silver)' }}>{contextLabel} · Runtime snapshot</div>
            <div className="mt-1 flex items-center gap-2"><span className="text-[15px] font-semibold">{diagnostics.resolvedProfileId}</span><SeverityBadge severity={severity} /></div>
            <div className="mt-1 text-[10px]" style={{ color: 'var(--muted-silver)' }}>Captured {new Date(snapshot.capturedAtMs).toLocaleTimeString()}</div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={onRefresh} aria-label="Refresh diagnostics" title="Refresh diagnostics" className="rounded p-1.5 hover:bg-white/10"><RefreshCw className="w-4 h-4" /></button>
            <button type="button" onClick={() => void copyRawDiagnostics()} aria-label="Copy raw diagnostics JSON" title="Copy raw diagnostics JSON" className="rounded p-1.5 hover:bg-white/10"><Clipboard className="w-4 h-4" /></button>
            {showClose && <button type="button" onClick={onClose} aria-label="Close diagnostics" title="Close diagnostics" className="rounded p-1.5 hover:bg-white/10"><X className="w-4 h-4" /></button>}
          </div>
        </div>
        {copied && <div className="mt-2 text-[10px]" style={{ color: '#86efac' }}>Copied raw runtime contract.</div>}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Profile resolution" defaultOpen={diagnostics.profileSource !== 'exact'}>
          <dl className="space-y-2 text-[11px]">
            <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted-silver)' }}>Source</dt><dd>{diagnostics.profileSource}</dd></div>
            <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted-silver)' }}>Requested model</dt><dd className="text-right">{diagnostics.requestedModelId ?? 'Unidentified session URL'}</dd></div>
            <div><dt style={{ color: 'var(--muted-silver)' }}>Avatar URL</dt><dd className="mt-1 break-all" title={diagnostics.avatarUrl}>{displayAvatarDiagnosticsUrl(diagnostics.avatarUrl)}</dd></div>
            <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted-silver)' }}>VRM version</dt><dd>{diagnostics.vrmVersion}</dd></div>
          </dl>
        </Section>

        <Section title="Runtime capabilities" defaultOpen>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Capability label="Humanoid" value={diagnostics.humanoid ? 'Available' : 'Unavailable'} positive={diagnostics.humanoid} />
            <Capability label="Expressions" value={`${diagnostics.expressionCount} exposed`} positive={diagnostics.expressionCount > 0} />
            <Capability label="Gaze" value={diagnostics.gaze ? 'Available' : 'Unavailable'} positive={diagnostics.gaze} />
            <Capability label="Spring bones" value={`${diagnostics.springBoneCount} joints`} positive={diagnostics.springBoneCount > 0} />
            <Capability label="Colliders" value={`${diagnostics.colliderCount} found`} />
            <Capability label="VRMA" value={diagnostics.vrmaCompatible ? 'Compatible' : 'Fallback only'} positive={diagnostics.vrmaCompatible} />
          </div>
        </Section>

        <Section title="Expression mapping">
          <div className="space-y-3">
            <ExpressionGroup title="Face and emotion" expressions={FACE_EXPRESSIONS} aliases={diagnostics.expressionAliases} />
            <ExpressionGroup title="Mouth and visemes" expressions={MOUTH_EXPRESSIONS} aliases={diagnostics.expressionAliases} />
          </div>
        </Section>

        <Section title="Motion and VRMA" defaultOpen={diagnostics.vrmaMappings.length > 0 || diagnostics.proceduralFallback}>
          <dl className="space-y-2 text-[11px]">
            <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted-silver)' }}>Motion state</dt><dd>{diagnostics.currentMotionState}</dd></div>
            <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted-silver)' }}>Active animation</dt><dd>{diagnostics.activeAnimation ?? 'Procedural'}</dd></div>
            <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted-silver)' }}>Procedural fallback</dt><dd>{diagnostics.proceduralFallback ? 'Active' : 'Inactive'}</dd></div>
            <div><dt style={{ color: 'var(--muted-silver)' }}>Session-only mappings</dt><dd className="mt-1 flex flex-wrap gap-1">{diagnostics.vrmaMappings.length ? diagnostics.vrmaMappings.map((state) => <span key={state} className="rounded px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: 'rgba(67,56,202,0.22)', color: '#c4b5fd' }}>{state}</span>) : <span>None</span>}</dd></div>
          </dl>
        </Section>

        <Section title="Compatibility notices" defaultOpen={warningDefaultOpen}>
          {diagnostics.warnings.length === 0 ? <div className="flex items-center gap-2 text-[11px]" style={{ color: '#86efac' }}><Check className="w-4 h-4" />No compatibility notices.</div> : (
            <div className="space-y-2">{diagnostics.warnings.map((warning) => {
              const warningSeverity = classifyAvatarDiagnosticWarning(diagnostics, warning);
              const meta = DIAGNOSTICS_SEVERITY_META[warningSeverity];
              return <div key={warning} className="flex gap-2 rounded-md p-2 text-[11px]" style={{ backgroundColor: meta.background, color: meta.color }}><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{warning}</div>;
            })}</div>
          )}
        </Section>
      </div>
      <footer className="shrink-0 px-4 py-2 text-[10px]" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', color: 'var(--muted-silver)' }}><Info className="mr-1 inline h-3 w-3" />Read-only runtime information; no avatar settings are changed here.</footer>
    </div>
  );
}

function ExpressionGroup({ title, expressions, aliases }: { title: string; expressions: readonly SemanticExpression[]; aliases: Readonly<Partial<Record<SemanticExpression, string>>> }) {
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-wide" style={{ color: 'var(--muted-silver)' }}>{title}</div>
      <div className="space-y-1">{expressions.map((semantic) => {
        const alias = aliases[semantic];
        return <div key={semantic} className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-[11px]" style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}><span>{semantic}</span><span style={{ color: alias ? '#bbf7d0' : 'var(--muted-silver)' }}>{alias ?? 'Not exposed by model'}</span></div>;
      })}</div>
    </div>
  );
}
