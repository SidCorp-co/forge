"use client";

import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface PinnedTab {
  id: string;
  label: string;
  icon: IconName;
  /** basePath-relative route + query (deep-link). */
  href: string;
}

export interface PinnedTabBarProps {
  tabs: PinnedTab[];
  /** Current `pathname + search` to highlight the active tab. */
  activeHref?: string;
  onSelect?: (href: string) => void;
  onRemove?: (id: string) => void;
}

/** Horizontal bar of pinned views (route + filter-state deep-links). Hidden
 *  when empty; horizontally scrollable on overflow. Presentational — the shell
 *  feeds it `usePinnedViews()` + a router push. */
export function PinnedTabBar({ tabs, activeHref, onSelect, onRemove }: PinnedTabBarProps) {
  if (tabs.length === 0) return null;
  return (
    <div className="flex flex-none items-center gap-1.5 overflow-x-auto border-b border-line bg-surface px-4 py-1.5">
      <Icon name="pin" size={13} className="flex-none text-subtle" />
      {tabs.map((t) => {
        // Exact deep-link match, or same route when the caller only knows the
        // current pathname (query not compared).
        const active = activeHref != null && (t.href === activeHref || t.href.split("?")[0] === activeHref);
        return (
          <div
            key={t.id}
            className={cn(
              "group inline-flex flex-none items-center gap-1.5 rounded-md border py-1 pl-2 pr-1 transition-colors",
              active
                ? "border-line-strong bg-accent-tint text-accent-text"
                : "border-line bg-surface text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect?.(t.href)}
              aria-current={active ? "page" : undefined}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold"
            >
              <Icon name={t.icon} size={13} style={active ? { color: "var(--accent)" } : undefined} />
              <span className="max-w-[160px] truncate">{t.label}</span>
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(t.id)}
                aria-label={`Unpin ${t.label}`}
                className="inline-flex size-4 items-center justify-center rounded-sm text-subtle transition-colors hover:bg-hover hover:text-fg"
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
