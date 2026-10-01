"use client";

import { forwardRef } from "react";
import { Icon } from "@/design";
import { cn } from "@/lib/utils/cn";

export const SidebarBell = forwardRef<
  HTMLButtonElement,
  { count: number; onToggle: () => void; withLabel?: boolean }
>(function SidebarBell({ count, onToggle, withLabel = false }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-label={count > 0 ? `Notifications, ${count} open` : "Notifications"}
      className={cn(
        "relative inline-flex items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg max-md:min-h-[44px]",
        withLabel ? "w-full gap-2.5 px-2.5 py-2 text-13-5 font-semibold" : "size-8 justify-center",
      )}
    >
      <Icon name="bell" size={17} />
      {withLabel && <span className="flex-1 text-left">Notifications</span>}
      {count > 0 && (
        <span
          className={cn(
            "inline-flex min-w-[15px] items-center justify-center rounded-pill px-1 text-10 font-bold text-white",
            withLabel ? "" : "absolute right-0.5 top-0.5",
          )}
          style={{ background: "var(--flame-500)" }}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
});
