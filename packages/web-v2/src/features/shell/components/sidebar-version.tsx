"use client";

import { Icon, Tooltip } from "@/design";
import { ForgeVersion } from "@/features/version";
import { cn } from "@/lib/utils/cn";

export interface SidebarVersionProps {
  onDocs: () => void;
  activeKey: string;
  /** The 88px rail: smaller type, the pair centred. */
  compact?: boolean;
}

/** The version at the foot of the sidebar, with the Docs button after it. */
export function SidebarVersion({ onDocs, activeKey, compact = false }: SidebarVersionProps) {
  return (
    <div className={cn("flex min-w-0 items-center", compact ? "justify-center gap-0.5" : "gap-1")}>
      <ForgeVersion short={compact} className={cn("truncate", compact ? "text-9-5 leading-tight" : "fg-caption")} />
      <Tooltip label="Docs">
        <button
          type="button"
          onClick={onDocs}
          aria-label="Docs"
          aria-current={activeKey === "docs" ? "page" : undefined}
          className={cn(
            "inline-flex flex-none items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-fg max-md:size-11",
            compact ? "size-6" : "size-7",
            activeKey === "docs" ? "text-accent-text" : "text-subtle",
          )}
        >
          <Icon name="book" size={compact ? 13 : 15} />
        </button>
      </Tooltip>
    </div>
  );
}
