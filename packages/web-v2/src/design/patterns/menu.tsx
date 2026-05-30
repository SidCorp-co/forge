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
}

/** Generic dropdown menu (row actions, overflow ⋯). Keyboard: ↑/↓ move, Enter
    select, Esc close (returns focus to trigger). Closes on outside click. */
export function Menu({ trigger, items, align = "right" }: MenuProps) {
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
    <div ref={ref} className="relative inline-flex">
      <span ref={triggerRef} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </span>
      {open && (
        <div
          role="menu"
          onKeyDown={onKeyDown}
          className={cn(
            "forge-drop absolute top-[calc(100%+6px)] z-50 min-w-[180px] overflow-hidden rounded-lg border border-line bg-surface p-1.5 shadow-lg",
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
