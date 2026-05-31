"use client";

import { Icon } from "@/design/icons/icon";
import { Button } from "@/design/primitives/button";
import { Kbd } from "@/design/primitives/kbd";
import { SegmentedControl } from "@/design/primitives/segmented-control";
import { Tooltip } from "@/design/primitives/tooltip";
import { cn } from "@/lib/utils/cn";

export type TopBarDensity = "comfortable" | "compact";

export interface TopBarProps {
  title?: string;
  notificationCount?: number;
  onCommandPalette?: () => void;
  onNotifications?: () => void;
  onNewIssue?: () => void;
  /** Opens the mobile nav drawer. Renders a hamburger button below `md`. */
  onMenu?: () => void;
  /** Global display density. Renders a Comfortable/Compact toggle when set. */
  density?: TopBarDensity;
  onDensityChange?: (d: TopBarDensity) => void;
  /** When true the header shrinks (used for shrink-on-scroll). */
  scrolled?: boolean;
  /**
   * When set, renders a subtle "Back to classic" link to the v1 UI. This MUST
   * resolve as a raw `<a href>` (not `next/link`), because the app runs under
   * the `/v2` basePath and `next/link` would prefix it — turning `/` into
   * `/v2/`. A plain anchor to `"/"` escapes the basePath and lands on v1.
   */
  backToClassicHref?: string;
}

export function TopBar({
  title,
  notificationCount = 0,
  onCommandPalette,
  onNotifications,
  onNewIssue,
  onMenu,
  density,
  onDensityChange,
  scrolled = false,
  backToClassicHref,
}: TopBarProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex flex-none items-center gap-3 border-b border-line bg-surface px-5 transition-[height] duration-150",
        scrolled ? "h-11" : "h-14",
      )}
    >
      {onMenu && (
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open navigation"
          className="-ml-1 inline-flex size-11 flex-none items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg md:hidden"
        >
          <Icon name="menu" size={20} />
        </button>
      )}

      {title && <h1 className="fg-h3 mr-2">{title}</h1>}

      <button
        type="button"
        onClick={onCommandPalette}
        className="flex h-9 max-w-md flex-1 items-center gap-2.5 rounded-md border border-line-strong bg-surface px-3 text-subtle transition-colors hover:border-[color:var(--link)] hover:bg-hover"
      >
        <Icon name="search" size={16} />
        <span className="fg-body-sm flex-1 text-left">Search or jump to…</span>
        <Kbd>⌘K</Kbd>
      </button>

      <div className="ml-auto flex items-center gap-2">
        {density && onDensityChange && (
          <Tooltip label="Display density" side="bottom">
            <SegmentedControl<TopBarDensity>
              value={density}
              onChange={onDensityChange}
              options={[
                { value: "comfortable", icon: "rows" },
                { value: "compact", icon: "list" },
              ]}
            />
          </Tooltip>
        )}
        {backToClassicHref && (
          // Raw anchor (NOT next/link) — must escape the /v2 basePath to reach v1.
          <a
            href={backToClassicHref}
            className="fg-body-sm inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <Icon name="arrowRight" size={15} className="rotate-180" />
            Back to classic
          </a>
        )}
        <button
          type="button"
          onClick={onNotifications}
          className="relative inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
          aria-label="Notifications"
        >
          <Icon name="bell" size={18} />
          {notificationCount > 0 && (
            <span
              className="absolute right-1.5 top-1.5 inline-flex min-w-[15px] items-center justify-center rounded-pill px-1 text-[10px] font-bold text-white"
              style={{ background: "var(--flame-500)" }}
            >
              {notificationCount}
            </span>
          )}
        </button>
        <Button variant="primary" size="sm" icon="plus" onClick={onNewIssue}>
          New issue
        </Button>
      </div>
    </header>
  );
}
