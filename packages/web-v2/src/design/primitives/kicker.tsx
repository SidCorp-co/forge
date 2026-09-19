import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

export function Kicker({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("fg-overline", className)} {...props} />;
}
