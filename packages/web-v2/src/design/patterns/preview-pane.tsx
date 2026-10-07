"use client";

// The collapsible "Preview" disclosure, lifted out of the knowledge rules tab
// so the body composer draws the same one rather than a second pane that
// drifts from it (ISS-967). Content is the caller's: the rules tab renders
// markdown, the composer renders what the kernel would store.

import type { ReactNode } from "react";
import { Button } from "@/design/primitives/button";
import { Icon } from "@/design/icons/icon";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";

export interface PreviewPaneProps {
  children: ReactNode;
  label?: string;
  open: boolean;
  onToggle: () => void;
  /** Drawn above the content — a refusal message, a warning count, a spinner. */
  status?: ReactNode;
  className?: string;
}

export function PreviewPane({
  children,
  label,
  open,
  onToggle,
  status,
  className,
}: PreviewPaneProps) {
  const t = useCopy();
  return (
    <div className={className}>
      <Button variant="ghost" size="sm" onClick={onToggle} aria-expanded={open}>
        <Icon
          name="chevronRight"
          size={12}
          className="mr-1 shrink-0 transition-transform duration-[150ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        {label ?? t("common.preview")}
      </Button>
      {open && (
        <div className={cn("mt-2 overflow-x-auto rounded-md border border-line bg-sunken p-3")}>
          {status}
          {children}
        </div>
      )}
    </div>
  );
}
