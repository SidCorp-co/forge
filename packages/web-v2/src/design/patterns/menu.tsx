"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";
import { Popover, type PopoverPlacement } from "@/design/primitives/popover";

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
  /** The side of the trigger the panel prefers; it opens on the other side
   *  when this one lacks the room. */
  side?: "top" | "bottom";
  /** Extra classes on the menu root (e.g. `w-full` for a block trigger). */
  className?: string;
  /** Extra classes on the trigger wrapper (e.g. `block w-full`). */
  triggerClassName?: string;
}

/** Generic dropdown menu (row actions, overflow ⋯). Keyboard: ↑/↓ move, Enter
    select, Esc close (returns focus to trigger), Tab closes and moves on from
    the trigger. Closes on outside click. The panel is placed by Popover:
    flipped, capped to the room it has and scrolled inside, never clipped. */
const isInert = (el: HTMLButtonElement) => el.getAttribute("aria-disabled") === "true";

function placementOf(side: "top" | "bottom", align: "left" | "right"): PopoverPlacement {
  return `${side}-${align === "right" ? "end" : "start"}`;
}

export function Menu({
  trigger,
  items,
  align = "right",
  side = "bottom",
  className,
  triggerClassName,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // The panel mounts through a portal a render after `open` flips, so focus
  // waits for the node rather than for the flag.
  useEffect(() => {
    if (!open || !panel) return;
    const rows = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    (rows.find((el) => !isInert(el)) ?? rows[0])?.focus({ preventScroll: true });
  }, [open, panel]);

  const close = (focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) (triggerRef.current?.firstElementChild as HTMLElement)?.focus?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") {
      // The panel sits at the end of <body>, so the browser's own Tab would
      // leave from there. Focus goes back to the trigger first and the default
      // action then moves on from it, as it did when the panel was inline.
      close();
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
      <Popover
        open={open}
        anchor={ref}
        onDismiss={() => setOpen(false)}
        placement={placementOf(side, align)}
        lockScroll
        panelRef={setPanel}
        role="menu"
        onKeyDown={onKeyDown}
        className="forge-drop min-w-[180px] overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-lg"
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
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-13-5 transition-colors focus-visible:outline-none",
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
      </Popover>
    </div>
  );
}
