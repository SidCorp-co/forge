import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

export function rampOr(step: string, className?: string) {
  return /\bfg-h[1-4]\b/.test(className ?? "") ? className : cn(step, className);
}

export function PageTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className={rampOr("fg-h1", className)} {...props} />;
}

/** A section heading under the page title — an h2, one step below it. */
export function SectionTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={rampOr("fg-h2", className)} {...props} />;
}
