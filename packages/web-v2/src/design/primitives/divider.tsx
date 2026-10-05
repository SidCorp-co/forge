import { cn } from "@/lib/utils/cn";

export interface DividerProps {
  orientation?: "horizontal" | "vertical";
  className?: string;
}

export function Divider({ orientation = "horizontal", className }: DividerProps) {
  return (
    <hr
      aria-orientation={orientation}
      className={cn(
        "block border-0 bg-[var(--border-subtle)]",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
    />
  );
}
