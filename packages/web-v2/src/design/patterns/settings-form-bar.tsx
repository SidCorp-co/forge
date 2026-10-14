import type { ReactNode } from "react";
import { Button } from "@/design/primitives/button";

export interface SettingsFormBarProps {
  dirty: boolean;
  saving?: boolean;
  /** Why Save cannot be pressed yet, where something besides "nothing changed" is the reason. */
  blockedBy?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  /** Notices about the last save, shown above the bar's own line. */
  children?: ReactNode;
}

/** The one save bar of a page: flush at the foot, a hairline above it and no card around it. */
export function SettingsFormBar({
  dirty,
  saving = false,
  blockedBy = null,
  onSave,
  onDiscard,
  children,
}: SettingsFormBarProps) {
  return (
    <div className="sticky bottom-0 z-10 mt-8 border-t border-line bg-app py-3">
      {children && <div className="mb-3 max-h-[40dvh] space-y-3 overflow-y-auto">{children}</div>}
      <div className="flex flex-wrap items-center gap-3">
        <p className="fg-body-sm min-w-0 flex-1 text-muted" aria-live="polite">
          {blockedBy ?? (dirty ? "You have unsaved changes." : "No unsaved changes.")}
        </p>
        {dirty && (
          <Button variant="ghost" onClick={onDiscard} disabled={saving} className="min-h-11">
            Discard
          </Button>
        )}
        <Button
          variant="primary"
          loading={saving}
          disabled={!dirty || blockedBy !== null}
          onClick={onSave}
          className="min-h-11"
        >
          Save
        </Button>
      </div>
    </div>
  );
}
