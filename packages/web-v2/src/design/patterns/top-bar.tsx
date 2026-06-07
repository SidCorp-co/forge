"use client";

import { Icon } from "@/design/icons/icon";
import { Breadcrumb, type Crumb } from "@/design/primitives/breadcrumb";
import { Button } from "@/design/primitives/button";
import { Kbd } from "@/design/primitives/kbd";
import { SegmentedControl } from "@/design/primitives/segmented-control";
import { Tooltip } from "@/design/primitives/tooltip";
import { cn } from "@/lib/utils/cn";

export type TopBarDensity = "comfortable" | "compact";

export interface TopBarProps {
  title?: string;
  /**
   * Breadcrumb trail (workspace → project → page). When set it renders in the
   * left slot in place of `title`; the last crumb is the current page. Falls
   * back to `title` when empty/unset so older callers keep working.
   */
  breadcrumb?: Crumb[];
  /** Client-side navigation for breadcrumb links (router.push). */
  onBreadcrumbNavigate?: (href: string) => void;
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
}

export function TopBar({
  title,
  breadcrumb,
  onBreadcrumbNavigate,
  notificationCount = 0,
  onCommandPalette,
  onNotifications,
  onNewIssue,
  onMenu,
  density,
  onDensityChange,
  scrolled = false,
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

      {breadcrumb && breadcrumb.length > 0 ? (
        <div className="mr-2 min-w-0 truncate">
          <Breadcrumb items={breadcrumb} onNavigate={onBreadcrumbNavigate} />
        </div>
      ) : (
        title && <h1 className="fg-h3 mr-2 truncate">{title}</h1>
      )}

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onCommandPalette}
          className="hidden h-9 w-[280px] items-center gap-2.5 rounded-md border border-line-strong bg-surface px-3 text-subtle transition-colors hover:border-[color:var(--link)] hover:bg-hover sm:flex"
        >
          <Icon name="search" size={16} />
          <span className="fg-body-sm flex-1 truncate text-left">Search issues, runs…</span>
          <Kbd>⌘K</Kbd>
        </button>
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
        {/* Icon-only below sm so the header doesn't wrap at 375px (ISS-308 C2). */}
        <Button variant="primary" size="sm" icon="plus" onClick={onNewIssue} aria-label="New issue">
          <span className="hidden sm:inline">New issue</span>
        </Button>
      </div>
    </header>
  );
}
