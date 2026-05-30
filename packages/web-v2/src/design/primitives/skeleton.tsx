import type { CSSProperties } from "react";
import { cn } from "@/lib/utils/cn";

export interface SkeletonProps {
  variant?: "rect" | "text" | "circle";
  className?: string;
  style?: CSSProperties;
}

/** Cold-load placeholder with a warm paper shimmer. Compose these to mirror
    the real layout (see design/skeletons/*) rather than spinning a whole page. */
export function Skeleton({ variant = "rect", className, style }: SkeletonProps) {
  const shape =
    variant === "circle" ? "rounded-pill" : variant === "text" ? "rounded-sm" : "rounded-md";
  return (
    <span
      aria-hidden
      className={cn("skeleton block", shape, variant === "text" && "h-3", className)}
      style={style}
    />
  );
}
