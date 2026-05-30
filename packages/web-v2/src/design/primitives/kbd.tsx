import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/** A keycap — single source of truth for ⌘K / esc / shortcut hints. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center rounded-sm border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted",
        className,
      )}
      {...props}
    />
  );
}
