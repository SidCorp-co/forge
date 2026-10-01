"use client";

import { forwardRef } from "react";
import { Icon } from "@/design";

/** The notifications bell at the top of the sidebar, with the open count on it. */
export const SidebarBell = forwardRef<HTMLButtonElement, { count: number; onToggle: () => void }>(
  function SidebarBell({ count, onToggle }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        aria-label={count > 0 ? `Notifications, ${count} open` : "Notifications"}
        className="relative inline-flex size-8 flex-none items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg max-md:size-11"
      >
        <Icon name="bell" size={17} />
        {count > 0 && (
          <span
            className="absolute right-0.5 top-0.5 inline-flex min-w-[15px] items-center justify-center rounded-pill px-1 text-10 font-bold text-white"
            style={{ background: "var(--flame-500)" }}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
    );
  },
);
