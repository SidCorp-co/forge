"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/design/icons/icon";

export interface CollapsibleProps {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}

/** Disclosure — e.g. the collapsible agent plan on an issue. */
export function Collapsible({ title, children, defaultOpen = false }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left focus-visible:outline-none"
      >
        <Icon
          name="chevronRight"
          size={16}
          className="text-subtle transition-transform duration-[150ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <span className="fg-label flex-1">{title}</span>
      </button>
      {open && <div className="forge-fade border-t border-line-subtle px-4 py-3">{children}</div>}
    </div>
  );
}
