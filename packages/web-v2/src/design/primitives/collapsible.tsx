"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/design/icons/icon";

export interface CollapsibleProps {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** No box: the disclosure sits flush on the page, so the page's own hairlines rule a stack of them. */
  flat?: boolean;
}

/** Disclosure — e.g. the collapsible agent plan on an issue. */
export function Collapsible({ title, children, defaultOpen = false, flat = false }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={flat ? undefined : "rounded-md border border-line bg-surface"}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          flat
            ? "flex w-full items-center gap-2 py-3 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            : "flex w-full items-center gap-2 rounded-md px-4 py-3 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        }
      >
        <Icon
          name="chevronRight"
          size={16}
          className="text-subtle transition-transform duration-[150ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <span className="fg-label flex-1">{title}</span>
      </button>
      {open && (
        <div className={flat ? "forge-fade pb-3" : "forge-fade border-t border-line-subtle px-4 py-3"}>{children}</div>
      )}
    </div>
  );
}
