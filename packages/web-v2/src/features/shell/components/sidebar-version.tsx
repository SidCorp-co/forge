"use client";

import { Icon, Tooltip } from "@/design";
import { ForgeVersion } from "@/features/version";
import { cn } from "@/lib/utils/cn";

export interface SidebarVersionProps {
  onWhatsNew: () => void;
  onDocs: () => void;
  /** A release the reader has not opened What's New for since it landed. */
  unseen: boolean;
  activeKey: string;
  /** The 88px rail: smaller type, the pair centred. */
  compact?: boolean;
}

/** The version at the foot of the sidebar: the link to What's New, with the Docs button after it. */
export function SidebarVersion({ onWhatsNew, onDocs, unseen, activeKey, compact = false }: SidebarVersionProps) {
  return (
    <div className={cn("flex min-w-0 items-center", compact ? "justify-center gap-0.5" : "gap-1")}>
      <button
        type="button"
        onClick={onWhatsNew}
        aria-current={activeKey === "whats-new" ? "page" : undefined}
        className={cn(
          "relative inline-flex min-w-0 items-center gap-1.5 rounded-sm text-left transition-colors hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:min-h-[44px]",
          activeKey === "whats-new" && "[&>span]:text-accent-text",
        )}
      >
        <ForgeVersion short={compact} className={cn("truncate", compact ? "text-9-5 leading-tight" : "fg-caption")} />
        <span className="sr-only">, What&apos;s New{unseen ? ", new updates" : ""}</span>
        {unseen && (
          <span
            aria-hidden
            data-testid="whats-new-dot"
            className="size-1.5 flex-none rounded-pill"
            style={{ background: "var(--accent)" }}
          />
        )}
      </button>
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
