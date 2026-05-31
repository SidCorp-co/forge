"use client";

import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface BottomTabItem {
  key: string;
  label: string;
  icon: IconName;
  /** Optional count pill (e.g. Attention). Falsy / 0 hides it. */
  badge?: number;
}

export interface BottomTabBarProps {
  items: BottomTabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
}

/**
 * Mobile bottom navigation (≤5 destinations). Render only `<md` (the desktop
 * rail handles ≥md). Fixed to the bottom edge with a safe-area inset so it
 * clears the home indicator; each target is ≥44px tall for touch. Active state
 * is icon-tint + accent label + a top indicator bar — not color alone.
 */
export function BottomTabBar({ items, activeKey, onSelect }: BottomTabBarProps) {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {items.map((it) => {
        const active = it.key === activeKey;
        const count = it.badge && it.badge > 0 ? it.badge : 0;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
            aria-current={active ? "page" : undefined}
            aria-label={count > 0 ? `${it.label}, ${count} need attention` : it.label}
            className={cn(
              "relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
              active ? "text-accent-text" : "text-muted hover:text-fg",
            )}
          >
            <span className="relative inline-flex">
              <Icon name={it.icon} size={20} style={active ? { color: "var(--accent)" } : undefined} />
              {count > 0 && (
                <span
                  className="absolute -right-2.5 -top-1.5 inline-flex min-w-[15px] items-center justify-center rounded-pill px-1 font-semibold"
                  style={{ fontSize: 9.5, lineHeight: "14px", color: "var(--flame-700)", background: "var(--flame-50)" }}
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </span>
            {it.label}
            {active && <span className="absolute inset-x-5 top-0 h-0.5 rounded-pill bg-accent" />}
          </button>
        );
      })}
    </nav>
  );
}
