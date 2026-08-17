// Phase 3 diagnostics host: responsive, read-only drawer/sheet shell using
// the project Sheet primitive to portal away from draggable avatar surfaces.
import type { AvatarDiagnosticsViewSnapshot } from '@/hooks/useAvatarDiagnosticsSnapshot';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { AvatarDiagnosticsPanel } from './AvatarDiagnosticsPanel';

export function AvatarDiagnosticsSheetHost({
  open,
  variant,
  snapshot,
  onOpenChange,
  onRefresh,
}: {
  open: boolean;
  variant: 'drawer' | 'sheet';
  snapshot: AvatarDiagnosticsViewSnapshot | null;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
}) {
  const isDrawer = variant === 'drawer';
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isDrawer ? 'right' : 'bottom'}
        className={isDrawer
          ? 'h-full w-full max-w-[420px] gap-0 p-0 sm:w-[400px]'
          : 'max-h-[80svh] w-full max-w-none gap-0 rounded-t-xl p-0 sm:max-h-[86svh] sm:max-w-[520px] sm:mx-auto'}
        aria-label="Avatar diagnostics"
      >
        <SheetTitle className="sr-only">Avatar diagnostics</SheetTitle>
        <AvatarDiagnosticsPanel snapshot={snapshot} onClose={() => onOpenChange(false)} onRefresh={onRefresh} showClose={false} />
      </SheetContent>
    </Sheet>
  );
}
