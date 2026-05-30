import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/** Mono uppercase overline used as a section kicker / eyebrow. */
export function Kicker({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("fg-overline", className)} {...props} />;
}
