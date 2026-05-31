"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  danger?: boolean;
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

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    const focusables = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    const idx = focusables.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusables[(idx + 1) % focusables.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusables[(idx - 1 + focusables.length) % focusables.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <div ref={ref} className={cn("relative inline-flex", className)}>
      {/* The wrapper carries the popup semantics; callers pass an interactive
          element (button/IconButton) as `trigger`, so native Enter/Space
          activation bubbles to this onClick — keyboard-operable without a
          redundant tab stop. aria-haspopup/expanded announce the menu (D1). */}
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
              key={it.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role="menuitem"
              onClick={() => {
                it.onSelect?.();
                close();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none",
                it.danger ? "text-[color:var(--red-600)]" : "text-fg",
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
