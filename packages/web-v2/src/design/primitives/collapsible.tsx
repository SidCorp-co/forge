"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/design/icons/icon";

export interface CollapsibleProps {
  title: ReactNode;
  /** How many the fold holds, read beside its title while it is shut. */
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}

/** Disclosure — e.g. the collapsible agent plan on an issue. Its content mounts only once opened. */
export function Collapsible({ title, count, children, defaultOpen = false }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-y border-line-subtle">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 py-3 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <Icon
          name="chevronRight"
          size={16}
          className="text-subtle transition-transform duration-[150ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <span className="fg-label flex-1">
          {title}
          {count !== undefined ? <span className="ml-1.5 text-12 font-medium text-muted">{count}</span> : null}
        </span>
      </button>
      {open && <div className="forge-fade border-t border-line-subtle py-3">{children}</div>}
    </div>
  );
}
