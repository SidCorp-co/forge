"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  danger?: boolean;
  /** Inert row — a state the menu is reporting, not a choice. Skipped by ↑/↓,
   *  but still focusable, because a menu whose every row is inert has nothing
   *  else to put focus on. */
  disabled?: boolean;
  /** Draw a rule above this item, separating it from the group before it. */
  separatorBefore?: boolean;
}

export interface MenuProps {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  /** Which side of the trigger the panel opens toward. Footer/bottom-anchored
   *  triggers use "top" so the menu rises instead of clipping off-screen. */
  side?: "top" | "bottom";
  /** Extra classes on the menu root (e.g. `w-full` for a block trigger). */
  className?: string;
  /** Extra classes on the trigger wrapper (e.g. `block w-full`). */
  triggerClassName?: string;
}

/** Generic dropdown menu (row actions, overflow ⋯). Keyboard: ↑/↓ move, Enter
    select, Esc close (returns focus to trigger). Closes on outside click. */
// cm:guard inertness is `aria-disabled` and NEVER the native `disabled` attribute — a natively disabled button cannot be focused, and every read of it here decides where focus goes
const isInert = (el: HTMLButtonElement) => el.getAttribute("aria-disabled") === "true";

export function Menu({
  trigger,
  items,
  align = "right",
  side = "bottom",
  className,
  triggerClassName,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // cm:guard focus MUST land inside the panel even when every row is inert — the panel is what carries `onKeyDown`, so a menu that leaves focus on the trigger cannot be closed with Escape and never announces the row it opened to report (ISS-982 narrowed the status menu to rungs that have no exits at all)
  useEffect(() => {
    if (!open) return;
    const rows = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    (rows.find((el) => !isInert(el)) ?? rows[0])?.focus();
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const close = (focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) (triggerRef.current?.firstElementChild as HTMLElement)?.focus?.();
  };

  // cm:guard Escape and Tab are handled BEFORE the arrow keys ask what is focusable — they must work on an all-inert menu, which is the one a reader is most likely to want out of
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const focusables = (itemRefs.current.filter(Boolean) as HTMLButtonElement[]).filter(
      (el) => !isInert(el),
    );
    if (focusables.length === 0) return;
    const idx = focusables.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusables[(idx + 1) % focusables.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusables[(idx - 1 + focusables.length) % focusables.length]?.focus();
    }
  };

  // cm:guard `trigger` must be an interactive element (button/IconButton): the span below carries the popup semantics only, and native Enter/Space activation bubbling to its onClick is what makes the menu keyboard-operable without a redundant tab stop (D1)
  return (
    <div ref={ref} className={cn("relative inline-flex", className)}>
      <span
        ref={triggerRef}
        className={triggerClassName}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger}
      </span>
      {open && (
        <div
          role="menu"
          onKeyDown={onKeyDown}
          className={cn(
            "forge-drop absolute z-50 min-w-[180px] overflow-hidden rounded-lg border border-line bg-surface p-1.5 shadow-lg",
            side === "top" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((it, i) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: a menu's items are positional and hold no state of their own — the list is rebuilt whole on every render and never reordered while open — and the index is what keeps two items legitimately sharing a label from colliding (ISS-982)
              key={`${i}-${it.label}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              aria-disabled={it.disabled}
              onClick={() => {
                if (it.disabled) return;
                it.onSelect?.();
                close();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] transition-colors focus-visible:outline-none",
                it.separatorBefore && "mt-1 border-line border-t pt-2.5",
                it.disabled
                  ? "cursor-default text-subtle focus-visible:bg-hover"
                  : "hover:bg-hover focus-visible:bg-hover",
                it.danger ? "text-[color:var(--red-600)]" : it.disabled ? "" : "text-fg",
              )}
            >
              {it.icon && <Icon name={it.icon} size={16} style={it.danger ? { color: "var(--red-500)" } : { color: "var(--fg-subtle)" }} />}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
